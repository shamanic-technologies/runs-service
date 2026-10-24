-- LEDGER-HISTORY-1024-RUNS: allocation v3 + the grains the reconciliation reads.
--
-- v3 = v2 with the cross-run loss pool keyed on the CAMPAIGN too: spend of a run
-- that produced nothing inside campaign C (workflow W, cost org K) rides the units
-- C itself produced that day on W, never another campaign's units of the same
-- workflow (v2 pooled per (day, K, W) and moved campaign A's loss onto campaign B).
-- A campaign that produced nothing that day keeps its loss as produced-none, under
-- its own campaign (outcome_cost_days 'none' rows carry the spending run's tags).
--
-- outcome_cost_days gains the row's run's AUDIENCE, the producing run's audience
-- (consumed rows), the row's run's SERVICE (declaring / consuming / spending run),
-- and on 'none' rows n = distinct spending runs (was 0).
--
-- v2 rows stay as they are (a version never edits another); the refresher
-- computes every day under v3, and every read lists a day not yet computed under
-- v3 in daysMissing.
--
-- BOOT-WINDOW SAFE: nullable columns, a constraint swap on a small table.

ALTER TABLE cost_loss_pool_days ADD COLUMN IF NOT EXISTS campaign_id text;
--> statement-breakpoint
ALTER TABLE cost_loss_pool_days DROP CONSTRAINT IF EXISTS cost_loss_pool_days_key;
--> statement-breakpoint
ALTER TABLE cost_loss_pool_days ADD CONSTRAINT cost_loss_pool_days_key
  UNIQUE NULLS NOT DISTINCT (day, allocation_version, organization_id, workflow_slug, campaign_id);
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS audience_id text;
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS source_audience_id text;
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS service_name text;
--> statement-breakpoint
-- Stale days: the refresher's sweep (every tick) stores which stored days were
-- computed before a fact recorded since (backfilled declaration, mark, void, late
-- spend) and the instant it swept; a read adds only the facts recorded after that
-- instant, so it never re-scans a backfill's whole history.
ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS stale boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cost_ledger_stale_sweeps (
  allocation_version integer PRIMARY KEY,
  swept_at timestamptz NOT NULL
);
