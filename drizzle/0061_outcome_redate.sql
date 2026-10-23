-- COST-BACKFILL-1023-RUNS follow-up: RE-DATING an occurrence declared through
-- today's door before `occurredAt` existed (instantly-service declared 79k past
-- sends on 2026-10-23 stamped with that day). One bronze `outcomes.redated`
-- event per run (items: id, the new effective declared_at); the projection moves
-- declared_at EARLIER only (never later: an effective time never passes its
-- recording), and sets recorded_at to the re-date's instant so the refresher
-- recomputes every stored day the move touches. Bronze keeps both statements.
--
-- BOOT-WINDOW SAFE: one function replaced.

CREATE OR REPLACE FUNCTION project_outcome_declaration_to_silver() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type = 'outcomes.declared' THEN
    IF EXISTS (SELECT 1 FROM outcome_declaration_events e
               WHERE e.run_id = NEW.run_id AND e.event_type = 'outcomes.voided') THEN
      RAISE EXCEPTION 'run_outcomes_voided: run % had its declaration taken back, it accepts no new one', NEW.run_id;
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
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
