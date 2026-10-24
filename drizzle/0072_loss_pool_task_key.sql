-- LEDGER-HISTORY-1024-RUNS: allocation v4. A run that produced nothing with NO
-- workflow (crm-service Jev judgments that kept nothing, 2026-10-24) pools onto
-- its own TASK (service + task name): per (UTC day, cost org, pool key,
-- campaign) where pool key = 'workflow:<slug>' or 'task:<service>/<task>'.
-- v3 pooled only runs carrying a workflow, so that loss read undeclared.
--
-- BOOT-WINDOW SAFE: small table (one row per day x org x pool).

ALTER TABLE cost_loss_pool_days ADD COLUMN IF NOT EXISTS pool_key text;
--> statement-breakpoint
UPDATE cost_loss_pool_days SET pool_key = 'workflow:' || workflow_slug WHERE pool_key IS NULL;
--> statement-breakpoint
ALTER TABLE cost_loss_pool_days ALTER COLUMN pool_key SET NOT NULL;
--> statement-breakpoint
ALTER TABLE cost_loss_pool_days ALTER COLUMN workflow_slug DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE cost_loss_pool_days DROP CONSTRAINT IF EXISTS cost_loss_pool_days_key;
--> statement-breakpoint
ALTER TABLE cost_loss_pool_days ADD CONSTRAINT cost_loss_pool_days_key
  UNIQUE NULLS NOT DISTINCT (day, allocation_version, organization_id, pool_key, campaign_id);
