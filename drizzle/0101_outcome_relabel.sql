-- OUTCOME-RELABEL-1107: a retired coarse outcome key (post_published, owner 2026-11-07: an outcome is
-- the WHAT as fine as possible) is RELABELLED to its fine twin on the occurrences already recorded,
-- never deleted. Staff door POST /internal/outcome-occurrences/relabel writes one bronze
-- `outcomes.relabeled` event per run (each item: id, new key, previous key), projected here. The
-- refresher re-stales every stored day from the event's affectedFromDay (like a void), so every
-- per-day figure keyed on the outcome (outcome_cost_days, pipe_unit_days, coverage...) recomputes.
--
-- BOOT-WINDOW SAFE: CREATE OR REPLACE FUNCTION only (same body as 0098 + one branch).

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
    INSERT INTO run_outcomes (id, run_id, direction, outcome_key, subject_service, subject_id, quantity, declared_at, recorded_at,
                              performer_kind, performer_workflow_slug, performer_name)
    SELECT x.id, NEW.run_id, x.direction, x.outcome_key, x.subject_service, x.subject_id,
           COALESCE(x.quantity, 1), COALESCE(x.declared_at, NEW.occurred_at), NEW.occurred_at,
           x.performer_kind, x.performer_workflow_slug, x.performer_name
    FROM jsonb_to_recordset(NEW.payload->'items')
      AS x(id uuid, direction text, outcome_key text, subject_service text, subject_id text, quantity numeric, declared_at timestamptz,
           performer_kind text, performer_workflow_slug text, performer_name text)
    ON CONFLICT (run_id, direction, outcome_key, subject_service, subject_id) DO NOTHING;
  ELSIF NEW.event_type = 'outcomes.redated' THEN
    UPDATE run_outcomes o
    SET declared_at = x.declared_at, recorded_at = NEW.occurred_at
    FROM jsonb_to_recordset(NEW.payload->'items') AS x(id uuid, declared_at timestamptz)
    WHERE o.id = x.id AND o.run_id = NEW.run_id AND o.declared_at > x.declared_at;
  ELSIF NEW.event_type = 'outcomes.performer_stated' THEN
    -- Set once: only an occurrence still carrying no performer takes one.
    UPDATE run_outcomes o
    SET performer_kind = x.performer_kind, performer_workflow_slug = x.performer_workflow_slug, performer_name = x.performer_name
    FROM jsonb_to_recordset(NEW.payload->'items') AS x(id uuid, performer_kind text, performer_workflow_slug text, performer_name text)
    WHERE o.id = x.id AND o.run_id = NEW.run_id AND o.performer_kind IS NULL;
  ELSIF NEW.event_type = 'outcomes.performer_corrected' THEN
    -- Replaces exactly the previous performer the event names.
    UPDATE run_outcomes o
    SET performer_kind = x.performer_kind, performer_workflow_slug = x.performer_workflow_slug, performer_name = x.performer_name
    FROM jsonb_to_recordset(NEW.payload->'items')
      AS x(id uuid, performer_kind text, performer_workflow_slug text, performer_name text,
           previous_performer_kind text, previous_performer_workflow_slug text, previous_performer_name text)
    WHERE o.id = x.id AND o.run_id = NEW.run_id
      AND o.performer_kind IS NOT DISTINCT FROM x.previous_performer_kind
      AND o.performer_workflow_slug IS NOT DISTINCT FROM x.previous_performer_workflow_slug
      AND o.performer_name IS NOT DISTINCT FROM x.previous_performer_name;
  ELSIF NEW.event_type = 'outcomes.relabeled' THEN
    -- OUTCOME-RELABEL-1107: the occurrence keeps its id, run, subject, quantity, time and performer;
    -- only its outcome key moves, and only from the key the event says it moves from. A collision
    -- with an occurrence already holding the new key fails on run_outcomes' unique key (never merged).
    UPDATE run_outcomes o
    SET outcome_key = x.outcome_key
    FROM jsonb_to_recordset(NEW.payload->'items') AS x(id uuid, outcome_key text, previous_outcome_key text)
    WHERE o.id = x.id AND o.run_id = NEW.run_id AND o.outcome_key = x.previous_outcome_key;
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
