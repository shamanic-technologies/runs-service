-- SCOPED-VOID-1024: a declaring service takes back ONE part of a run's
-- declaration, (direction, outcome key), e.g. a wrong consumed email_found beside
-- a valid produced email_checked, then re-declares the right facts on the SAME
-- run. One bronze `outcomes.voided_scoped` event (reason, voidedBy, scope, the
-- removed rows, affectedFromDay); the projection deletes exactly those rows. The
-- run stays open (only a whole-run `outcomes.voided` is final).
--
-- BOOT-WINDOW SAFE: CREATE OR REPLACE FUNCTION only.

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
  ELSIF NEW.event_type = 'outcomes.voided_scoped' THEN
    -- Exactly the rows the event names (one direction x outcome key of the run).
    DELETE FROM run_outcomes o
    USING jsonb_to_recordset(NEW.payload->'items') AS x(id uuid)
    WHERE o.id = x.id AND o.run_id = NEW.run_id;
  ELSIF NEW.event_type = 'run.support_marked' THEN
    INSERT INTO run_support_marks (run_id, kind, marked_at)
    VALUES (NEW.run_id, NEW.payload->>'kind', NEW.occurred_at)
    ON CONFLICT (run_id) DO NOTHING;
  ELSIF NEW.event_type = 'run.support_unmarked' THEN
    DELETE FROM run_support_marks WHERE run_id = NEW.run_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
