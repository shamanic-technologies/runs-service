-- COST-SUPPORT-1024-RUNS: support spend is NAMED (which support function) and
-- reported apart, so coverage reads on outcome spend only (cost-accounting
-- skill: "Not outcomes ... Support functions, reported apart").
--
-- 1. run_support_marks.kind is the SUPPORT FUNCTION: payment_fees, brand_setup,
--    copilot, platform_llm (platform LLM calls / judgments made for no caller
--    run), staff_experiment, product_feature (onboarding, product reads),
--    retired_product (spend of a product no longer in the fleet). The 0062
--    value 'support' (unnamed) is dropped: no row ever carried it.
-- 2. The stored days state support apart, per function, as a SUBSET of
--    produced none: produced none = support + undeclared, so the check
--    standard - reuse gain + support + undeclared = ledger holds as before.
--    cost_ledger_days / outcome_coverage_days carry it as jsonb per function
--    (NULL = day stored before this migration), outcome_cost_days 'none' rows
--    carry the function (NULL = undeclared spend).
-- 3. cost_ledger_computed_days.support_split: a day stored before this
--    migration (false) is recomputed by the refresher; figures byte-identical.
--
-- BOOT-WINDOW SAFE: a CHECK swap on a 3k-row table, nullable adds (metadata).

ALTER TABLE run_support_marks DROP CONSTRAINT IF EXISTS run_support_marks_kind_check;
--> statement-breakpoint
ALTER TABLE run_support_marks ADD CONSTRAINT run_support_marks_kind_check CHECK (kind IN (
  'payment_fees','brand_setup','copilot','platform_llm','staff_experiment','product_feature','retired_product'
));
--> statement-breakpoint
ALTER TABLE cost_ledger_days ADD COLUMN IF NOT EXISTS support_by_function jsonb;
--> statement-breakpoint
ALTER TABLE outcome_coverage_days ADD COLUMN IF NOT EXISTS support_by_function jsonb;
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS support_function text;
--> statement-breakpoint
ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS support_split boolean NOT NULL DEFAULT false;
