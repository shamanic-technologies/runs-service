-- Phase 1 of B/S/G substrate (γ migration plan).
-- Gold-layer views consolidating the three recursive descendants CTEs and four aggregation surfaces
-- previously scattered across routes/{runs,internal,stats}.ts.
--
-- Doctrine: all cost math in Postgres (CLAUDE.md "numeric(16,10) precision" rule).
-- Phase 1 = create views only. Phase 4 = swap routes to read from them.
-- Views reference is_platform_projected / is_platform_committed generated cols from 0017.

-- CREATE OR REPLACE is idempotent on re-runs and respects view dependencies.
CREATE OR REPLACE VIEW "v_runs_with_descendants" AS
WITH RECURSIVE walk AS (
  SELECT
    "id",
    "id" AS "root_run_id",
    "organization_id",
    0 AS "depth"
  FROM "runs"
  UNION ALL
  SELECT
    r."id",
    w."root_run_id",
    w."organization_id",
    w."depth" + 1
  FROM "runs" r
  INNER JOIN walk w ON r."parent_run_id" = w."id"
)
SELECT * FROM walk;--> statement-breakpoint

-- Per-root rollup. Single source for costs/batch, GET /v1/runs/:id, new runs/batch endpoint.
CREATE OR REPLACE VIEW "v_run_cost_rollup" AS
SELECT
  w."root_run_id",
  w."organization_id",
  COALESCE(SUM(CASE WHEN rc."status" <> 'cancelled' THEN rc."total_cost_in_usd_cents" ELSE 0 END), 0) AS "total_cost",
  COALESCE(SUM(CASE WHEN rc."status" = 'actual'      THEN rc."total_cost_in_usd_cents" ELSE 0 END), 0) AS "actual_cost",
  COALESCE(SUM(CASE WHEN rc."status" = 'provisioned' THEN rc."total_cost_in_usd_cents" ELSE 0 END), 0) AS "provisioned_cost",
  COALESCE(SUM(CASE WHEN rc."status" = 'cancelled'   THEN rc."total_cost_in_usd_cents" ELSE 0 END), 0) AS "cancelled_cost",
  COALESCE(SUM(CASE WHEN w."depth" = 0 AND rc."status" = 'actual'      AND rc."is_platform_projected" THEN rc."total_cost_in_usd_cents" ELSE 0 END), 0) AS "own_actual_platform_cost",
  COALESCE(SUM(CASE WHEN w."depth" = 0 AND rc."status" = 'provisioned' AND rc."is_platform_projected" THEN rc."total_cost_in_usd_cents" ELSE 0 END), 0) AS "own_provisioned_platform_cost"
FROM "v_runs_with_descendants" w
LEFT JOIN "runs_costs" rc ON rc."run_id" = w."id"
GROUP BY w."root_run_id", w."organization_id";--> statement-breakpoint

-- Org-level projected platform spend. Single source for /internal/org-usage-total and billing notifyUsage.
CREATE OR REPLACE VIEW "v_org_platform_spend" AS
SELECT
  r."organization_id",
  COALESCE(SUM(rc."total_cost_in_usd_cents"), 0) AS "projected_spent_cents"
FROM "runs" r
JOIN "runs_costs" rc ON rc."run_id" = r."id"
WHERE rc."is_platform_projected"
GROUP BY r."organization_id";
