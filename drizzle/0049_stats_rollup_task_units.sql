-- (UTC day of run start, org, service, task, asking service, cost name, cost
-- source) rollup of CHARGED cost rows, for GET /internal/stats/costs/task-units.
--
-- WHY. The staff Research page states, fleet-wide since inception, how many
-- typed judgments (chat-service judgments / platform-judgments runs) were billed
-- per month and per asking service (the PARENT run's service), for how many
-- orgs, how many input tokens and how many cents; and what one Apollo reveal
-- (apollo-service enrichment, cost apollo-credit) was billed. Live that is a
-- seq scan of every run (5.7M) + one cost probe and one parent probe per
-- matching run: 124 s in prod (2026-10-18), and it grows with the ledger. So it
-- is maintained at WRITE time.
--
-- GRAIN. One row per (day, organization_id, service_name, task_name,
-- parent_service_name, cost_name, cost_source), status 'actual' rows only (what
-- was charged): run_count = runs holding at least one such row under that key,
-- n_actual = rows, quantity / gross / net = their sums. day = the RUN's
-- started_at as a UTC date, so a run sits under exactly one day whatever the
-- dates of its cost rows. organization_id = the run's org (NULL for org-less
-- platform runs, its own group). parent_service_name = the parent run's
-- service_name (NULL for a root run). NULLs are real groups.
--
-- RUN COUNT. A row entering the charged set adds a run only when no OTHER
-- charged row of the same run already sits under its (cost_name, cost_source);
-- a row leaving removes it only when none remains. Each trigger upserts the key
-- row FIRST (taking its lock) and checks the other rows in a LATER statement,
-- whose fresh snapshot sees whatever a concurrent writer of the same run
-- committed (0035's lock-then-read rule). Summing run_count across cost names
-- counts a run once per cost name it was charged under.
--
-- PARENT SERVICE. A parent run cannot be deleted while a child references it
-- (FK without cascade) and no writer changes a run's service_name, so the
-- asking service of a run is fixed once it exists. A parent_run_id change on
-- the child moves it like any key change.
--
-- READINESS. Stamp `task_units`. On a database that already holds runs the
-- table starts EMPTY and the read answers 503 until
-- `scripts/rebuild-stats-rollup.ts task_units` has rebuilt and stamped it.
--
-- BOOT-WINDOW SAFE. One empty table, functions, triggers. No scan.

CREATE TABLE IF NOT EXISTS stats_rollup_task_units (
  day date NOT NULL,
  organization_id uuid,
  service_name text NOT NULL,
  task_name text NOT NULL,
  parent_service_name text,
  cost_name text NOT NULL,
  cost_source text NOT NULL,
  run_count bigint NOT NULL DEFAULT 0,
  n_actual bigint NOT NULL DEFAULT 0,
  quantity numeric NOT NULL DEFAULT 0,
  gross_actual numeric NOT NULL DEFAULT 0,
  net_actual numeric NOT NULL DEFAULT 0,
  CONSTRAINT stats_rollup_task_units_key
    UNIQUE NULLS NOT DISTINCT (service_name, task_name, day, organization_id, parent_service_name, cost_name, cost_source)
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_task_units_add(
  p_started timestamptz, p_org uuid, p_service text, p_task text, p_parent_service text,
  p_cost_name text, p_cost_source text,
  p_runs bigint, p_n bigint, p_quantity numeric, p_gross numeric, p_net numeric
) RETURNS void AS $$
BEGIN
  INSERT INTO stats_rollup_task_units (
    day, organization_id, service_name, task_name, parent_service_name, cost_name, cost_source,
    run_count, n_actual, quantity, gross_actual, net_actual
  ) VALUES (
    (p_started AT TIME ZONE 'UTC')::date, p_org, p_service, p_task, p_parent_service, p_cost_name, p_cost_source,
    p_runs, p_n, p_quantity, p_gross, p_net
  )
  ON CONFLICT ON CONSTRAINT stats_rollup_task_units_key DO UPDATE SET
    run_count    = stats_rollup_task_units.run_count    + EXCLUDED.run_count,
    n_actual     = stats_rollup_task_units.n_actual     + EXCLUDED.n_actual,
    quantity     = stats_rollup_task_units.quantity     + EXCLUDED.quantity,
    gross_actual = stats_rollup_task_units.gross_actual + EXCLUDED.gross_actual,
    net_actual   = stats_rollup_task_units.net_actual   + EXCLUDED.net_actual;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Move every charged cost row of one run out of (p_sign = -1) or into
-- (p_sign = 1) the keys of the given run identity: one run per (cost name, source).
CREATE OR REPLACE FUNCTION stats_rollup_task_units_move_run(
  p_run_id uuid, p_started timestamptz, p_org uuid, p_service text, p_task text, p_parent_run_id uuid, p_sign bigint
) RETURNS void AS $$
DECLARE
  g record;
  v_parent_service text;
BEGIN
  SELECT service_name INTO v_parent_service FROM runs WHERE id = p_parent_run_id;
  FOR g IN
    SELECT cost_name, cost_source, count(*) AS n, SUM(quantity) AS quantity,
      SUM(total_cost_in_usd_cents) AS gross,
      SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) AS net
    FROM runs_costs WHERE run_id = p_run_id AND status = 'actual'
    GROUP BY cost_name, cost_source
  LOOP
    PERFORM stats_rollup_task_units_add(p_started, p_org, p_service, p_task, v_parent_service,
      g.cost_name, g.cost_source, p_sign, p_sign * g.n, p_sign * g.quantity, p_sign * g.gross, p_sign * g.net);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_task_units_on_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.service_name IS DISTINCT FROM OLD.service_name
       OR NEW.task_name IS DISTINCT FROM OLD.task_name
       OR NEW.parent_run_id IS DISTINCT FROM OLD.parent_run_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      PERFORM stats_rollup_task_units_move_run(NEW.id, OLD.started_at, OLD.organization_id, OLD.service_name, OLD.task_name, OLD.parent_run_id, -1);
      PERFORM stats_rollup_task_units_move_run(NEW.id, NEW.started_at, NEW.organization_id, NEW.service_name, NEW.task_name, NEW.parent_run_id, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: the run is still visible, so its cost rows are removed here
    -- (their own cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_task_units_move_run(OLD.id, OLD.started_at, OLD.organization_id, OLD.service_name, OLD.task_name, OLD.parent_run_id, -1);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_task_units_on_cost() RETURNS trigger AS $$
DECLARE
  r record;
  v_parent_service text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status = 'actual' THEN
    SELECT organization_id, service_name, task_name, parent_run_id, started_at INTO r FROM runs WHERE id = OLD.run_id;
    -- Run gone = this delete is the cascade of a run delete, already accounted for.
    IF FOUND THEN
      SELECT service_name INTO v_parent_service FROM runs WHERE id = r.parent_run_id;
      PERFORM stats_rollup_task_units_add(r.started_at, r.organization_id, r.service_name, r.task_name, v_parent_service,
        OLD.cost_name, OLD.cost_source, 0, -1, -OLD.quantity, -OLD.total_cost_in_usd_cents,
        -COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents));
      IF NOT EXISTS (
        SELECT 1 FROM runs_costs
        WHERE run_id = OLD.run_id AND status = 'actual' AND cost_name = OLD.cost_name
          AND cost_source = OLD.cost_source AND id <> OLD.id
      ) THEN
        PERFORM stats_rollup_task_units_add(r.started_at, r.organization_id, r.service_name, r.task_name, v_parent_service,
          OLD.cost_name, OLD.cost_source, -1, 0, 0, 0, 0);
      END IF;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status = 'actual' THEN
    SELECT organization_id, service_name, task_name, parent_run_id, started_at INTO r FROM runs WHERE id = NEW.run_id;
    IF FOUND THEN
      SELECT service_name INTO v_parent_service FROM runs WHERE id = r.parent_run_id;
      PERFORM stats_rollup_task_units_add(r.started_at, r.organization_id, r.service_name, r.task_name, v_parent_service,
        NEW.cost_name, NEW.cost_source, 0, 1, NEW.quantity, NEW.total_cost_in_usd_cents,
        COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents));
      IF NOT EXISTS (
        SELECT 1 FROM runs_costs
        WHERE run_id = NEW.run_id AND status = 'actual' AND cost_name = NEW.cost_name
          AND cost_source = NEW.cost_source AND id <> NEW.id
      ) THEN
        PERFORM stats_rollup_task_units_add(r.started_at, r.organization_id, r.service_name, r.task_name, v_parent_service,
          NEW.cost_name, NEW.cost_source, 1, 0, 0, 0, 0);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_task_units_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_task_units_run_update
  AFTER UPDATE OF organization_id, service_name, task_name, parent_run_id, started_at ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_task_units_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_task_units_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_task_units_run_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_task_units_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_task_units_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_task_units_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF run_id, status, cost_name, cost_source, quantity, total_cost_in_usd_cents, net_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_task_units_on_cost();
--> statement-breakpoint

INSERT INTO stats_rollups (name, ready_at)
SELECT 'task_units', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
