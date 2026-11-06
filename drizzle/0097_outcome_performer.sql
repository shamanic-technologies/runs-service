-- OUTCOME-PERFORMER-1106: every outcome occurrence may name WHO performed it
-- (owner 2026-11-06: "la provenance est clé pour les stats, mais doit être
-- stockée de façon généralisée, par outcome"). A declaring service states, per
-- PRODUCED occurrence, the performer: one of our scripts (its workflow slug),
-- the client's team, their CRM, the website tracker, a mailbox, the organic
-- market (+ an optional tool/channel name). Stored on silver, from bronze:
--   - `outcomes.declared` items carry performer_kind / performer_workflow_slug /
--     performer_name (absent = NULL, rows unchanged);
--   - `outcomes.performer_stated` (new) states it on occurrences ALREADY recorded
--     with none: set once, never overwritten (the handler refuses a different
--     performer with a 409; the projection only fills a NULL).
-- Cost allocation never reads these columns.
--
-- BOOT-WINDOW SAFE: nullable columns with no default (catalog-only change) and
-- CREATE OR REPLACE FUNCTION.

ALTER TABLE run_outcomes ADD COLUMN IF NOT EXISTS performer_kind text;
--> statement-breakpoint
ALTER TABLE run_outcomes ADD COLUMN IF NOT EXISTS performer_workflow_slug text;
--> statement-breakpoint
ALTER TABLE run_outcomes ADD COLUMN IF NOT EXISTS performer_name text;
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
