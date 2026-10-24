-- LEDGER-HISTORY-1024-RUNS: a mark kind for real PRODUCTION work that belongs to
-- no pipe and whose subject was never recorded (e.g. runs from before campaigns
-- existed, Feb 2026). Its owner states it (the mark doors), never inferred from
-- a missing campaign; the reconciliation states it on its own line
-- (unattributed), never support, never spread.
--
-- BOOT-WINDOW SAFE: a CHECK swap on run_support_marks (~60k rows, one scan).

ALTER TABLE run_support_marks DROP CONSTRAINT IF EXISTS run_support_marks_kind_check;
--> statement-breakpoint
ALTER TABLE run_support_marks ADD CONSTRAINT run_support_marks_kind_check CHECK (kind IN (
  'payment_fees','brand_setup','copilot','platform_llm','staff_experiment','product_feature','retired_product','unattributed_production'
));
