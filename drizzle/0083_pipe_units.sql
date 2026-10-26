-- LEDGER-PIPE-WEIGHTED-AVERAGE-1027 (owner 2026-10-27: « of course you take that cost in the price of building
-- outcomes »; by the book = weighted-average process costing per production line). A pipe's price = ALL its spend
-- (every day, every campaign) / ALL its units, not only the units reached the same day in the same campaign.
-- outcome_cost_days.pipe_target: on a 'none' row, the outcome of the pipe the spend works for (its lead's next
-- state, else the pipe's leg step). pipe_unit_days: each unit a pipe's spend reached on a day, by channel x
-- outcome, so the read counts a pipe's units DISTINCT over any range. cost_ledger_computed_days.pipe_units:
-- the day carries both (else recomputed; only the outcome-costs read lists it missing).
--
-- BOOT-WINDOW SAFE: one new table, nullable / defaulted adds.

CREATE TABLE IF NOT EXISTS pipe_unit_days (
  day date NOT NULL,
  allocation_version integer NOT NULL,
  feature_slug text NOT NULL,
  target text NOT NULL,
  unit_id uuid NOT NULL,
  organization_id uuid,
  PRIMARY KEY (allocation_version, day, feature_slug, target, unit_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pipe_unit_days_pipe ON pipe_unit_days (allocation_version, feature_slug, target, day);
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS pipe_target text;
--> statement-breakpoint
ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS pipe_units boolean NOT NULL DEFAULT false;
