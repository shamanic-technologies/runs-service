import { Router } from "express";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import {
  costLifecycleEvents,
  runEvents,
  runLifecycleEvents,
  runs,
  runsCosts,
} from "../db/schema.js";
import { requireInternalAuth } from "../middleware/auth.js";
import {
  DeleteRunsByOrgParamsSchema,
  TransferBrandRequestSchema,
  RunsExpectedTotalsQuerySchema,
  OrgUsageTotalQuerySchema,
} from "../schemas.js";

const router = Router();

// DELETE /internal/runs/by-org/:orgId — org cascade-teardown leg.
// Bronze is the source of truth; deleting only silver projections would leave
// enough source data to resurrect billable org state during future projection.
router.delete("/internal/runs/by-org/:orgId", requireInternalAuth, async (req, res) => {
  try {
    const parsed = DeleteRunsByOrgParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { orgId } = parsed.data;

    const deleted = await db.transaction(async (tx) => {
      const runRows = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.organizationId, orgId));
      const runIds = runRows.map((row) => row.id);

      const runLifecycleWhere =
        runIds.length > 0
          ? or(
              inArray(runLifecycleEvents.runId, runIds),
              sql`${runLifecycleEvents.identity}->>'orgId' = ${orgId}`,
              sql`${runLifecycleEvents.payload}->>'organizationId' = ${orgId}`
            )
          : or(
              sql`${runLifecycleEvents.identity}->>'orgId' = ${orgId}`,
              sql`${runLifecycleEvents.payload}->>'organizationId' = ${orgId}`
            );

      const costLifecycleWhere =
        runIds.length > 0
          ? or(
              inArray(costLifecycleEvents.runId, runIds),
              sql`${costLifecycleEvents.identity}->>'orgId' = ${orgId}`
            )
          : sql`${costLifecycleEvents.identity}->>'orgId' = ${orgId}`;

      const deletedCostLifecycleEvents = await tx
        .delete(costLifecycleEvents)
        .where(costLifecycleWhere)
        .returning({ id: costLifecycleEvents.id });

      const deletedRunLifecycleEvents = await tx
        .delete(runLifecycleEvents)
        .where(runLifecycleWhere)
        .returning({ id: runLifecycleEvents.id });

      if (runIds.length === 0) {
        return {
          runs: 0,
          costs: 0,
          runEvents: 0,
          runLifecycleEvents: deletedRunLifecycleEvents.length,
          costLifecycleEvents: deletedCostLifecycleEvents.length,
        };
      }

      const deletedRunEvents = await tx
        .delete(runEvents)
        .where(inArray(runEvents.runId, runIds))
        .returning({ id: runEvents.id });

      const deletedCosts = await tx
        .delete(runsCosts)
        .where(inArray(runsCosts.runId, runIds))
        .returning({ id: runsCosts.id });

      const deletedRuns = await tx
        .delete(runs)
        .where(inArray(runs.id, runIds))
        .returning({ id: runs.id });

      return {
        runs: deletedRuns.length,
        costs: deletedCosts.length,
        runEvents: deletedRunEvents.length,
        runLifecycleEvents: deletedRunLifecycleEvents.length,
        costLifecycleEvents: deletedCostLifecycleEvents.length,
      };
    });

    res.json({ orgId, deleted });
  } catch (err) {
    console.error("[runs-service] Error in DELETE /internal/runs/by-org/:orgId:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /internal/transfer-brand — re-assign solo-brand runs to a different org.
// Unchanged from prior PR — silver-table direct mutation is the audit gap that
// Phase 5 doctrine WOULD ideally close (transfer-brand should also emit a
// `run.org_transferred` domain event), tracked as a follow-up.
router.post("/internal/transfer-brand", requireInternalAuth, async (req, res) => {
  try {
    const parsed = TransferBrandRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

    const step1 = await db
      .update(runs)
      .set({ organizationId: targetOrgId, updatedAt: new Date() })
      .where(
        and(
          eq(runs.organizationId, sourceOrgId),
          sql`array_length(${runs.brandIds}, 1) = 1`,
          sql`${runs.brandIds}[1] = ${sourceBrandId}`
        )
      )
      .returning({ id: runs.id });

    let rewriteCount = 0;
    if (targetBrandId) {
      const step2 = await db
        .update(runs)
        .set({ brandIds: sql`ARRAY[${targetBrandId}]::text[]`, updatedAt: new Date() })
        .where(
          and(
            sql`array_length(${runs.brandIds}, 1) = 1`,
            sql`${runs.brandIds}[1] = ${sourceBrandId}`
          )
        )
        .returning({ id: runs.id });
      rewriteCount = step2.length;
    }

    const totalUpdated = Math.max(step1.length, rewriteCount);
    console.log(`[runs-service] transfer-brand: moved ${step1.length} runs from org ${sourceOrgId} to ${targetOrgId} for brand ${sourceBrandId}${targetBrandId ? `, rewrote ${rewriteCount} brand refs → ${targetBrandId}` : ""}`);

    res.json({ updatedTables: [{ tableName: "runs", count: totalUpdated }] });
  } catch (err) {
    console.error("[runs-service] Error in POST /internal/transfer-brand:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Phase 4 — GET /internal/runs-expected-totals uses is_platform_committed generated column.
// Inline literal `cost_source='platform' AND status='actual'` replaced with schema-level
// predicate definition. New status enum value → ONE column-def change propagates.
router.get("/internal/runs-expected-totals", requireInternalAuth, async (req, res) => {
  const parsed = RunsExpectedTotalsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const { org_id } = parsed.data;

  const result = await db.execute(sql`
    WITH per_run AS (
      SELECT r.id AS run_id,
             SUM(rc.total_cost_in_usd_cents) AS sum_cents
        FROM runs r
        JOIN runs_costs rc ON rc.run_id = r.id
       WHERE r.organization_id = ${org_id}
         AND r.status IN ('completed', 'failed')
         AND rc.is_platform_committed
       GROUP BY r.id
      HAVING SUM(rc.total_cost_in_usd_cents) > 0
    )
    SELECT
      COALESCE((SELECT SUM(sum_cents)::text FROM per_run), '0') AS total_expected_cents,
      COALESCE(
        (SELECT json_agg(json_build_object('run_id', run_id, 'expected_cents', sum_cents::text) ORDER BY run_id) FROM per_run),
        '[]'::json
      ) AS runs
  `);

  const row = (result as any[])[0];
  const response = {
    total_expected_cents: row.total_expected_cents as string,
    runs: row.runs as { run_id: string; expected_cents: string }[],
  };

  console.log(
    `[runs-service] runs-expected-totals: org=${org_id} count=${response.runs.length} total=$${response.total_expected_cents}`
  );

  res.json(response);
});

// Phase 4 — GET /internal/org-usage-total reads from v_org_platform_spend.
// Single source of truth for the platform-projected predicate.
router.get("/internal/org-usage-total", requireInternalAuth, async (req, res) => {
  const parsed = OrgUsageTotalQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const { org_id } = parsed.data;

  // Inline aggregate using is_platform_projected generated col + partial index.
  // Gold view removed (filter pushdown through GROUP BY caused 20+ GB OOM on prod).
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(rc.total_cost_in_usd_cents), 0) AS spent_cents
      FROM runs r
      JOIN runs_costs rc ON rc.run_id = r.id
     WHERE r.organization_id = ${org_id}
       AND rc.is_platform_projected
  `);

  const rows = result as any[];
  const spentCents = rows[0]?.spent_cents ?? 0;
  const response = {
    org_id,
    spent_cents: new Decimal(spentCents).toFixed(10),
    as_of: new Date().toISOString(),
  };

  res.json(response);
});

export default router;
