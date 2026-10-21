-- Two write-maintained rollups for the two fleet reads that ran for minutes on
-- the shared Postgres (prod 2026-10-22, load 30-50 on 8 cores).
--
-- 1. stats_rollup_root_cost — GET /internal/stats/task-outcomes.
--    The read prices each sampled run's WHOLE subtree (actual rows, gross). Live
--    it walked every descendant: 2.38M runs for api-service (55k sampled
--    `POST /v1/...` roots whose subtrees are whole campaign trees), 596k for
--    campaign-service (one campaign-trigger root alone holds 220k runs, a dead
--    scheduler-resume chain is 13,741 levels deep): 37 s to 225 s per call,
--    up to the 290 s ceiling. A TOP-LEVEL run's subtree is exactly the set of
--    runs whose top-level ancestor it is, so its actual cost is kept here at
--    write time, keyed by that ancestor. The read takes it for sampled runs with
--    no parent and still walks the (small) subtrees of the others.
--
--    GRAIN. One row per top-level run holding actual cost below it: n_actual =
--    actual cost rows in its subtree, gross_actual = their total_cost sum
--    (numeric, exact). A root with no actual cost has no row (the read's
--    COALESCE gives 0, as the walk did).
--
--    WALK-UP. A cost row finds its top-level ancestor by following parent_run_id
--    (PK lookups; 3-5 levels in today's trees). A run the walk cannot see (or an
--    ancestor it cannot see) means the run is being deleted: skip.
--
--    DELETES. A run is deleted (BEFORE DELETE, still visible) together with its
--    whole still-visible subtree's actual cost: a top-level run drops its row; a
--    non-top-level run subtracts its subtree from its ancestor's row. A
--    descendant deleted later in the same statement finds its chain broken and
--    skips (already subtracted); an ancestor deleted later only sees what is
--    left. The cascaded cost deletes find their run gone and skip. Exact in any
--    row order.
--
--    REPARENT (no writer does it today): the moved subtree's cost leaves the old
--    top-level ancestor's row and joins the new one's.
--
-- 2. stats_rollup_run_day + stats_rollup_platform_cost_day — GET /public/stats/runs.
--    The read counts EVERY run by UTC start day and status, and sums every
--    platform-projected cost by its run's UTC start day. Live that is an
--    aggregate over all 6M runs + 1.5M cost rows: 53 s in prod under load (the
--    planner now prefers a seq scan; the index-only plan took 66 s), past the
--    30 s statement_timeout. ~250 days x a few statuses here.
--
--    run_day: (day, status) -> run_count, every status (the read takes
--    completed / failed / running and keeps a day holding runs of any status).
--    platform_cost_day: day -> n_rows + gross of rows with is_platform_projected,
--    day NULL for a row without run_started_at (the read fails loud on it, as
--    the live read did).
--
-- READINESS. Stamps `root_cost` and `run_day`. On a database that already holds
-- runs the tables start EMPTY and each read keeps its live query until
-- `scripts/rebuild-stats-rollup.ts root_cost|run_day` has rebuilt and stamped it.
--
-- BOOT-WINDOW SAFE. Three empty tables, functions, triggers. No scan.

CREATE TABLE IF NOT EXISTS stats_rollup_root_cost (
  root_run_id uuid PRIMARY KEY,
  n_actual bigint NOT NULL DEFAULT 0,
  gross_actual numeric NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS stats_rollup_run_day (
  day date NOT NULL,
  status text NOT NULL,
  run_count bigint NOT NULL DEFAULT 0,
  CONSTRAINT stats_rollup_run_day_key PRIMARY KEY (day, status)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS stats_rollup_platform_cost_day (
  day date,
  n_rows bigint NOT NULL DEFAULT 0,
  gross numeric NOT NULL DEFAULT 0,
  CONSTRAINT stats_rollup_platform_cost_day_key UNIQUE NULLS NOT DISTINCT (day)
);
--> statement-breakpoint

-- Top-level ancestor of a run (the run itself when it has no parent); NULL when
-- the run or one of its ancestors is not visible (deleted in this statement).
CREATE OR REPLACE FUNCTION stats_rollup_root_of(p_run_id uuid) RETURNS uuid AS $$
DECLARE
  v_id uuid := p_run_id;
  v_parent uuid;
BEGIN
  LOOP
    SELECT parent_run_id INTO v_parent FROM runs WHERE id = v_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    IF v_parent IS NULL THEN
      RETURN v_id;
    END IF;
    v_id := v_parent;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_root_cost_add(p_root uuid, p_n bigint, p_gross numeric) RETURNS void AS $$
BEGIN
  INSERT INTO stats_rollup_root_cost (root_run_id, n_actual, gross_actual)
  VALUES (p_root, p_n, p_gross)
  ON CONFLICT (root_run_id) DO UPDATE SET
    n_actual     = stats_rollup_root_cost.n_actual     + EXCLUDED.n_actual,
    gross_actual = stats_rollup_root_cost.gross_actual + EXCLUDED.gross_actual;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Actual cost of a run's still-visible subtree (the run included). The child
-- fetch is fenced (OFFSET 0), the same plan rule as every run-tree walk here.
CREATE OR REPLACE FUNCTION stats_rollup_root_cost_subtree(p_run_id uuid, OUT n bigint, OUT gross numeric) AS $$
  WITH RECURSIVE d AS (
    SELECT p_run_id AS id
    UNION ALL
    SELECT ch.id FROM d CROSS JOIN LATERAL (SELECT c.id FROM runs c WHERE c.parent_run_id = d.id OFFSET 0) ch
  )
  SELECT count(*), COALESCE(SUM(rc.total_cost_in_usd_cents), 0)
  FROM d CROSS JOIN LATERAL (
    SELECT x.total_cost_in_usd_cents FROM runs_costs x WHERE x.run_id = d.id AND x.status = 'actual' OFFSET 0
  ) rc;
$$ LANGUAGE sql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_root_cost_on_run() RETURNS trigger AS $$
DECLARE
  v_old_root uuid;
  v_new_root uuid;
  s record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.parent_run_id IS NULL THEN
      DELETE FROM stats_rollup_root_cost WHERE root_run_id = OLD.id;
    ELSE
      v_old_root := stats_rollup_root_of(OLD.parent_run_id);
      IF v_old_root IS NOT NULL THEN
        SELECT * INTO s FROM stats_rollup_root_cost_subtree(OLD.id);
        IF s.n > 0 THEN
          PERFORM stats_rollup_root_cost_add(v_old_root, -s.n, -s.gross);
        END IF;
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE OF parent_run_id
  IF NEW.parent_run_id IS NOT DISTINCT FROM OLD.parent_run_id THEN
    RETURN NEW;
  END IF;
  v_old_root := CASE WHEN OLD.parent_run_id IS NULL THEN OLD.id ELSE stats_rollup_root_of(OLD.parent_run_id) END;
  v_new_root := CASE WHEN NEW.parent_run_id IS NULL THEN NEW.id ELSE stats_rollup_root_of(NEW.parent_run_id) END;
  IF v_old_root IS DISTINCT FROM v_new_root THEN
    SELECT * INTO s FROM stats_rollup_root_cost_subtree(NEW.id);
    IF s.n > 0 THEN
      IF v_old_root IS NOT NULL THEN
        PERFORM stats_rollup_root_cost_add(v_old_root, -s.n, -s.gross);
      END IF;
      IF v_new_root IS NOT NULL THEN
        PERFORM stats_rollup_root_cost_add(v_new_root, s.n, s.gross);
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_root_cost_on_cost() RETURNS trigger AS $$
DECLARE
  v_root uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status = 'actual' THEN
    -- Run gone = the cascade of a run delete, already accounted for.
    v_root := stats_rollup_root_of(OLD.run_id);
    IF v_root IS NOT NULL THEN
      PERFORM stats_rollup_root_cost_add(v_root, -1, -OLD.total_cost_in_usd_cents);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status = 'actual' THEN
    v_root := stats_rollup_root_of(NEW.run_id);
    IF v_root IS NOT NULL THEN
      PERFORM stats_rollup_root_cost_add(v_root, 1, NEW.total_cost_in_usd_cents);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_root_cost_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_root_cost_run_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_root_cost_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_root_cost_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_root_cost_run_update AFTER UPDATE OF parent_run_id ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_root_cost_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_root_cost_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_root_cost_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF run_id, status, total_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_root_cost_on_cost();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_run_day_add(p_started timestamptz, p_status text, p_delta bigint) RETURNS void AS $$
BEGIN
  INSERT INTO stats_rollup_run_day (day, status, run_count)
  VALUES ((p_started AT TIME ZONE 'UTC')::date, p_status, p_delta)
  ON CONFLICT ON CONSTRAINT stats_rollup_run_day_key DO UPDATE SET
    run_count = stats_rollup_run_day.run_count + EXCLUDED.run_count;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_run_day_on_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at THEN
      RETURN NULL;
    END IF;
    PERFORM stats_rollup_run_day_add(OLD.started_at, OLD.status, -1);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM stats_rollup_run_day_add(NEW.started_at, NEW.status, 1);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_platform_cost_day_add(p_run_started timestamptz, p_n bigint, p_gross numeric) RETURNS void AS $$
BEGIN
  INSERT INTO stats_rollup_platform_cost_day (day, n_rows, gross)
  VALUES ((p_run_started AT TIME ZONE 'UTC')::date, p_n, p_gross)
  ON CONFLICT ON CONSTRAINT stats_rollup_platform_cost_day_key DO UPDATE SET
    n_rows = stats_rollup_platform_cost_day.n_rows + EXCLUDED.n_rows,
    gross  = stats_rollup_platform_cost_day.gross  + EXCLUDED.gross;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- is_platform_projected is a STORED generated column: computed before AFTER
-- triggers, so OLD and NEW both carry it.
CREATE OR REPLACE FUNCTION stats_rollup_platform_cost_day_on_cost() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.is_platform_projected IS TRUE THEN
    PERFORM stats_rollup_platform_cost_day_add(OLD.run_started_at, -1, -OLD.total_cost_in_usd_cents);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.is_platform_projected IS TRUE THEN
    PERFORM stats_rollup_platform_cost_day_add(NEW.run_started_at, 1, NEW.total_cost_in_usd_cents);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_run_day_run_write ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_run_day_run_write
  AFTER INSERT OR DELETE OR UPDATE OF status, started_at ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_run_day_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_platform_cost_day_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_platform_cost_day_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF status, cost_source, total_cost_in_usd_cents, run_started_at ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_platform_cost_day_on_cost();
--> statement-breakpoint

INSERT INTO stats_rollups (name, ready_at)
SELECT 'root_cost', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint
INSERT INTO stats_rollups (name, ready_at)
SELECT 'run_day', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
