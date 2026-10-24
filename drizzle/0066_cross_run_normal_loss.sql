-- COST-SUPPORT-1024-RUNS-3: allocation v2 = v1 + rule 4b, cross-run normal loss
-- (doctrine rule 2: normal loss rides the good units of the same pipe, in the
-- orgs where the outcome happened). A cost row with no anchor, no support mark on
-- its walk and a workflow slug W on its run is loss of pipe W: per (UTC day,
-- cost org, W) it is split over the occurrences produced that day by runs of W
-- in that org.
--
-- cost_loss_pool_days: the day's pools (stored by the refresher with the day), so
-- the per-occurrence read adds the same shares the day spread.
-- cost_ledger_days.loss_*: the part of allocated that is normal loss.
--
-- v1 rows stay as they are (a version never edits another); the refresher
-- computes every day under v2.
--
-- BOOT-WINDOW SAFE: one empty table, nullable/defaulted adds on small tables.

CREATE TABLE IF NOT EXISTS cost_loss_pool_days (
  day date NOT NULL,
  allocation_version integer NOT NULL,
  organization_id uuid,
  workflow_slug text NOT NULL,
  units bigint NOT NULL,
  gross numeric NOT NULL,
  net numeric NOT NULL,
  vendor numeric NOT NULL,
  unpriced_gross numeric NOT NULL,
  CONSTRAINT cost_loss_pool_days_key UNIQUE NULLS NOT DISTINCT (day, allocation_version, organization_id, workflow_slug)
);
--> statement-breakpoint
ALTER TABLE cost_ledger_days ADD COLUMN IF NOT EXISTS loss_gross numeric NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE cost_ledger_days ADD COLUMN IF NOT EXISTS loss_net numeric NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE cost_ledger_days ADD COLUMN IF NOT EXISTS loss_vendor numeric NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE cost_ledger_days ADD COLUMN IF NOT EXISTS loss_unpriced_gross numeric NOT NULL DEFAULT 0;
