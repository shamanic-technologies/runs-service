-- Drop unused indexes (0 scans in pg_stat_user_indexes)
DROP INDEX IF EXISTS "idx_runs_org";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_runs_status";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_runs_started_at";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_runs_workflow_slug";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_runs_costs_cost_name";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_runs_costs_run_id";--> statement-breakpoint

-- Add composite index on runs(feature_slug, organization_id) for stats queries
-- The public and private stats endpoints filter by feature_slug with optional org_id
CREATE INDEX IF NOT EXISTS "idx_runs_feature_org" ON "runs" USING btree ("feature_slug","organization_id");--> statement-breakpoint

-- Add covering composite index on runs_costs for aggregation queries
-- Replaces idx_runs_costs_run_id; enables index-only scans for SUM(CASE WHEN status... THEN total_cost)
CREATE INDEX IF NOT EXISTS "idx_runs_costs_run_agg" ON "runs_costs" USING btree ("run_id","status","total_cost_in_usd_cents","quantity");--> statement-breakpoint

-- Add index on runs_costs.created_at for the budget endpoint's temporal window filters
CREATE INDEX IF NOT EXISTS "idx_runs_costs_created_at" ON "runs_costs" USING btree ("created_at");
