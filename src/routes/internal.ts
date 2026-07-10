import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { runs } from "../db/schema.js";
import { requireInternalAuth } from "../middleware/auth.js";
import { logRunLifecycle } from "../services/bronze.js";
import {
  TransferBrandRequestSchema,
  RunsExpectedTotalsQuerySchema,
  OrgUsageTotalQuerySchema,
  DeleteRunsByOrgParamsSchema,
} from "../schemas.js";

const router = Router();

type OrgRunTeardownRow = {
  id: string;
  user_id: string | null;
  brand_ids: string[] | null;
  campaign_id: string | null;
  workflow_slug: string | null;
  feature_slug: string | null;
  service_name: string;
  task_name: string;
};

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

// DELETE /internal/runs/by-org/:orgId — org cascade teardown.
// Bronze records the teardown decision; the projection trigger deletes the
// silver run, cascading runs_costs + run_events for the live billing surface.
router.delete("/internal/runs/by-org/:orgId", requireInternalAuth, async (req, res) => {
  const parsed = DeleteRunsByOrgParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid params", details: parsed.error.flatten() });
    return;
  }

  const { orgId } = parsed.data;
  const sourceService = (req.headers["x-service-name"] as string | undefined)?.trim() || null;

  try {
    const deletedRuns = await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        WITH RECURSIVE org_runs AS (
          SELECT id, parent_run_id, user_id, brand_ids, campaign_id,
                 workflow_slug, feature_slug, service_name, task_name
            FROM runs
           WHERE organization_id = ${orgId}
        ),
        walk AS (
          SELECT r.*, 0 AS depth
            FROM org_runs r
           WHERE r.parent_run_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM org_runs p WHERE p.id = r.parent_run_id)
          UNION ALL
          SELECT child.*, walk.depth + 1 AS depth
            FROM org_runs child
            JOIN walk ON child.parent_run_id = walk.id
        )
        SELECT id, user_id, brand_ids, campaign_id, workflow_slug, feature_slug,
               service_name, task_name
          FROM walk
         ORDER BY depth DESC, id
      `);

      const rows = result as unknown as OrgRunTeardownRow[];

      for (const row of rows) {
        await logRunLifecycle(tx, {
          runId: row.id,
          eventType: "run.org_deleted",
          payload: {
            organizationId: orgId,
            reason: "org_cascade_teardown",
          },
          identity: {
            orgId,
            userId: row.user_id,
            brandIds: row.brand_ids,
            campaignId: row.campaign_id,
            workflowSlug: row.workflow_slug,
            featureSlug: row.feature_slug,
          },
          sourceService,
        });
      }

      return rows.length;
    });

    res.json({ orgId, deletedRuns, tombstoneEvents: deletedRuns });
  } catch (err) {
    console.error("[runs-service] Error in DELETE /internal/runs/by-org/:orgId:", err);
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

// GET /internal/org-usage-total — inline aggregate bounded by org_id, using the
// is_platform_projected generated col (single source for the platform-projected
// predicate). Gold view v_org_platform_spend dropped in migration 0026 (OOM).
router.get("/internal/org-usage-total", requireInternalAuth, async (req, res) => {
  const parsed = OrgUsageTotalQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const { org_id } = parsed.data;

  // Inline aggregate using is_platform_projected generated col + partial index.
  // spent_cents = GROSS (unchanged — existing consumers keep today's number).
  // net_spent_cents = frozen NET (gross reduced by the discount that was in
  // effect when each cost was written); COALESCE(net, total) so historical rows
  // read net == gross. billing-service reads net_spent_cents for the spendable
  // balance once it opts in; gross stays the default.
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(rc.total_cost_in_usd_cents), 0) AS spent_cents,
           COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)), 0) AS net_spent_cents
      FROM runs r
      JOIN runs_costs rc ON rc.run_id = r.id
     WHERE r.organization_id = ${org_id}
       AND rc.is_platform_projected
  `);

  const rows = result as any[];
  const spentCents = rows[0]?.spent_cents ?? 0;
  const netSpentCents = rows[0]?.net_spent_cents ?? 0;
  const response = {
    org_id,
    spent_cents: new Decimal(spentCents).toFixed(10),
    net_spent_cents: new Decimal(netSpentCents).toFixed(10),
    as_of: new Date().toISOString(),
  };

  res.json(response);
});

export default router;
