-- MEETING-DATED-OCCURRENCES-1024-RUNS: a SPEND-FREE run (no cost row, no child
-- run) may hold an occurrence dated BEFORE its own start: a production order
-- that only states a FACT reached in the past (lead-service's `outcome-recording`
-- runs: a meeting booked in May, recorded today). Spend is still never
-- back-dated: the handlers refuse a pre-start time on a run with spend, and
-- these guards make the rule hold whatever the order of writes:
--   1. run_outcomes: an occurrence dated before its run's start is refused while
--      the run holds a cost row or a child run ('outcome_before_run_start').
--   2. runs_costs: a cost on a run holding a pre-start occurrence is refused
--      ('run_holds_dated_facts').
--   3. runs: a CHILD of such a run is refused (its spend would ride the run's
--      outcomes) ('run_holds_dated_facts').
-- A DATED occurrence = one stated with a time earlier than its recording
-- (declared_at < recorded_at): an on-time declaration (declared_at = recorded_at,
-- or recorded_at NULL before 0060) is never caught by a clock difference.
-- Each guard is one index probe (run_outcomes by run_id; runs_costs by run_id;
-- runs by parent_run_id).
--
-- BOOT-WINDOW SAFE: functions + triggers only (brief SHARE ROW EXCLUSIVE lock per
-- CREATE TRIGGER, no scan, no rewrite).

CREATE OR REPLACE FUNCTION guard_outcome_before_run_start() RETURNS trigger AS $$
BEGIN
  IF NEW.recorded_at IS NOT NULL AND NEW.declared_at < NEW.recorded_at
     AND NEW.declared_at < (SELECT started_at FROM runs WHERE id = NEW.run_id)
     AND (EXISTS (SELECT 1 FROM runs_costs c WHERE c.run_id = NEW.run_id)
          OR EXISTS (SELECT 1 FROM runs ch WHERE ch.parent_run_id = NEW.run_id)) THEN
    RAISE EXCEPTION 'outcome_before_run_start: run % carries spend or child runs, it never dates an outcome before it started', NEW.run_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_guard_outcome_before_run_start ON run_outcomes;
--> statement-breakpoint
CREATE TRIGGER trg_guard_outcome_before_run_start
BEFORE INSERT OR UPDATE OF declared_at ON run_outcomes
FOR EACH ROW EXECUTE FUNCTION guard_outcome_before_run_start();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_run_holds_dated_facts() RETURNS trigger AS $$
DECLARE
  target uuid;
BEGIN
  IF TG_TABLE_NAME = 'runs' THEN
    target := NEW.parent_run_id;
  ELSE
    target := NEW.run_id;
  END IF;
  IF target IS NOT NULL AND EXISTS (
    SELECT 1 FROM run_outcomes o JOIN runs r ON r.id = o.run_id
    WHERE o.run_id = target AND o.declared_at < r.started_at
      AND o.recorded_at IS NOT NULL AND o.declared_at < o.recorded_at
  ) THEN
    RAISE EXCEPTION 'run_holds_dated_facts: run % holds an occurrence dated before its start, it takes no spend and no child run', target;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_guard_cost_on_dated_facts ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER trg_guard_cost_on_dated_facts
BEFORE INSERT ON runs_costs
FOR EACH ROW EXECUTE FUNCTION guard_run_holds_dated_facts();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_guard_child_of_dated_facts ON runs;
--> statement-breakpoint
CREATE TRIGGER trg_guard_child_of_dated_facts
BEFORE INSERT ON runs
FOR EACH ROW WHEN (NEW.parent_run_id IS NOT NULL)
EXECUTE FUNCTION guard_run_holds_dated_facts();
