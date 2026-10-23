-- COST-ACCOUNTING-1023-P2: the outcome ledger read as TOTALS
-- (GET /internal/stats/outcome-costs). features-service rolls up what each
-- outcome costs to produce every 15 min; paging every occurrence is not viable
-- (millions a quarter), so the same per-day computation that stores the ledger
-- check also stores, per UTC day, the totals per outcome x production tags.
-- Grain per kind (see services/outcome-ledger.ts OutcomeCostRow):
--   produced_count  occurrences declared that day, per outcome x declaring run's tags
--   produced_cost   the v1 shares of the day's spend, per outcome x declaring run's tags x cost org
--   consumed        consumptions declared that day, per (consuming outcome, consumed outcome) x consuming run's tags
--   none            the day's spend no declaring run carries, per spending run's tags x cost org
-- Unconstrained numeric: exact sums.
--
-- BOOT-WINDOW SAFE: one empty table, one index, one nullable-default column.
-- Days stored before this migration have outcome_costs = false and are
-- recomputed by the refresher (<= 8 a tick), the ledger rows byte-identical.

CREATE TABLE IF NOT EXISTS outcome_cost_days (
  day date NOT NULL,
  allocation_version integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('produced_count','produced_cost','consumed','none')),
  outcome_key text,
  consumed_outcome_key text,
  organization_id uuid,
  cost_organization_id uuid,
  brand_ids text[],
  campaign_id text,
  workflow_slug text,
  feature_slug text,
  n numeric NOT NULL DEFAULT 0,
  quantity numeric NOT NULL DEFAULT 0,
  reuses numeric NOT NULL DEFAULT 0,
  unknown_provenance numeric NOT NULL DEFAULT 0,
  gross numeric NOT NULL DEFAULT 0,
  net numeric NOT NULL DEFAULT 0,
  vendor numeric NOT NULL DEFAULT 0,
  unpriced_gross numeric NOT NULL DEFAULT 0,
  reuse_gross numeric NOT NULL DEFAULT 0,
  reuse_net numeric NOT NULL DEFAULT 0,
  reuse_vendor numeric NOT NULL DEFAULT 0,
  reuse_unpriced_gross numeric NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_outcome_cost_days_day ON outcome_cost_days (allocation_version, day);
--> statement-breakpoint
ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS outcome_costs boolean NOT NULL DEFAULT false;
