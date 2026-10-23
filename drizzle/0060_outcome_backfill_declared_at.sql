-- COST-BACKFILL-1023-RUNS: a producer may declare the outcomes of a PAST run so
-- that, for allocation, consumption resolution and every stored day series, they
-- behave as if declared on time (owner 2026-10-23: « chaque service peut
-- rétro-engineerer pour estimer tous les coûts du passé pour être à 100 % now »).
--
-- run_outcomes.declared_at is now the occurrence's EFFECTIVE declaration time:
-- the bronze event's occurred_at (an on-time declaration: unchanged), or the
-- instant the producer stated (`occurredAt` in the body, bounded by its run),
-- carried per item in the payload. recorded_at = when runs-service recorded it
-- (the bronze event's occurred_at): the refresher keys "which stored day did a
-- late declaration move?" on it. Rows written before this migration were all
-- on time (recorded = declared), so recorded_at stays NULL for them and every
-- read uses COALESCE(recorded_at, declared_at): no UPDATE of the table at boot.
--
-- BOOT-WINDOW SAFE: one nullable column (metadata), one expression index on a
-- small table (~220k rows, 2026-10-23), one function replaced.

ALTER TABLE run_outcomes ADD COLUMN IF NOT EXISTS recorded_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_run_outcomes_recorded ON run_outcomes ((COALESCE(recorded_at, declared_at)));
--> statement-breakpoint
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
  ELSIF NEW.event_type = 'outcomes.voided' THEN
    DELETE FROM run_outcomes WHERE run_id = NEW.run_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
