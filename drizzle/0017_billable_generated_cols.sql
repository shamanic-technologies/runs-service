-- Phase 1 of B/S/G substrate (γ migration plan).
-- Codify the three semantic cost predicates as generated boolean columns on runs_costs.
-- Before: 8+ inline SQL literals across routes/{runs,internal,stats}.ts duplicated the predicate.
-- After: schema-level definition. New status enum value → ONE column-def change propagates.
--
-- is_platform_projected = cost_source='platform' AND status IN ('actual','provisioned')
--   Meaning: "projected platform spend" — gates credit balance, billing authorize.
--   Used by: /internal/org-usage-total, fetchOrgPlatformSpent, costs/batch own-fields, billing notifyUsage.
--
-- is_platform_committed = cost_source='platform' AND status='actual'
--   Meaning: "committed platform spend" — money the platform should have collected.
--   Used by: /internal/runs-expected-totals.

ALTER TABLE "runs_costs"
  ADD COLUMN IF NOT EXISTS "is_platform_projected" boolean
    GENERATED ALWAYS AS ("cost_source" = 'platform' AND "status" IN ('actual','provisioned')) STORED;--> statement-breakpoint

ALTER TABLE "runs_costs"
  ADD COLUMN IF NOT EXISTS "is_platform_committed" boolean
    GENERATED ALWAYS AS ("cost_source" = 'platform' AND "status" = 'actual') STORED;--> statement-breakpoint

-- Partial indexes for the predicate hot paths.
CREATE INDEX IF NOT EXISTS "idx_runs_costs_projected"
  ON "runs_costs" ("run_id") WHERE "is_platform_projected";--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_runs_costs_committed"
  ON "runs_costs" ("run_id") WHERE "is_platform_committed";
