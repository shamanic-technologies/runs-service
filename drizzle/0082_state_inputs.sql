-- LEAD-STATES-1024-RUNS-4: a pipe aiming at a lead state takes in the LOWER state of every lead it works on,
-- booked or not (rule 4, owner 2026-10-24: « meeting = 100 interested x $148 + $500 of follow-ups, / 10 »).
-- A consumption of a lead-service subject by a run whose pipe targets a state now names, as consuming outcome,
-- the next state that lead had not reached (null = abnormal) and, as consumed outcome, the state the consumed
-- step reaches (conversation -> lead_interested), once per lead (reuses dropped); the 0078 ladder row of a
-- reach is kept only when no such pipe took that lead's lower state in. Ledger money unchanged: only the
-- outcome-costs read lists a day stored before this stamp in daysMissing.
--
-- BOOT-WINDOW SAFE: one defaulted column add (metadata only).

ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS state_inputs boolean NOT NULL DEFAULT false;
