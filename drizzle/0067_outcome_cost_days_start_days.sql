-- COST-ACCOUNTING-1023-SWITCH-RUNS: the outcome totals grouped by WHEN.
-- features-service's MATURE cost per outcome cuts at a leg's maturity cutoff:
-- spend of runs STARTED before the cutoff over the outcomes those runs' sends
-- got (a positive reply 30 days after the send counts for the send). The stored
-- rows only knew the cost row's day (produced cost), the declaration day
-- (produced count, consumed) and the producing run's tags (0063), never when the
-- run started nor when the consumed occurrence was produced.
--
-- run_start_day        = UTC day the row's tagged run started (declaring run for
--                        produced_*, consuming run for consumed, spending run for none)
-- source_day           = consumed only: UTC day the consumed (source) occurrence
--                        was declared (its effective time, 0060)
-- source_run_start_day = consumed only: UTC day the run that PRODUCED it started
--
-- Derived rows only: no declaration, cost row or allocation rule changes (v1).
-- A day stored before this migration has start_days = false; the refresher
-- recomputes it (same figures, the new columns filled), and a read grouping or
-- filtering by one of them lists it in daysMissing until then.
--
-- BOOT-WINDOW SAFE: nullable / defaulted columns only (metadata).

ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS run_start_day date;
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS source_day date;
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS source_run_start_day date;
--> statement-breakpoint
ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS start_days boolean NOT NULL DEFAULT false;
