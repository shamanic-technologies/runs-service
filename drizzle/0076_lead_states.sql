-- LEAD-STATES-1024-RUNS: allocation v5 (owner 2026-10-24, doctrine rules 2 and 3).
-- A lead outcome is a STATE reached once per lead x brand (interest ladder
-- lead_interested < meeting_booked < meeting_attended < paid_client; visit:
-- lead_visited). A run acting on a lead pays the NEXT state that lead had not
-- reached at the run's start, in each family; a run whose pipe targets a state
-- the lead already reached is ABNORMAL loss, in no unit cost (IAS 2 section 16).
--
-- lead_state_reaches: lead-service's first-reach dates (GET /internal/lead-states),
-- synced by the ledger refresher. One row per brand x lead x state. A row
-- lead-service stops serving is kept with removed_at (never a hard delete: the
-- refresher marks the days it touched stale). family / rank come from
-- features-service's step catalogue (leadStateFamily / leadStateRank).
--
-- cost_ledger_days.abnormal_*: the day's abnormal loss per org, per reason in
-- abnormal_by_reason. outcome_cost_days: kinds 'abnormal' (per reason, the
-- paying run's tags), 'parallel_cost' / 'parallel_none' (the same spend priced in
-- the OTHER state family: never summed with produced_cost).
--
-- BOOT-WINDOW SAFE: one empty table, defaulted adds and a CHECK swap on small tables.

CREATE TABLE IF NOT EXISTS lead_state_reaches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  brand_id text NOT NULL,
  lead_id text NOT NULL,
  state text NOT NULL,
  family text NOT NULL,
  rank integer NOT NULL,
  reached_at timestamptz,
  basis text,
  implied_by text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CONSTRAINT lead_state_reaches_key UNIQUE (brand_id, lead_id, state)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_state_reaches_lead ON lead_state_reaches (lead_id, family, reached_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_state_reaches_changed ON lead_state_reaches (changed_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_state_reaches_reached ON lead_state_reaches (reached_at);
--> statement-breakpoint
ALTER TABLE cost_ledger_days ADD COLUMN IF NOT EXISTS abnormal_gross numeric NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE cost_ledger_days ADD COLUMN IF NOT EXISTS abnormal_net numeric NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE cost_ledger_days ADD COLUMN IF NOT EXISTS abnormal_vendor numeric NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE cost_ledger_days ADD COLUMN IF NOT EXISTS abnormal_unpriced_gross numeric NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE cost_ledger_days ADD COLUMN IF NOT EXISTS abnormal_by_reason jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS abnormal_reason text;
--> statement-breakpoint
ALTER TABLE outcome_cost_days DROP CONSTRAINT IF EXISTS outcome_cost_days_kind_check;
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD CONSTRAINT outcome_cost_days_kind_check
  CHECK (kind IN ('produced_count','produced_cost','consumed','none','abnormal','parallel_cost','parallel_none'));
