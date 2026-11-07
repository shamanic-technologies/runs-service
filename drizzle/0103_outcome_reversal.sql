-- LEDGER-REVERSAL-1107: the service that declared a produced occurrence takes it back as a
-- REVERSING ENTRY (industrial accounting: a counter-entry dated when the fact behind the Unit stopped
-- standing, history kept, never a delete). Prod 2026-11-07: lead-service declared 3 paid_client Units
-- of brand 75d7e3e8 on 2026-11-03 whose sale was withdrawn afterwards; the ledger kept counting them.
--
-- Door POST /v1/platform-runs/outcomes/reversals writes one bronze `outcomes.reversed` event per run
-- (items: occurrence id, reversed_at, reason, reversed_by), projected here into run_outcome_reversals.
-- Every count this service serves subtracts a reversed occurrence ON ITS REVERSAL DAY (the day
-- statement's produced_count, the performer stats): a range that ends before the reversal reads it,
-- a range that covers the reversal does not. The refresher re-stales exactly the reversal's UTC day.
--
-- A voided occurrence leaves run_outcomes: its reversal goes with it (FK cascade), so nothing is
-- subtracted twice.
--
-- BOOT-WINDOW SAFE: CREATE TABLE IF NOT EXISTS (empty, tiny) + CREATE OR REPLACE FUNCTION (same body
-- as 0101 + one branch).

CREATE TABLE IF NOT EXISTS run_outcome_reversals (
  occurrence_id uuid PRIMARY KEY REFERENCES run_outcomes(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  reversed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  reason text NOT NULL,
  reversed_by text NOT NULL,
  source_service text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_run_outcome_reversals_reversed_at ON run_outcome_reversals (reversed_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_run_outcome_reversals_recorded_at ON run_outcome_reversals (recorded_at);
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
  ELSIF NEW.event_type = 'outcomes.reversed' THEN
    -- LEDGER-REVERSAL-1107: a counter-entry, never a delete. The occurrence stays in run_outcomes
    -- (its declaration day keeps counting it); the reversal row makes every count drop by it from
    -- reversed_at on. Once per occurrence: a replayed event writes nothing.
    INSERT INTO run_outcome_reversals (occurrence_id, run_id, reversed_at, recorded_at, reason, reversed_by, source_service)
    SELECT x.id, NEW.run_id, x.reversed_at, NEW.occurred_at, x.reason, x.reversed_by, NEW.source_service
    FROM jsonb_to_recordset(NEW.payload->'items') AS x(id uuid, reversed_at timestamptz, reason text, reversed_by text)
    WHERE EXISTS (SELECT 1 FROM run_outcomes o WHERE o.id = x.id AND o.run_id = NEW.run_id)
    ON CONFLICT (occurrence_id) DO NOTHING;
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
