-- Hotfix: widen runs_costs.unit_cost_in_usd_cents from numeric(12,10) to numeric(16,10).
--
-- Bug: numeric(12,10) allows only 2 integer digits (max abs < 100 cents = $1).
-- Any cost whose resolved unit price is >= $1 (e.g. featured-api-pitch-submit)
-- overflowed (22003) inside project_cost_lifecycle_to_silver()'s INSERT INTO
-- runs_costs, rolling back the whole cost.added txn -> caller got a 500. The
-- sibling total_cost_in_usd_cents was already numeric(16,10); unit_cost was
-- under-sized at table creation (migration 0000). Widening to match.
--
-- Post Phase 6 (view shim, migration 0021): `runs_costs` is an auto-updatable
-- VIEW over base table `runs_costs_old`, and the gold views v_run_cost_rollup /
-- v_org_platform_spend depend on the `runs_costs` view. PG forbids ALTER COLUMN
-- TYPE on a column a view references, so we drop the dependent views in
-- dependency order, widen the base column, then recreate the views verbatim
-- from migrations 0019/0021. v_runs_with_descendants depends only on `runs`,
-- not `runs_costs`, so it is left untouched.
--
-- Idempotent: DROP ... IF EXISTS + CREATE OR REPLACE; ALTER to the same type is
-- a no-op. The views are recreated byte-for-byte from their source migrations.

DROP VIEW IF EXISTS "v_org_platform_spend";--> statement-breakpoint
DROP VIEW IF EXISTS "v_run_cost_rollup";--> statement-breakpoint
DROP VIEW IF EXISTS "runs_costs";--> statement-breakpoint

ALTER TABLE "runs_costs_old" ALTER COLUMN "unit_cost_in_usd_cents" TYPE numeric(16, 10);--> statement-breakpoint

-- Recreate the Phase 6 passthrough view (verbatim from 0021).
CREATE OR REPLACE VIEW "runs_costs" AS SELECT * FROM "runs_costs_old";--> statement-breakpoint

-- Recreate the gold views (verbatim from 0019).
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

CREATE OR REPLACE VIEW "v_org_platform_spend" AS
SELECT
  r."organization_id",
  COALESCE(SUM(rc."total_cost_in_usd_cents"), 0) AS "projected_spent_cents"
FROM "runs" r
JOIN "runs_costs" rc ON rc."run_id" = r."id"
WHERE rc."is_platform_projected"
GROUP BY r."organization_id";
