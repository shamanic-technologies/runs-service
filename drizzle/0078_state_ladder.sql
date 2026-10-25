-- LEAD-STATES-1024-RUNS-2: a lead state's inputs are the LOWER STATE (rule 4, owner 2026-10-24:
-- « a meeting = the interested leads it took + the follow-ups after the yes »), never the event
-- lead-service declared (meeting_booked <- conversation / form_submitted). Each first reach of a state
-- ranked r > 1 consumes that lead x brand's reach ranked r - 1 ('consumed' rows of outcome_cost_days);
-- a declared occurrence of a state key is evidence: not a unit, its consumptions dropped.
-- cost_ledger_computed_days.state_ladder = the day carries it. Ledger money is unchanged, so only the
-- outcome-costs read lists a day without it in daysMissing; the refresher recomputes it with stale days.
--
-- BOOT-WINDOW SAFE: one defaulted column add (metadata only).

ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS state_ladder boolean NOT NULL DEFAULT false;
