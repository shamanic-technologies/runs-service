-- SUBTREE-COSTS-1101. Each run's whole-subtree ACTUAL cost rows, grouped per price key, kept at
-- write time, so GET /internal/runs/subtree-costs prices the vendor basis without walking.
--
-- WHY. 0086 keeps billed + net per subtree, but the vendor basis prices each cost row by the
-- costs-service version in force when it was written, so the read still walked every costed
-- subtree: on the owner brand (86k lead-serve runs, 22k with cost) the walk and the ledger fetch
-- took ~23 s warm, ~24 s cold (2026-11-01), over the 30 s statement timeout with the rest.
--
-- GRAIN. One row per (run, cost name, billed unit price, cost-row UTC HOUR) over the actual rows of
-- the run's subtree (itself included): n, SUM(quantity), SUM(total_cost_in_usd_cents). A version is
-- matched on (cost name, billed unit) and a validity window; an hour holding a version's
-- served-from instant STRADDLES it, and the read re-prices that run from the ledger (0051's rule:
-- with the hour grain that is a handful of runs). Σ(q·v) = (Σq)·v exactly in numeric, so the
-- figures equal the ledger walk's to the digit.
--
-- WRITES. Same walk-up as 0086 (run_subtree_cost_chain, ROOT FIRST): a cost write moves its
-- delta to its run and every ancestor; a run delete (BEFORE, still visible) takes its live subtree
-- out of its visible ancestors and drops its own rows; a reparent moves the live subtree.
--
-- READINESS. Stamp `subtree_cost_items`, set by `scripts/rebuild-stats-rollup.ts subtree_cost_items`
-- (snapshot protocol, stats-rollup.ts). Until then the read walks, as before.
--
-- BOOT-WINDOW SAFE. One empty table, functions, triggers. No scan.

CREATE TABLE IF NOT EXISTS run_subtree_cost_items (
  run_id uuid NOT NULL,
  cost_name text NOT NULL,
  unit numeric NOT NULL,
  cost_hour timestamptz NOT NULL,
  n bigint NOT NULL DEFAULT 0,
  qty numeric NOT NULL DEFAULT 0,
  gross numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, cost_name, unit, cost_hour)
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION run_subtree_cost_items_add(
  p_chain uuid[], p_name text, p_unit numeric, p_hour timestamptz, p_n bigint, p_qty numeric, p_gross numeric
) RETURNS void AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_n = 0 AND p_qty = 0 AND p_gross = 0 THEN
    RETURN;
  END IF;
  FOREACH v_id IN ARRAY p_chain LOOP
    INSERT INTO run_subtree_cost_items (run_id, cost_name, unit, cost_hour, n, qty, gross)
    VALUES (v_id, p_name, p_unit, p_hour, p_n, p_qty, p_gross)
    ON CONFLICT (run_id, cost_name, unit, cost_hour) DO UPDATE SET
      n     = run_subtree_cost_items.n     + EXCLUDED.n,
      qty   = run_subtree_cost_items.qty   + EXCLUDED.qty,
      gross = run_subtree_cost_items.gross + EXCLUDED.gross;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Items of a run's still-visible subtree (the run included). Fenced child and cost fetches.
CREATE OR REPLACE FUNCTION run_subtree_cost_items_live(p_run_id uuid)
RETURNS TABLE (cost_name text, unit numeric, cost_hour timestamptz, n bigint, qty numeric, gross numeric) AS $$
  WITH RECURSIVE d AS (
    SELECT p_run_id AS id
    UNION ALL
    SELECT ch.id FROM d CROSS JOIN LATERAL (SELECT c.id FROM runs c WHERE c.parent_run_id = d.id OFFSET 0) ch
  )
  SELECT rc.cost_name, rc.unit_cost_in_usd_cents, date_trunc('hour', rc.created_at, 'UTC'),
    count(*), SUM(rc.quantity), SUM(rc.total_cost_in_usd_cents)
  FROM d CROSS JOIN LATERAL (
    SELECT x.cost_name, x.unit_cost_in_usd_cents, x.created_at, x.quantity, x.total_cost_in_usd_cents
    FROM runs_costs x WHERE x.run_id = d.id AND x.status = 'actual' OFFSET 0
  ) rc
  GROUP BY 1, 2, 3;
$$ LANGUAGE sql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION run_subtree_cost_items_on_run() RETURNS trigger AS $$
DECLARE
  s record;
  v_old uuid[];
  v_new uuid[];
  v_skip boolean;
BEGIN
  -- Stamped, a run with no item row has no actual cost row below it: nothing to move, no walk
  -- (most deleted runs; the walk per run made a 5,000-run delete ~45% slower). Unstamped (a
  -- rebuild cleared the table), always walk: the live subtree is the only exact delta then.
  v_skip := EXISTS (SELECT 1 FROM stats_rollups WHERE name = 'subtree_cost_items')
    AND NOT EXISTS (SELECT 1 FROM run_subtree_cost_items WHERE run_id = COALESCE(NEW.id, OLD.id));
  IF TG_OP = 'DELETE' THEN
    IF OLD.parent_run_id IS NOT NULL AND NOT v_skip THEN
      v_old := run_subtree_cost_chain(OLD.parent_run_id);
      FOR s IN SELECT * FROM run_subtree_cost_items_live(OLD.id) LOOP
        PERFORM run_subtree_cost_items_add(v_old, s.cost_name, s.unit, s.cost_hour, -s.n, -s.qty, -s.gross);
      END LOOP;
    END IF;
    DELETE FROM run_subtree_cost_items WHERE run_id = OLD.id;
    RETURN OLD;
  END IF;

  -- UPDATE OF parent_run_id
  IF NEW.parent_run_id IS NOT DISTINCT FROM OLD.parent_run_id OR v_skip THEN
    RETURN NEW;
  END IF;
  IF OLD.parent_run_id IS NOT NULL THEN v_old := run_subtree_cost_chain(OLD.parent_run_id); END IF;
  IF NEW.parent_run_id IS NOT NULL THEN v_new := run_subtree_cost_chain(NEW.parent_run_id); END IF;
  FOR s IN SELECT * FROM run_subtree_cost_items_live(NEW.id) LOOP
    IF v_old IS NOT NULL THEN
      PERFORM run_subtree_cost_items_add(v_old, s.cost_name, s.unit, s.cost_hour, -s.n, -s.qty, -s.gross);
    END IF;
    IF v_new IS NOT NULL THEN
      PERFORM run_subtree_cost_items_add(v_new, s.cost_name, s.unit, s.cost_hour, s.n, s.qty, s.gross);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION run_subtree_cost_items_on_cost() RETURNS trigger AS $$
BEGIN
  -- A row whose run is gone (the cascade of a run delete) walks an empty chain: already accounted for.
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status = 'actual' THEN
    PERFORM run_subtree_cost_items_add(run_subtree_cost_chain(OLD.run_id), OLD.cost_name,
      OLD.unit_cost_in_usd_cents, date_trunc('hour', OLD.created_at, 'UTC'), -1, -OLD.quantity, -OLD.total_cost_in_usd_cents);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status = 'actual' THEN
    PERFORM run_subtree_cost_items_add(run_subtree_cost_chain(NEW.run_id), NEW.cost_name,
      NEW.unit_cost_in_usd_cents, date_trunc('hour', NEW.created_at, 'UTC'), 1, NEW.quantity, NEW.total_cost_in_usd_cents);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS run_subtree_cost_items_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER run_subtree_cost_items_run_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION run_subtree_cost_items_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS run_subtree_cost_items_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER run_subtree_cost_items_run_update AFTER UPDATE OF parent_run_id ON runs
  FOR EACH ROW EXECUTE FUNCTION run_subtree_cost_items_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS run_subtree_cost_items_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER run_subtree_cost_items_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF run_id, status, cost_name, quantity, unit_cost_in_usd_cents, total_cost_in_usd_cents, created_at
  ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION run_subtree_cost_items_on_cost();
--> statement-breakpoint

INSERT INTO stats_rollups (name, ready_at)
SELECT 'subtree_cost_items', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
