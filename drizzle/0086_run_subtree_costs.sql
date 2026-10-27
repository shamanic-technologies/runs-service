-- BOX-DB-LOAD-1027-RUNS. GET /v1/runs?include=subtreeCost was the heaviest statement of this
-- database: 89k calls / 1,041 min in ~23 h (2026-10-26 18:18 -> 10-27 17:20 UTC), ~0.7-1 s each,
-- one call a second. features-service's Research catalogue lists the newest 200 execute-workflow
-- runs per org per pipe with their subtree cost; each call walked ~1.7k runs (idx_runs_parent
-- probe + heap fetch + a runs_costs probe per walked run), all cold random reads on a box in swap.
-- A run's subtree cost only moves when a cost row of that subtree is written, so it is kept here
-- at WRITE time and the read becomes one primary-key probe per listed run.
--
-- GRAIN. One row per run with an actual or provisioned cost row anywhere in its subtree (itself
-- included): n_rows = those rows, gross_* = SUM(total_cost_in_usd_cents), net_* =
-- SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)), per status. Cancelled and
-- refunded rows are in no figure the read serves, so they are not kept. A run with no such row
-- has no row (the read's 0, as the walk's).
--
-- WALK-UP. A cost row adds its amounts to its run and to every ancestor (parent_run_id, PK
-- lookups; 0054's root_of already walks the same chain on every cost write). Rows are upserted
-- TOP-DOWN (root first): two transactions writing in the same tree meet on the root first, so one
-- waits there holding nothing below it, and a multi-row statement cannot deadlock a single write.
-- The walk stops at the first ancestor it cannot see (deleted in this statement): see DELETES.
--
-- DELETES. A run is deleted (BEFORE DELETE, still visible) with its still-visible subtree's
-- amounts: they leave its visible ancestors (up to the first one already deleted, which took them
-- with it), and its own row goes. A descendant deleted later finds its parent gone and only drops
-- its own row; one deleted earlier already took its part out. The cascaded cost deletes find
-- their run gone and skip. Exact in any row order (same rule as 0054).
--
-- REPARENT (no writer does it today): the moved subtree's amounts leave the old ancestors and
-- join the new ones.
--
-- READINESS. Stamp `subtree_cost`. A database holding runs starts EMPTY and the read keeps its
-- live walk until `scripts/rebuild-stats-rollup.ts subtree_cost` has rebuilt and stamped it.
--
-- BOOT-WINDOW SAFE. One empty table, functions, triggers. No scan.

CREATE TABLE IF NOT EXISTS run_subtree_costs (
  run_id uuid PRIMARY KEY,
  n_rows bigint NOT NULL DEFAULT 0,
  gross_actual numeric NOT NULL DEFAULT 0,
  gross_provisioned numeric NOT NULL DEFAULT 0,
  net_actual numeric NOT NULL DEFAULT 0,
  net_provisioned numeric NOT NULL DEFAULT 0
);
--> statement-breakpoint

-- The run and its ancestors, ROOT FIRST, up to the first one not visible. Empty when the run
-- itself is not visible.
CREATE OR REPLACE FUNCTION run_subtree_cost_chain(p_run_id uuid) RETURNS uuid[] AS $$
DECLARE
  v_id uuid := p_run_id;
  v_parent uuid;
  v_chain uuid[] := '{}';
BEGIN
  WHILE v_id IS NOT NULL LOOP
    SELECT parent_run_id INTO v_parent FROM runs WHERE id = v_id;
    EXIT WHEN NOT FOUND;
    v_chain := v_id || v_chain;
    v_id := v_parent;
  END LOOP;
  RETURN v_chain;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION run_subtree_cost_add(
  p_chain uuid[], p_n bigint, p_ga numeric, p_gp numeric, p_na numeric, p_np numeric
) RETURNS void AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_n = 0 AND p_ga = 0 AND p_gp = 0 AND p_na = 0 AND p_np = 0 THEN
    RETURN;
  END IF;
  FOREACH v_id IN ARRAY p_chain LOOP
    INSERT INTO run_subtree_costs (run_id, n_rows, gross_actual, gross_provisioned, net_actual, net_provisioned)
    VALUES (v_id, p_n, p_ga, p_gp, p_na, p_np)
    ON CONFLICT (run_id) DO UPDATE SET
      n_rows            = run_subtree_costs.n_rows            + EXCLUDED.n_rows,
      gross_actual      = run_subtree_costs.gross_actual      + EXCLUDED.gross_actual,
      gross_provisioned = run_subtree_costs.gross_provisioned + EXCLUDED.gross_provisioned,
      net_actual        = run_subtree_costs.net_actual        + EXCLUDED.net_actual,
      net_provisioned   = run_subtree_costs.net_provisioned   + EXCLUDED.net_provisioned;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Amounts of a run's still-visible subtree (the run included). Fenced child fetch and cost fetch
-- (OFFSET 0), the plan rule of every run-tree walk here.
CREATE OR REPLACE FUNCTION run_subtree_cost_live(
  p_run_id uuid, OUT n bigint, OUT ga numeric, OUT gp numeric, OUT na numeric, OUT np numeric
) AS $$
  WITH RECURSIVE d AS (
    SELECT p_run_id AS id
    UNION ALL
    SELECT ch.id FROM d CROSS JOIN LATERAL (SELECT c.id FROM runs c WHERE c.parent_run_id = d.id OFFSET 0) ch
  )
  SELECT count(*),
    COALESCE(SUM(CASE WHEN rc.status = 'actual'      THEN rc.total_cost_in_usd_cents ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN rc.status = 'provisioned' THEN rc.total_cost_in_usd_cents ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN rc.status = 'actual'      THEN COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN rc.status = 'provisioned' THEN COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) ELSE 0 END), 0)
  FROM d CROSS JOIN LATERAL (
    SELECT x.status, x.total_cost_in_usd_cents, x.net_cost_in_usd_cents
    FROM runs_costs x WHERE x.run_id = d.id AND x.status IN ('actual', 'provisioned') OFFSET 0
  ) rc;
$$ LANGUAGE sql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION run_subtree_cost_on_run() RETURNS trigger AS $$
DECLARE
  s record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.parent_run_id IS NOT NULL THEN
      SELECT * INTO s FROM run_subtree_cost_live(OLD.id);
      PERFORM run_subtree_cost_add(run_subtree_cost_chain(OLD.parent_run_id), -s.n, -s.ga, -s.gp, -s.na, -s.np);
    END IF;
    DELETE FROM run_subtree_costs WHERE run_id = OLD.id;
    RETURN OLD;
  END IF;

  -- UPDATE OF parent_run_id
  IF NEW.parent_run_id IS NOT DISTINCT FROM OLD.parent_run_id THEN
    RETURN NEW;
  END IF;
  SELECT * INTO s FROM run_subtree_cost_live(NEW.id);
  IF OLD.parent_run_id IS NOT NULL THEN
    PERFORM run_subtree_cost_add(run_subtree_cost_chain(OLD.parent_run_id), -s.n, -s.ga, -s.gp, -s.na, -s.np);
  END IF;
  IF NEW.parent_run_id IS NOT NULL THEN
    PERFORM run_subtree_cost_add(run_subtree_cost_chain(NEW.parent_run_id), s.n, s.ga, s.gp, s.na, s.np);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION run_subtree_cost_on_cost() RETURNS trigger AS $$
DECLARE
  o_n bigint := 0; o_ga numeric := 0; o_gp numeric := 0; o_na numeric := 0; o_np numeric := 0;
  n_n bigint := 0; n_ga numeric := 0; n_gp numeric := 0; n_na numeric := 0; n_np numeric := 0;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status IN ('actual', 'provisioned') THEN
    o_n := 1;
    IF OLD.status = 'actual' THEN
      o_ga := OLD.total_cost_in_usd_cents; o_na := COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents);
    ELSE
      o_gp := OLD.total_cost_in_usd_cents; o_np := COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status IN ('actual', 'provisioned') THEN
    n_n := 1;
    IF NEW.status = 'actual' THEN
      n_ga := NEW.total_cost_in_usd_cents; n_na := COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents);
    ELSE
      n_gp := NEW.total_cost_in_usd_cents; n_np := COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents);
    END IF;
  END IF;

  -- Same run: one net delta, one walk (materialize = provisioned -> actual).
  IF TG_OP = 'UPDATE' AND NEW.run_id = OLD.run_id THEN
    PERFORM run_subtree_cost_add(run_subtree_cost_chain(NEW.run_id),
      n_n - o_n, n_ga - o_ga, n_gp - o_gp, n_na - o_na, n_np - o_np);
    RETURN NULL;
  END IF;
  -- Run gone = the cascade of a run delete, already accounted for (empty chain).
  IF o_n > 0 THEN
    PERFORM run_subtree_cost_add(run_subtree_cost_chain(OLD.run_id), -o_n, -o_ga, -o_gp, -o_na, -o_np);
  END IF;
  IF n_n > 0 THEN
    PERFORM run_subtree_cost_add(run_subtree_cost_chain(NEW.run_id), n_n, n_ga, n_gp, n_na, n_np);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS run_subtree_cost_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER run_subtree_cost_run_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION run_subtree_cost_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS run_subtree_cost_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER run_subtree_cost_run_update AFTER UPDATE OF parent_run_id ON runs
  FOR EACH ROW EXECUTE FUNCTION run_subtree_cost_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS run_subtree_cost_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER run_subtree_cost_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF run_id, status, total_cost_in_usd_cents, net_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION run_subtree_cost_on_cost();
--> statement-breakpoint

INSERT INTO stats_rollups (name, ready_at)
SELECT 'subtree_cost', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
