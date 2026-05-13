import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs } from "../db/schema.js";
import { requireInternalAuth } from "../middleware/auth.js";
import { TransferBrandRequestSchema, RunsExpectedTotalsQuerySchema } from "../schemas.js";

const router = Router();

// POST /internal/transfer-brand — re-assign solo-brand runs to a different org
router.post("/internal/transfer-brand", requireInternalAuth, async (req, res) => {
  try {
    const parsed = TransferBrandRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

    // Step 1: Move org — solo-brand runs from sourceOrgId to targetOrgId
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

    // Step 2: Rewrite brand reference globally (no org filter) when targetBrandId is present
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
    console.log(`[Runs Service] transfer-brand: moved ${step1.length} runs from org ${sourceOrgId} to ${targetOrgId} for brand ${sourceBrandId}${targetBrandId ? `, rewrote ${rewriteCount} brand refs → ${targetBrandId}` : ""}`);

    res.json({
      updatedTables: [{ tableName: "runs", count: totalUpdated }],
    });
  } catch (err) {
    console.error("[Runs Service] Error in POST /internal/transfer-brand:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /internal/runs-expected-totals — per-run expected platform-actual totals for an org
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
         AND rc.cost_source = 'platform'
         AND rc.status = 'actual'
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

export default router;
