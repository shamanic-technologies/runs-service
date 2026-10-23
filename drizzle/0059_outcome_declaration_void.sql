-- RUNS-VOID-1023: the service that owns a run can TAKE BACK what it declared on
-- it in error (POST /v1/runs/:id/outcomes/void, POST /v1/platform-runs/:id/outcomes/void).
-- A void is one bronze `outcomes.voided` event (reason, voidedBy, the removed rows
-- and the first UTC day they could have moved); the projection removes the run's
-- run_outcomes rows, so the void counts in NO figure (every read is on silver).
-- Bronze keeps both events: the history of what was stated and taken back is
-- never lost. A voided run accepts no new declaration (the projection refuses it,
-- the handler answers 409 before that).
--
-- BOOT-WINDOW SAFE: one function replaced, one index on a small table (~80k rows).

CREATE OR REPLACE FUNCTION project_outcome_declaration_to_silver() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type = 'outcomes.declared' THEN
    IF EXISTS (SELECT 1 FROM outcome_declaration_events e
               WHERE e.run_id = NEW.run_id AND e.event_type = 'outcomes.voided') THEN
      RAISE EXCEPTION 'run_outcomes_voided: run % had its declaration taken back, it accepts no new one', NEW.run_id;
    END IF;
    INSERT INTO run_outcomes (id, run_id, direction, outcome_key, subject_service, subject_id, quantity, declared_at)
    SELECT x.id, NEW.run_id, x.direction, x.outcome_key, x.subject_service, x.subject_id,
           COALESCE(x.quantity, 1), NEW.occurred_at
    FROM jsonb_to_recordset(NEW.payload->'items')
      AS x(id uuid, direction text, outcome_key text, subject_service text, subject_id text, quantity numeric)
    ON CONFLICT (run_id, direction, outcome_key, subject_service, subject_id) DO NOTHING;
  ELSIF NEW.event_type = 'outcomes.voided' THEN
    DELETE FROM run_outcomes WHERE run_id = NEW.run_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- The refresher's "which stored days did a void make stale?" probe.
CREATE INDEX IF NOT EXISTS idx_ode_event_type_occurred ON outcome_declaration_events (event_type, occurred_at);
