-- COST-ACCOUNTING-1023-P4-RUNS: a consumption grouped by WHERE its consumed
-- occurrence was produced. A positive reply is declared on a reply-judging run
-- (one per org per UTC day, no campaign / workflow / brand), so grouping the
-- consumptions by the CONSUMING run's tags cannot say which workflow's send got
-- the reply. The send carries those tags on its own PRODUCING run: the refresher
-- now stores them beside each consumed row (source_*), NULL when no run declared
-- producing the occurrence (unknown provenance, still counted).
--
-- Derived rows only: no declaration, cost row or allocation rule changes (v1).
-- A day stored before this migration has consumed_sources = false; the refresher
-- recomputes it (byte-identical figures, source columns filled), and a read
-- grouping by a source dimension lists it in daysMissing until then.
--
-- BOOT-WINDOW SAFE: nullable / defaulted columns only (metadata).

ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS source_organization_id uuid;
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS source_brand_ids text[];
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS source_campaign_id text;
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS source_workflow_slug text;
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS source_feature_slug text;
--> statement-breakpoint
ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS consumed_sources boolean NOT NULL DEFAULT false;
