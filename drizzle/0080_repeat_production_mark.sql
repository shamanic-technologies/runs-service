-- Owner 2026-10-25: work its OWNER states redid what was already done (lead-service's
-- relationship-sweep re-judging relations crm-service already identified) is booked
-- as ABNORMAL loss (reason repeat_production), never support, never a second
-- producer of the same occurrence. Stated through the support-mark doors with kind
-- `repeat_production`; the day statement moves it from produced-none to abnormal.
--
-- BOOT-WINDOW SAFE: a CHECK swap on run_support_marks.

ALTER TABLE run_support_marks DROP CONSTRAINT IF EXISTS run_support_marks_kind_check;
--> statement-breakpoint
ALTER TABLE run_support_marks ADD CONSTRAINT run_support_marks_kind_check CHECK (kind IN (
  'payment_fees','brand_setup','copilot','platform_llm','staff_experiment','product_feature','retired_product','unattributed_production','repeat_production'
));
