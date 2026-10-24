-- RUN-STARTED-AT-US-1024: runs.started_at holds MICROseconds (Postgres now()),
-- every declaration time reaches us at MILLIsecond precision (JS Date, ISO
-- strings). A backfill stating occurredAt "run_started_at" on a run with spend
-- was stored at the truncated millisecond, e.g. started 20:41:57.323548 vs
-- declared .323000, and 0068's guard read it as "dated 548 µs before the run
-- started" (400 invalid_occurred_at on every run with a child or a cost,
-- workflow-service 2026-10-24). The guards now compare at millisecond precision:
-- an outcome within the run's start millisecond is at its start, never before.
--
-- BOOT-WINDOW SAFE: CREATE OR REPLACE FUNCTION only.

CREATE OR REPLACE FUNCTION guard_outcome_before_run_start() RETURNS trigger AS $$
BEGIN
  IF NEW.recorded_at IS NOT NULL AND NEW.declared_at < NEW.recorded_at
     AND NEW.declared_at < (SELECT date_trunc('milliseconds', started_at) FROM runs WHERE id = NEW.run_id)
     AND (EXISTS (SELECT 1 FROM runs_costs c WHERE c.run_id = NEW.run_id)
          OR EXISTS (SELECT 1 FROM runs ch WHERE ch.parent_run_id = NEW.run_id)) THEN
    RAISE EXCEPTION 'outcome_before_run_start: run % carries spend or child runs, it never dates an outcome before it started', NEW.run_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
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
    WHERE o.run_id = target AND o.declared_at < date_trunc('milliseconds', r.started_at)
      AND o.recorded_at IS NOT NULL AND o.declared_at < o.recorded_at
  ) THEN
    RAISE EXCEPTION 'run_holds_dated_facts: run % holds an occurrence dated before its start, it takes no spend and no child run', target;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
