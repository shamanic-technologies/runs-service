-- THREADS-IDEAS-AB / SUBTREE-COSTS-1101. Which support function covers each run, kept at WRITE time.
--
-- WHY. A support mark (run_support_marks, 0064) covers its run's whole subtree: a child of a marked
-- run is support too. GET /internal/runs/subtree-costs states it per run (`supportFunction`), and
-- computed it at read time by walking UP from every matched run: one random runs probe per run per
-- level. On the owner brand (83,584 lead-serve runs, 2026-10-31) that walk alone took ~118 s on a
-- loaded box, so the brand-wide read (30 s statement timeout) could never answer.
--
-- GRAIN. run_support_effective: one row per run covered by a mark, with the kind of the NEAREST
-- marked run among itself and its ancestors. No row = not support. The read is one PK probe.
--
-- WRITES.
-- - A run INSERTED under a covered parent inherits the parent's kind (AFTER INSERT on runs, one PK
--   probe). Its own mark, if any, arrives as a mark write below and wins.
-- - A mark written, changed or removed QUEUES its run (run_support_propagation_queue). The
--   in-process worker (services/support-effective.ts) recomputes that run's kind (own mark, else
--   the parent's) and rewrites its subtree down to the first descendant carrying its own mark,
--   in the background, TWICE (the second pass ~60 s later catches a child inserted while the
--   first pass ran, which inherited the old value).
-- - A run delete cascades its row (FK). Reparent: no writer does it (as 0086).
--
-- READINESS. Stamp `support_effective` (stats_rollups). The past is filled by
-- `scripts/backfill-support-effective.ts` (set-based, chunked by mark), which then stamps. Until the
-- stamp, reads keep the upward walk.
--
-- BOOT-WINDOW SAFE. Two empty tables, two functions, two triggers. No scan.

CREATE TABLE IF NOT EXISTS run_support_effective (
  run_id uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  kind text NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS run_support_propagation_queue (
  run_id uuid PRIMARY KEY,
  passes_left integer NOT NULL DEFAULT 2,
  due_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_run_support_propagation_queue_due ON run_support_propagation_queue (due_at);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION run_support_mark_enqueue() RETURNS trigger AS $$
DECLARE
  v_run uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_run := OLD.run_id;
  ELSE
    v_run := NEW.run_id;
  END IF;
  INSERT INTO run_support_propagation_queue (run_id, passes_left, due_at)
  VALUES (v_run, 2, now())
  ON CONFLICT (run_id) DO UPDATE SET passes_left = 2, due_at = now();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS run_support_mark_enqueue ON run_support_marks;
--> statement-breakpoint

CREATE TRIGGER run_support_mark_enqueue
  AFTER INSERT OR DELETE OR UPDATE OF kind ON run_support_marks
  FOR EACH ROW EXECUTE FUNCTION run_support_mark_enqueue();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION run_support_effective_inherit() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_run_id IS NOT NULL THEN
    INSERT INTO run_support_effective (run_id, kind)
    SELECT NEW.id, e.kind FROM run_support_effective e WHERE e.run_id = NEW.parent_run_id
    ON CONFLICT (run_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS run_support_effective_inherit ON runs;
--> statement-breakpoint

CREATE TRIGGER run_support_effective_inherit
  AFTER INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION run_support_effective_inherit();
