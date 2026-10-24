-- SUBJECT-EQUIVALENCE-1024: one occurrence, two subject spaces. The service that
-- OWNS a subject states "my subject X is the same subject as Y" (e.g.
-- transactional-email-service: mailing-list subscriber S == lead-service lead L,
-- it alone knows subscriber -> email and resolves the lead through
-- lead-service), so a consumption under S places on a production declared under
-- L without anyone declaring twice. The ledger never infers it.
--
-- One hop: a target is never itself a source, and a source is never a target
-- (the canonical subject of X is its target, else X). Rows are immutable: the
-- table is its own append-only log (who stated it, why, when).
--
-- BOOT-WINDOW SAFE: a new empty table.

CREATE TABLE IF NOT EXISTS subject_equivalences (
  subject_service text NOT NULL,
  subject_id text NOT NULL,
  target_service text NOT NULL,
  target_id text NOT NULL,
  stated_by text NOT NULL,
  reason text NOT NULL,
  stated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_service, subject_id),
  CHECK (NOT (subject_service = target_service AND subject_id = target_id))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subject_equivalences_target ON subject_equivalences (target_service, target_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subject_equivalences_stated ON subject_equivalences (stated_at);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subject_equivalences_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'subject_equivalences rows are immutable';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_subject_equivalences_immutable ON subject_equivalences;
--> statement-breakpoint
CREATE TRIGGER trg_subject_equivalences_immutable BEFORE UPDATE OR DELETE ON subject_equivalences
FOR EACH ROW EXECUTE FUNCTION subject_equivalences_immutable();
