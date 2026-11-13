-- CAMPAIGN-SCRIPTS-1113-RUNS: the campaign each script decision ran for (the decision run's campaign_id, set once at
-- run creation), so script-reach can be narrowed to one campaign or a small set. campaign_read = the build has read it
-- (rows written before this migration hold NULL until the next build reads them off runs once). Tiny table: boot-window safe.
ALTER TABLE script_chain_decisions ADD COLUMN IF NOT EXISTS campaign_id text;
--> statement-breakpoint
ALTER TABLE script_chain_decisions ADD COLUMN IF NOT EXISTS campaign_read boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_script_chain_decisions_campaign ON script_chain_decisions (campaign_id) WHERE campaign_id IS NOT NULL;
