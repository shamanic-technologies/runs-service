-- (org, brand set, campaign, UTC hour) rollup for GET /v1/stats/costs/timeseries.
--
-- WHY. The dashboard's Today/Crew/Work pages draw a week of daily run counts +
-- spend per campaign in the USER'S timezone. Live, that read covers the week's
-- ~45k runs and their cost rows in one statement: 1.0-1.9 s in prod, slower than
-- the seven per-day reads it replaces run in parallel. The (campaign, UTC day)
-- rollup of 0037/0041 cannot serve it: a local day (UTC+5 for the owner) cuts
-- through UTC days. An HOUR is whole in every whole-hour timezone, so local days,
-- weeks and months are unions of UTC hours.
--
-- GRAIN. One row per (organization_id, brand_ids, campaign_id, hour): run count,
-- min/max started_at, and gross/net money per cost status of those runs' cost
-- rows (all payers; the read has no costSource filter). Every filter the read
-- serves from it (org, brandId, campaignId(s)) is an exact predicate on a row.
-- NULLs are real groups (UNIQUE NULLS NOT DISTINCT).
--
-- MIN/MAX. A removed run (delete, or a key move by POST /internal/transfer-brand)
-- cannot shrink a min/max without a scan, so it marks the row `minmax_stale`; the
-- read takes every hour holding a stale row from the live ledger (same rule as
-- 0041). A rebuild clears it.
--
-- READINESS. Stamp `org_hour`. On a database that already holds runs the table
-- starts EMPTY and the read keeps its live query until
-- `scripts/rebuild-stats-rollup.ts org_hour` has rebuilt it and stamped it.
--
-- BOOT-WINDOW SAFE. One empty table, functions, triggers. No scan.

CREATE TABLE IF NOT EXISTS stats_rollup_org_hour (
  organization_id uuid,
  brand_ids text[],
  campaign_id text,
  hour timestamptz NOT NULL,
  run_count bigint NOT NULL DEFAULT 0,
  min_started_at timestamptz,
  max_started_at timestamptz,
  minmax_stale boolean NOT NULL DEFAULT false,
  gross_actual numeric NOT NULL DEFAULT 0,
  gross_provisioned numeric NOT NULL DEFAULT 0,
  gross_cancelled numeric NOT NULL DEFAULT 0,
  gross_refunded numeric NOT NULL DEFAULT 0,
  net_actual numeric NOT NULL DEFAULT 0,
  net_provisioned numeric NOT NULL DEFAULT 0,
  net_refunded numeric NOT NULL DEFAULT 0,
  CONSTRAINT stats_rollup_org_hour_key
    UNIQUE NULLS NOT DISTINCT (organization_id, brand_ids, campaign_id, hour)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stats_rollup_org_hour_org_hour
  ON stats_rollup_org_hour (organization_id, hour);
--> statement-breakpoint

-- Add (p_delta > 0) or remove (p_delta < 0) runs of one group.
CREATE OR REPLACE FUNCTION stats_rollup_org_hour_add_runs(
  p_org uuid, p_brands text[], p_campaign text, p_started timestamptz, p_delta bigint
) RETURNS void AS $$
BEGIN
  IF p_delta > 0 THEN
    INSERT INTO stats_rollup_org_hour (organization_id, brand_ids, campaign_id, hour, run_count, min_started_at, max_started_at)
    VALUES (p_org, p_brands, p_campaign, date_trunc('hour', p_started AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', p_delta, p_started, p_started)
    ON CONFLICT ON CONSTRAINT stats_rollup_org_hour_key DO UPDATE SET
      run_count      = stats_rollup_org_hour.run_count + EXCLUDED.run_count,
      min_started_at = LEAST(stats_rollup_org_hour.min_started_at, EXCLUDED.min_started_at),
      max_started_at = GREATEST(stats_rollup_org_hour.max_started_at, EXCLUDED.max_started_at);
  ELSE
    INSERT INTO stats_rollup_org_hour (organization_id, brand_ids, campaign_id, hour, run_count, minmax_stale)
    VALUES (p_org, p_brands, p_campaign, date_trunc('hour', p_started AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', p_delta, true)
    ON CONFLICT ON CONSTRAINT stats_rollup_org_hour_key DO UPDATE SET
      run_count    = stats_rollup_org_hour.run_count + EXCLUDED.run_count,
      minmax_stale = true;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Add (positive count) or remove (negative) cost amounts. Atomic status literals.
CREATE OR REPLACE FUNCTION stats_rollup_org_hour_add_cost(
  p_org uuid, p_brands text[], p_campaign text, p_started timestamptz, p_status text, p_gross numeric, p_net numeric
) RETURNS void AS $$
BEGIN
  IF p_status IN ('actual', 'provisioned', 'cancelled', 'refunded') THEN
    INSERT INTO stats_rollup_org_hour (
      organization_id, brand_ids, campaign_id, hour,
      gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
      net_actual, net_provisioned, net_refunded
    ) VALUES (
      p_org, p_brands, p_campaign, date_trunc('hour', p_started AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
      CASE WHEN p_status = 'actual'      THEN p_gross ELSE 0 END,
      CASE WHEN p_status = 'provisioned' THEN p_gross ELSE 0 END,
      CASE WHEN p_status = 'cancelled'   THEN p_gross ELSE 0 END,
      CASE WHEN p_status = 'refunded'    THEN p_gross ELSE 0 END,
      CASE WHEN p_status = 'actual'      THEN p_net ELSE 0 END,
      CASE WHEN p_status = 'provisioned' THEN p_net ELSE 0 END,
      CASE WHEN p_status = 'refunded'    THEN p_net ELSE 0 END
    )
    ON CONFLICT ON CONSTRAINT stats_rollup_org_hour_key DO UPDATE SET
      gross_actual      = stats_rollup_org_hour.gross_actual      + EXCLUDED.gross_actual,
      gross_provisioned = stats_rollup_org_hour.gross_provisioned + EXCLUDED.gross_provisioned,
      gross_cancelled   = stats_rollup_org_hour.gross_cancelled   + EXCLUDED.gross_cancelled,
      gross_refunded    = stats_rollup_org_hour.gross_refunded    + EXCLUDED.gross_refunded,
      net_actual        = stats_rollup_org_hour.net_actual        + EXCLUDED.net_actual,
      net_provisioned   = stats_rollup_org_hour.net_provisioned   + EXCLUDED.net_provisioned,
      net_refunded      = stats_rollup_org_hour.net_refunded      + EXCLUDED.net_refunded;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Move every cost row of one run into (p_sign = 1) or out of (p_sign = -1) a group.
CREATE OR REPLACE FUNCTION stats_rollup_org_hour_move_run_costs(
  p_run_id uuid, p_org uuid, p_brands text[], p_campaign text, p_started timestamptz, p_sign bigint
) RETURNS void AS $$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT status,
      SUM(total_cost_in_usd_cents) AS gross,
      SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) AS net
    FROM runs_costs WHERE run_id = p_run_id
    GROUP BY status
  LOOP
    PERFORM stats_rollup_org_hour_add_cost(p_org, p_brands, p_campaign, p_started, g.status, p_sign * g.gross, p_sign * g.net);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_org_hour_on_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM stats_rollup_org_hour_add_runs(NEW.organization_id, NEW.brand_ids, NEW.campaign_id, NEW.started_at, 1);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.brand_ids IS DISTINCT FROM OLD.brand_ids
       OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      PERFORM stats_rollup_org_hour_add_runs(OLD.organization_id, OLD.brand_ids, OLD.campaign_id, OLD.started_at, -1);
      PERFORM stats_rollup_org_hour_add_runs(NEW.organization_id, NEW.brand_ids, NEW.campaign_id, NEW.started_at, 1);
      PERFORM stats_rollup_org_hour_move_run_costs(NEW.id, OLD.organization_id, OLD.brand_ids, OLD.campaign_id, OLD.started_at, -1);
      PERFORM stats_rollup_org_hour_move_run_costs(NEW.id, NEW.organization_id, NEW.brand_ids, NEW.campaign_id, NEW.started_at, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: the run is still visible, so its cost rows can be removed here
    -- (their own cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_org_hour_add_runs(OLD.organization_id, OLD.brand_ids, OLD.campaign_id, OLD.started_at, -1);
    PERFORM stats_rollup_org_hour_move_run_costs(OLD.id, OLD.organization_id, OLD.brand_ids, OLD.campaign_id, OLD.started_at, -1);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_org_hour_on_cost() RETURNS trigger AS $$
DECLARE
  r record;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT organization_id, brand_ids, campaign_id, started_at INTO r FROM runs WHERE id = OLD.run_id;
    -- Run gone = this delete is the cascade of a run delete, already accounted for.
    IF FOUND THEN
      PERFORM stats_rollup_org_hour_add_cost(r.organization_id, r.brand_ids, r.campaign_id, r.started_at,
        OLD.status, -OLD.total_cost_in_usd_cents, -COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents));
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT organization_id, brand_ids, campaign_id, started_at INTO r FROM runs WHERE id = NEW.run_id;
    IF FOUND THEN
      PERFORM stats_rollup_org_hour_add_cost(r.organization_id, r.brand_ids, r.campaign_id, r.started_at,
        NEW.status, NEW.total_cost_in_usd_cents, COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents));
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_org_hour_run_insert ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_org_hour_run_insert AFTER INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_org_hour_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_org_hour_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_org_hour_run_update
  AFTER UPDATE OF organization_id, brand_ids, campaign_id, started_at ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_org_hour_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_org_hour_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_org_hour_run_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_org_hour_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_org_hour_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_org_hour_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF run_id, status, total_cost_in_usd_cents, net_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_org_hour_on_cost();
--> statement-breakpoint

INSERT INTO stats_rollups (name, ready_at)
SELECT 'org_hour', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
