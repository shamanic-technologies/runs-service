-- Migration 0050's rollup, with the cost row's own UTC hour added to the grain.
--
-- WHY. Read from 0050's grain, the grouped vendor read timed out in prod
-- (2026-10-18): a group spans every cost row of one run-start day, and an
-- Instantly send is written up to 44 days after its run started, so 294 groups
-- of the cold email feature straddled a served-from instant (30,866 rows) and
-- were each re-read from the ledger by a per-group probe of that day's runs.
-- With cost_hour in the grain a group spans at most one UTC hour of cost rows:
-- 59.7k groups fleet-wide (was 23k), and 2 straddling groups of 64 rows in one
-- hour for the same feature, read in one pass over that hour. (A DAY grain still
-- left 94 groups / 1,744 rows whose ledger re-read took ~20 s cold.)
--
-- 0050's table is replaced (its stamp was removed by hand after the timeout, so
-- no read uses it): same name, same readiness stamp, rebuilt by
-- `scripts/rebuild-stats-rollup.ts campaign_cost_items`. Same trigger doctrine as
-- 0050 (see its header): bounds never narrow, NULLs are real groups.
--
-- BOOT-WINDOW SAFE. Drops a table no read uses, creates an empty one. No scan.

DROP TRIGGER IF EXISTS stats_rollup_campaign_cost_items_run_update ON runs;
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_campaign_cost_items_run_delete ON runs;
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_campaign_cost_items_cost_write ON runs_costs;
--> statement-breakpoint
DROP FUNCTION IF EXISTS stats_rollup_campaign_cost_items_on_run();
--> statement-breakpoint
DROP FUNCTION IF EXISTS stats_rollup_campaign_cost_items_on_cost();
--> statement-breakpoint
DROP FUNCTION IF EXISTS stats_rollup_campaign_cost_items_move_run(uuid, text, timestamptz, uuid, text[], text, text, bigint);
--> statement-breakpoint
DROP FUNCTION IF EXISTS stats_rollup_campaign_cost_items_add(text, timestamptz, uuid, text[], text, text, text, text, text, numeric, bigint, numeric, numeric, timestamptz, timestamptz);
--> statement-breakpoint
DROP TABLE IF EXISTS stats_rollup_campaign_cost_items;
--> statement-breakpoint
DELETE FROM stats_rollups WHERE name = 'campaign_cost_items';
--> statement-breakpoint

CREATE TABLE stats_rollup_campaign_cost_items (
  campaign_id text,
  day date NOT NULL,
  organization_id uuid,
  brand_ids text[],
  feature_slug text,
  workflow_slug text,
  cost_source text NOT NULL,
  status text NOT NULL,
  cost_name text NOT NULL,
  unit_cost_in_usd_cents numeric(16,10) NOT NULL,
  cost_hour timestamp NOT NULL, -- date_trunc('hour', created_at AT TIME ZONE 'UTC')
  n bigint NOT NULL DEFAULT 0,
  quantity numeric NOT NULL DEFAULT 0,
  gross numeric NOT NULL DEFAULT 0,
  min_created_at timestamptz,
  max_created_at timestamptz,
  CONSTRAINT stats_rollup_campaign_cost_items_key
    UNIQUE NULLS NOT DISTINCT (campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug,
      cost_source, status, cost_name, unit_cost_in_usd_cents, cost_hour)
);
--> statement-breakpoint

-- Add (p_n > 0) or remove (p_n < 0) cost rows written in p_cost_hour to one
-- group. Removal passes NULL bounds: LEAST/GREATEST ignore NULL, so the stored
-- bounds never narrow. Atomic status literals only (cost predicate doctrine).
CREATE OR REPLACE FUNCTION stats_rollup_campaign_cost_items_add(
  p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text,
  p_source text, p_status text, p_cost_name text, p_unit numeric, p_cost_hour timestamp,
  p_n bigint, p_quantity numeric, p_gross numeric, p_min timestamptz, p_max timestamptz
) RETURNS void AS $$
BEGIN
  IF p_status NOT IN ('actual', 'provisioned', 'refunded') THEN
    RETURN;
  END IF;
  INSERT INTO stats_rollup_campaign_cost_items (
    campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug,
    cost_source, status, cost_name, unit_cost_in_usd_cents, cost_hour,
    n, quantity, gross, min_created_at, max_created_at
  ) VALUES (
    p_campaign, (p_started AT TIME ZONE 'UTC')::date, p_org, p_brands, p_feature, p_workflow,
    p_source, p_status, p_cost_name, p_unit, p_cost_hour,
    p_n, p_quantity, p_gross, p_min, p_max
  )
  ON CONFLICT ON CONSTRAINT stats_rollup_campaign_cost_items_key DO UPDATE SET
    n              = stats_rollup_campaign_cost_items.n + EXCLUDED.n,
    quantity       = stats_rollup_campaign_cost_items.quantity + EXCLUDED.quantity,
    gross          = stats_rollup_campaign_cost_items.gross + EXCLUDED.gross,
    min_created_at = LEAST(stats_rollup_campaign_cost_items.min_created_at, EXCLUDED.min_created_at),
    max_created_at = GREATEST(stats_rollup_campaign_cost_items.max_created_at, EXCLUDED.max_created_at);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Move every cost row of one run into (p_sign = 1) or out of (p_sign = -1) the
-- groups of the given run identity.
CREATE OR REPLACE FUNCTION stats_rollup_campaign_cost_items_move_run(
  p_run_id uuid, p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text, p_sign bigint
) RETURNS void AS $$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT cost_source, status, cost_name, unit_cost_in_usd_cents AS unit,
      date_trunc('hour', created_at AT TIME ZONE 'UTC') AS cost_hour, count(*) AS n,
      SUM(quantity) AS quantity, SUM(total_cost_in_usd_cents) AS gross,
      MIN(created_at) AS min_at, MAX(created_at) AS max_at
    FROM runs_costs
    WHERE run_id = p_run_id AND status IN ('actual', 'provisioned', 'refunded')
    GROUP BY 1, 2, 3, 4, 5
  LOOP
    PERFORM stats_rollup_campaign_cost_items_add(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow,
      g.cost_source, g.status, g.cost_name, g.unit, g.cost_hour, p_sign * g.n, p_sign * g.quantity, p_sign * g.gross,
      CASE WHEN p_sign > 0 THEN g.min_at END, CASE WHEN p_sign > 0 THEN g.max_at END);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_campaign_cost_items_on_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.brand_ids IS DISTINCT FROM OLD.brand_ids
       OR NEW.feature_slug IS DISTINCT FROM OLD.feature_slug
       OR NEW.workflow_slug IS DISTINCT FROM OLD.workflow_slug THEN
      PERFORM stats_rollup_campaign_cost_items_move_run(NEW.id, OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids, OLD.feature_slug, OLD.workflow_slug, -1);
      PERFORM stats_rollup_campaign_cost_items_move_run(NEW.id, NEW.campaign_id, NEW.started_at, NEW.organization_id, NEW.brand_ids, NEW.feature_slug, NEW.workflow_slug, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: the run is still visible, so its cost rows are removed here
    -- (their own cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_campaign_cost_items_move_run(OLD.id, OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids, OLD.feature_slug, OLD.workflow_slug, -1);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_campaign_cost_items_on_cost() RETURNS trigger AS $$
DECLARE
  r record;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug
      INTO r FROM runs WHERE id = OLD.run_id;
    -- Run gone = this delete is the cascade of a run delete, already accounted for.
    IF FOUND THEN
      PERFORM stats_rollup_campaign_cost_items_add(r.campaign_id, r.started_at, r.organization_id, r.brand_ids, r.feature_slug, r.workflow_slug,
        OLD.cost_source, OLD.status, OLD.cost_name, OLD.unit_cost_in_usd_cents, date_trunc('hour', OLD.created_at AT TIME ZONE 'UTC'),
        -1, -OLD.quantity, -OLD.total_cost_in_usd_cents, NULL, NULL);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug
      INTO r FROM runs WHERE id = NEW.run_id;
    IF FOUND THEN
      PERFORM stats_rollup_campaign_cost_items_add(r.campaign_id, r.started_at, r.organization_id, r.brand_ids, r.feature_slug, r.workflow_slug,
        NEW.cost_source, NEW.status, NEW.cost_name, NEW.unit_cost_in_usd_cents, date_trunc('hour', NEW.created_at AT TIME ZONE 'UTC'),
        1, NEW.quantity, NEW.total_cost_in_usd_cents, NEW.created_at, NEW.created_at);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER stats_rollup_campaign_cost_items_run_update
  AFTER UPDATE OF campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_campaign_cost_items_on_run();
--> statement-breakpoint
CREATE TRIGGER stats_rollup_campaign_cost_items_run_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_campaign_cost_items_on_run();
--> statement-breakpoint
CREATE TRIGGER stats_rollup_campaign_cost_items_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF run_id, cost_source, status, cost_name, unit_cost_in_usd_cents, quantity, total_cost_in_usd_cents, created_at ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_campaign_cost_items_on_cost();
--> statement-breakpoint

-- Fresh database: nothing to backfill, the triggers see every row from the first.
INSERT INTO stats_rollups (name, ready_at)
SELECT 'campaign_cost_items', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
