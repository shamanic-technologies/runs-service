-- (cost row's org, run's brand set, cost row's UTC day, cost name, cost source)
-- rollup for GET /internal/stats/costs/consumption — costs-service's daily
-- real-cost refresh reads it grouped by org and by org+brand since inception.
--
-- WHY. Live, the read scanned every charged/refunded cost row (1.82M) and, grouped
-- by brand, hash-joined them to the whole runs table (7M rows, 8.8 GB): 6 s / 28 s
-- on a load-15 box, 89 s at load 30. Past the stats pool's 30 s statement timeout
-- every attempt 500'd from 2026-10-16 to 2026-10-29, so the billed catalogue stopped
-- following real costs (costs-service real_cost_refreshes).
--
-- GRAIN. Exactly the live read's row set and figures: rows with status 'actual' or
-- 'refunded', org = the COST ROW's frozen org, day = the cost row's created_at UTC
-- day, brand = the run's brand_ids kept AS AN ARRAY (179 distinct sets in prod) and
-- unnested at read time, so a co-branded row still counts under each brand and an
-- org read sums the sets back. `n` counts the matched rows: a group whose rows all
-- left (refund reversed, row moved) is n = 0 and served by no read.
--
-- TRIGGERS (0053's shape). A cost write takes OLD out of / puts NEW into its group,
-- resolving the run's brand set by primary key; a run gone = the cascade of a run
-- delete, already taken out by the run's BEFORE DELETE trigger. A run whose brand
-- set changes (brand transfer) moves its counted rows between sets.
--
-- READINESS. Stamp `consumption_day`. On a database that already holds cost rows
-- the table starts EMPTY and the read stays live until
-- `scripts/rebuild-stats-rollup.ts consumption_day` has rebuilt and stamped it.
--
-- BOOT-WINDOW SAFE. One empty table, functions, triggers.

CREATE TABLE IF NOT EXISTS stats_rollup_consumption_day (
  organization_id uuid,
  brand_ids text[],
  day date NOT NULL,
  cost_name text NOT NULL,
  cost_source text NOT NULL,
  n bigint NOT NULL DEFAULT 0,
  quantity numeric NOT NULL DEFAULT 0,
  refunded_quantity numeric NOT NULL DEFAULT 0,
  billed numeric NOT NULL DEFAULT 0,
  net_billed numeric NOT NULL DEFAULT 0,
  refunded numeric NOT NULL DEFAULT 0,
  net_refunded numeric NOT NULL DEFAULT 0,
  CONSTRAINT stats_rollup_consumption_day_key
    UNIQUE NULLS NOT DISTINCT (organization_id, brand_ids, day, cost_name, cost_source)
);
--> statement-breakpoint

-- Add (p_sign = 1) or remove (p_sign = -1) counted cost rows. Atomic status literals only.
CREATE OR REPLACE FUNCTION stats_rollup_consumption_add(
  p_org uuid, p_brands text[], p_day date, p_name text, p_source text, p_status text,
  p_count bigint, p_qty numeric, p_gross numeric, p_net numeric
) RETURNS void AS $$
BEGIN
  IF p_status IN ('actual', 'refunded') THEN
    INSERT INTO stats_rollup_consumption_day (
      organization_id, brand_ids, day, cost_name, cost_source,
      n, quantity, refunded_quantity, billed, net_billed, refunded, net_refunded
    ) VALUES (
      p_org, p_brands, p_day, p_name, p_source,
      p_count, p_qty,
      CASE WHEN p_status = 'refunded' THEN p_qty ELSE 0 END,
      CASE WHEN p_status = 'actual'   THEN p_gross ELSE 0 END,
      CASE WHEN p_status = 'actual'   THEN p_net ELSE 0 END,
      CASE WHEN p_status = 'refunded' THEN p_gross ELSE 0 END,
      CASE WHEN p_status = 'refunded' THEN p_net ELSE 0 END
    )
    ON CONFLICT ON CONSTRAINT stats_rollup_consumption_day_key DO UPDATE SET
      n                 = stats_rollup_consumption_day.n                 + EXCLUDED.n,
      quantity          = stats_rollup_consumption_day.quantity          + EXCLUDED.quantity,
      refunded_quantity = stats_rollup_consumption_day.refunded_quantity + EXCLUDED.refunded_quantity,
      billed            = stats_rollup_consumption_day.billed            + EXCLUDED.billed,
      net_billed        = stats_rollup_consumption_day.net_billed        + EXCLUDED.net_billed,
      refunded          = stats_rollup_consumption_day.refunded          + EXCLUDED.refunded,
      net_refunded      = stats_rollup_consumption_day.net_refunded      + EXCLUDED.net_refunded;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Move every counted cost row of one run into (p_sign = 1) or out of (-1) the given brand set.
CREATE OR REPLACE FUNCTION stats_rollup_consumption_move_run(p_run_id uuid, p_brands text[], p_sign bigint)
RETURNS void AS $$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT organization_id, (created_at AT TIME ZONE 'UTC')::date AS day, cost_name, cost_source, status,
      count(*) AS n, SUM(quantity) AS qty, SUM(total_cost_in_usd_cents) AS gross,
      SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) AS net
    FROM runs_costs
    WHERE run_id = p_run_id AND status IN ('actual', 'refunded')
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY 1, 2, 3, 4, 5
  LOOP
    PERFORM stats_rollup_consumption_add(g.organization_id, p_brands, g.day, g.cost_name, g.cost_source, g.status,
      p_sign * g.n, p_sign * g.qty, p_sign * g.gross, p_sign * g.net);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_consumption_on_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.brand_ids IS DISTINCT FROM OLD.brand_ids THEN
      PERFORM stats_rollup_consumption_move_run(NEW.id, OLD.brand_ids, -1);
      PERFORM stats_rollup_consumption_move_run(NEW.id, NEW.brand_ids, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: the run and its cost rows are still visible (their own
    -- cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_consumption_move_run(OLD.id, OLD.brand_ids, -1);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_consumption_on_cost() RETURNS trigger AS $$
DECLARE
  v_brands text[];
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status IN ('actual', 'refunded') THEN
    SELECT brand_ids INTO v_brands FROM runs WHERE id = OLD.run_id;
    -- Run gone = the cascade of a run delete, already taken out.
    IF FOUND THEN
      PERFORM stats_rollup_consumption_add(OLD.organization_id, v_brands, (OLD.created_at AT TIME ZONE 'UTC')::date,
        OLD.cost_name, OLD.cost_source, OLD.status, -1, -OLD.quantity, -OLD.total_cost_in_usd_cents,
        -COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents));
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status IN ('actual', 'refunded') THEN
    SELECT brand_ids INTO v_brands FROM runs WHERE id = NEW.run_id;
    IF FOUND THEN
      PERFORM stats_rollup_consumption_add(NEW.organization_id, v_brands, (NEW.created_at AT TIME ZONE 'UTC')::date,
        NEW.cost_name, NEW.cost_source, NEW.status, 1, NEW.quantity, NEW.total_cost_in_usd_cents,
        COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents));
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_consumption_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_consumption_run_update
  AFTER UPDATE OF brand_ids ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_consumption_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_consumption_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_consumption_run_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_consumption_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_consumption_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_consumption_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF run_id, organization_id, cost_name, cost_source, status, created_at,
    quantity, total_cost_in_usd_cents, net_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_consumption_on_cost();
--> statement-breakpoint

-- Fresh database: nothing to backfill, the triggers see every row from the first.
INSERT INTO stats_rollups (name, ready_at)
SELECT 'consumption_day', now()
WHERE NOT EXISTS (SELECT 1 FROM runs_costs)
ON CONFLICT (name) DO NOTHING;
