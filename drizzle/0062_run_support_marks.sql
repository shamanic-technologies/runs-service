-- COST-BACKFILL-1023 follow-up: a run marked SUPPORT (a staff experiment, a probe,
-- any support function: cost-accounting skill "Not outcomes ... reported apart")
-- is a STOP for the ledger's anchor walk: its own cost and its whole subtree's
-- stay "produced none", never climb to a declaring ancestor. First case
-- (2026-10-23): 3,052 apollo/chat probe runs parented to 7 postmark send runs
-- (probe sessions reused real run ids as x-run-id), which priced ~$114 of staff
-- probe spend into newsletter message_sent once transactional-email-service
-- backfilled its release runs.
--
-- Bronze -> silver as every ledger fact: one `run.support_marked` event per run
-- in outcome_declaration_events (kind, reason, markedBy), the trigger projects it
-- into run_support_marks. A marked run produces nothing: the projection refuses a
-- produced declaration on it, and a run that already declared a produced
-- occurrence cannot be marked (handler 422).
--
-- BOOT-WINDOW SAFE: one empty table, one function replaced.

CREATE TABLE IF NOT EXISTS run_support_marks (
  run_id uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('staff_experiment','support')),
  marked_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_run_support_marks_marked ON run_support_marks (marked_at);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_outcome_declaration_to_silver() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type = 'outcomes.declared' THEN
    IF EXISTS (SELECT 1 FROM outcome_declaration_events e
               WHERE e.run_id = NEW.run_id AND e.event_type = 'outcomes.voided') THEN
      RAISE EXCEPTION 'run_outcomes_voided: run % had its declaration taken back, it accepts no new one', NEW.run_id;
    END IF;
    IF EXISTS (SELECT 1 FROM run_support_marks m WHERE m.run_id = NEW.run_id)
       AND EXISTS (SELECT 1 FROM jsonb_to_recordset(NEW.payload->'items') AS x(direction text) WHERE x.direction = 'produced') THEN
      RAISE EXCEPTION 'run_marked_support: run % is marked support, it produces no outcome', NEW.run_id;
    END IF;
    INSERT INTO run_outcomes (id, run_id, direction, outcome_key, subject_service, subject_id, quantity, declared_at, recorded_at)
    SELECT x.id, NEW.run_id, x.direction, x.outcome_key, x.subject_service, x.subject_id,
           COALESCE(x.quantity, 1), COALESCE(x.declared_at, NEW.occurred_at), NEW.occurred_at
    FROM jsonb_to_recordset(NEW.payload->'items')
      AS x(id uuid, direction text, outcome_key text, subject_service text, subject_id text, quantity numeric, declared_at timestamptz)
    ON CONFLICT (run_id, direction, outcome_key, subject_service, subject_id) DO NOTHING;
  ELSIF NEW.event_type = 'outcomes.redated' THEN
    UPDATE run_outcomes o
    SET declared_at = x.declared_at, recorded_at = NEW.occurred_at
    FROM jsonb_to_recordset(NEW.payload->'items') AS x(id uuid, declared_at timestamptz)
    WHERE o.id = x.id AND o.run_id = NEW.run_id AND o.declared_at > x.declared_at;
  ELSIF NEW.event_type = 'outcomes.voided' THEN
    DELETE FROM run_outcomes WHERE run_id = NEW.run_id;
  ELSIF NEW.event_type = 'run.support_marked' THEN
    INSERT INTO run_support_marks (run_id, kind, marked_at)
    VALUES (NEW.run_id, NEW.payload->>'kind', NEW.occurred_at)
    ON CONFLICT (run_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
