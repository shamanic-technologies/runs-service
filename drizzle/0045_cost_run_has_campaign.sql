-- Campaign spend vs no-campaign spend on the cost ledger (owner 2026-10-13: a
-- customer is charged only what a campaign spends; the platform absorbs the rest).
--
-- A cost row belongs to a campaign iff its RUN carries a campaign_id. A run's
-- campaign is set once at creation (a child with none inherits its parent's) and
-- no projection ever changes it, so the fact is frozen onto the cost row at insert:
-- one runs_pkey probe per cost write, the same freeze family as 0029/0030.
--
-- NULL = not known yet (written before this migration, before the out-of-band
-- backfill scripts/backfill-cost-run-has-campaign.ts). Readers never fold NULL into
-- either side: the balance read 500s on one in its window, the monthly read states
-- it apart.
--
-- On prod the column and the index are created out-of-band before the deploy
-- (ADD COLUMN is metadata-only; the index CONCURRENTLY), so both IF NOT EXISTS
-- below no-op there and the boot migration only installs the trigger.

ALTER TABLE runs_costs ADD COLUMN IF NOT EXISTS run_has_campaign boolean;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION freeze_cost_run_has_campaign() RETURNS trigger AS $$
BEGIN
  SELECT r.campaign_id IS NOT NULL INTO NEW.run_has_campaign
    FROM runs r
   WHERE r.id = NEW.run_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_freeze_cost_run_has_campaign ON runs_costs;
--> statement-breakpoint

CREATE TRIGGER trg_freeze_cost_run_has_campaign
  BEFORE INSERT ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION freeze_cost_run_has_campaign();
--> statement-breakpoint

-- The balance read: one org's platform-projected rows that are NOT known to be
-- campaign spend (no campaign, or not known yet), from a cutover instant on.
-- After the backfill this holds only the no-campaign rows (~2% of the money).
CREATE INDEX IF NOT EXISTS idx_runs_costs_org_no_campaign
  ON runs_costs (organization_id, created_at)
  INCLUDE (total_cost_in_usd_cents, net_cost_in_usd_cents, run_has_campaign)
  WHERE is_platform_projected AND run_has_campaign IS NOT TRUE;
