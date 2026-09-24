-- Incrementally-maintained (campaign, UTC day) rollup for the campaign-FAMILY
-- cost reads (GET /v1/stats/public/costs/timeseries and GET /v1/stats/public/costs
-- with `campaignIds=`).
--
-- WHY. A campaign as the customer knows it is a FAMILY of stored campaign rows
-- (one per workflow switch; the busiest has 47). features-service refreshes a
-- campaign Overview every few seconds and needs the family's dated spend and its
-- totals, per row and combined. Asked live, the 47-row family of campaign
-- f7b1b610 is 322k runs joined to their cost rows: 3.3 s per read, before the
-- ~40 per-row reads it replaces are even counted (features-service#1045). The
-- answer only changes when a run or a cost row lands, so it is maintained at
-- WRITE time, the same way migration 0034 maintains the per-workflow benchmark.
--
-- GRAIN. (campaign_id, day, organization_id, brand_ids, feature_slug,
-- workflow_slug) for run counts, plus cost_source for money. `day` is the run's
-- started_at truncated to a UTC day; day / week / month buckets in UTC are unions
-- of UTC days, so every interval rolls up from it exactly. The org, brand set,
-- feature and workflow are carried as-is so every filter the served reads accept
-- is an exact predicate on a rollup row (a run belongs to exactly one row).
-- Runs with no campaign are not rolled up: every served read filters on a
-- campaign, so they could never match. NULLs are real groups, hence
-- UNIQUE NULLS NOT DISTINCT.
--
-- BYTE-IDENTITY. As in 0034: numeric addition is exact, and each status carries
-- its matched-row COUNT beside its sums so the read can render `'0'` exactly
-- where the live `SUM(CASE … ELSE 0 END)::text` would.
--
-- CONCURRENCY. Every change is a commutative `+=` upsert on one row, so
-- concurrent writers queue on that row's lock and never lose an update. A run
-- whose key columns change (POST /internal/transfer-brand rewrites brand_ids)
-- moves its cost rows with it — the same accepted window as 0034 for a cost row
-- inserted concurrently with that move.
--
-- READINESS. On a database that already holds runs the tables start EMPTY; the
-- read path does not use them until `scripts/rebuild-stats-rollup.ts
-- campaign_day` has rebuilt them from the ledger and stamped `stats_rollups`. A
-- fresh (empty) database is stamped ready here.
--
-- BOOT-WINDOW SAFE. Two empty tables, five functions, four triggers. No scan.

CREATE TABLE IF NOT EXISTS stats_rollup_campaign_runs (
  campaign_id text NOT NULL,
  day date NOT NULL,
  organization_id uuid,
  brand_ids text[],
  feature_slug text,
  workflow_slug text,
  run_count bigint NOT NULL DEFAULT 0,
  CONSTRAINT stats_rollup_campaign_runs_key
    UNIQUE NULLS NOT DISTINCT (campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS stats_rollup_campaign_costs (
  campaign_id text NOT NULL,
  day date NOT NULL,
  organization_id uuid,
  brand_ids text[],
  feature_slug text,
  workflow_slug text,
  cost_source text NOT NULL,
  n_actual bigint NOT NULL DEFAULT 0,
  n_provisioned bigint NOT NULL DEFAULT 0,
  n_cancelled bigint NOT NULL DEFAULT 0,
  n_refunded bigint NOT NULL DEFAULT 0,
  gross_actual numeric NOT NULL DEFAULT 0,
  gross_provisioned numeric NOT NULL DEFAULT 0,
  gross_cancelled numeric NOT NULL DEFAULT 0,
  gross_refunded numeric NOT NULL DEFAULT 0,
  net_actual numeric NOT NULL DEFAULT 0,
  net_provisioned numeric NOT NULL DEFAULT 0,
  net_refunded numeric NOT NULL DEFAULT 0,
  CONSTRAINT stats_rollup_campaign_costs_key
    UNIQUE NULLS NOT DISTINCT (campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, cost_source)
);
--> statement-breakpoint

-- Add `delta` runs to one group. A run with no campaign is not rolled up.
CREATE OR REPLACE FUNCTION stats_rollup_campaign_add_runs(
  p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text, p_delta bigint
) RETURNS void AS $$
BEGIN
  IF p_campaign IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO stats_rollup_campaign_runs (campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, run_count)
  VALUES (p_campaign, (p_started AT TIME ZONE 'UTC')::date, p_org, p_brands, p_feature, p_workflow, p_delta)
  ON CONFLICT ON CONSTRAINT stats_rollup_campaign_runs_key
  DO UPDATE SET run_count = stats_rollup_campaign_runs.run_count + EXCLUDED.run_count;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Add (positive count) or remove (negative count) cost amounts to one group.
-- Atomic status literals only (cost predicate doctrine).
CREATE OR REPLACE FUNCTION stats_rollup_campaign_add_cost(
  p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text,
  p_source text, p_status text, p_count bigint, p_gross numeric, p_net numeric
) RETURNS void AS $$
BEGIN
  IF p_campaign IS NULL OR p_status NOT IN ('actual', 'provisioned', 'cancelled', 'refunded') THEN
    RETURN;
  END IF;
  INSERT INTO stats_rollup_campaign_costs (
    campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, cost_source,
    n_actual, n_provisioned, n_cancelled, n_refunded,
    gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
    net_actual, net_provisioned, net_refunded
  ) VALUES (
    p_campaign, (p_started AT TIME ZONE 'UTC')::date, p_org, p_brands, p_feature, p_workflow, p_source,
    CASE WHEN p_status = 'actual'      THEN p_count ELSE 0 END,
    CASE WHEN p_status = 'provisioned' THEN p_count ELSE 0 END,
    CASE WHEN p_status = 'cancelled'   THEN p_count ELSE 0 END,
    CASE WHEN p_status = 'refunded'    THEN p_count ELSE 0 END,
    CASE WHEN p_status = 'actual'      THEN p_gross ELSE 0 END,
    CASE WHEN p_status = 'provisioned' THEN p_gross ELSE 0 END,
    CASE WHEN p_status = 'cancelled'   THEN p_gross ELSE 0 END,
    CASE WHEN p_status = 'refunded'    THEN p_gross ELSE 0 END,
    CASE WHEN p_status = 'actual'      THEN p_net ELSE 0 END,
    CASE WHEN p_status = 'provisioned' THEN p_net ELSE 0 END,
    CASE WHEN p_status = 'refunded'    THEN p_net ELSE 0 END
  )
  ON CONFLICT ON CONSTRAINT stats_rollup_campaign_costs_key DO UPDATE SET
    n_actual          = stats_rollup_campaign_costs.n_actual          + EXCLUDED.n_actual,
    n_provisioned     = stats_rollup_campaign_costs.n_provisioned     + EXCLUDED.n_provisioned,
    n_cancelled       = stats_rollup_campaign_costs.n_cancelled       + EXCLUDED.n_cancelled,
    n_refunded        = stats_rollup_campaign_costs.n_refunded        + EXCLUDED.n_refunded,
    gross_actual      = stats_rollup_campaign_costs.gross_actual      + EXCLUDED.gross_actual,
    gross_provisioned = stats_rollup_campaign_costs.gross_provisioned + EXCLUDED.gross_provisioned,
    gross_cancelled   = stats_rollup_campaign_costs.gross_cancelled   + EXCLUDED.gross_cancelled,
    gross_refunded    = stats_rollup_campaign_costs.gross_refunded    + EXCLUDED.gross_refunded,
    net_actual        = stats_rollup_campaign_costs.net_actual        + EXCLUDED.net_actual,
    net_provisioned   = stats_rollup_campaign_costs.net_provisioned   + EXCLUDED.net_provisioned,
    net_refunded      = stats_rollup_campaign_costs.net_refunded      + EXCLUDED.net_refunded;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Move every cost row of one run into (p_sign = 1) or out of (p_sign = -1) the
-- given group, one upsert per (cost_source, status).
CREATE OR REPLACE FUNCTION stats_rollup_campaign_move_run_costs(
  p_run_id uuid, p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text, p_sign bigint
) RETURNS void AS $$
DECLARE
  g record;
BEGIN
  IF p_campaign IS NULL THEN
    RETURN;
  END IF;
  FOR g IN
    SELECT cost_source, status, count(*) AS n,
      SUM(total_cost_in_usd_cents) AS gross,
      SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) AS net
    FROM runs_costs WHERE run_id = p_run_id
    GROUP BY cost_source, status
  LOOP
    PERFORM stats_rollup_campaign_add_cost(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow,
      g.cost_source, g.status, p_sign * g.n, p_sign * g.gross, p_sign * g.net);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_campaign_on_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM stats_rollup_campaign_add_runs(NEW.campaign_id, NEW.started_at, NEW.organization_id, NEW.brand_ids, NEW.feature_slug, NEW.workflow_slug, 1);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.brand_ids IS DISTINCT FROM OLD.brand_ids
       OR NEW.feature_slug IS DISTINCT FROM OLD.feature_slug
       OR NEW.workflow_slug IS DISTINCT FROM OLD.workflow_slug THEN
      PERFORM stats_rollup_campaign_add_runs(OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids, OLD.feature_slug, OLD.workflow_slug, -1);
      PERFORM stats_rollup_campaign_add_runs(NEW.campaign_id, NEW.started_at, NEW.organization_id, NEW.brand_ids, NEW.feature_slug, NEW.workflow_slug, 1);
      PERFORM stats_rollup_campaign_move_run_costs(NEW.id, OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids, OLD.feature_slug, OLD.workflow_slug, -1);
      PERFORM stats_rollup_campaign_move_run_costs(NEW.id, NEW.campaign_id, NEW.started_at, NEW.organization_id, NEW.brand_ids, NEW.feature_slug, NEW.workflow_slug, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: remove the run's cost rows while the run is still visible
    -- (their own cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_campaign_add_runs(OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids, OLD.feature_slug, OLD.workflow_slug, -1);
    PERFORM stats_rollup_campaign_move_run_costs(OLD.id, OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids, OLD.feature_slug, OLD.workflow_slug, -1);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_campaign_on_cost() RETURNS trigger AS $$
DECLARE
  r record;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug
      INTO r FROM runs WHERE id = OLD.run_id;
    -- Run gone = this delete is the cascade of a run delete, already accounted
    -- for by stats_rollup_campaign_on_run.
    IF FOUND THEN
      PERFORM stats_rollup_campaign_add_cost(r.campaign_id, r.started_at, r.organization_id, r.brand_ids, r.feature_slug, r.workflow_slug,
        OLD.cost_source, OLD.status, -1,
        -OLD.total_cost_in_usd_cents, -COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents));
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug
      INTO r FROM runs WHERE id = NEW.run_id;
    IF FOUND THEN
      PERFORM stats_rollup_campaign_add_cost(r.campaign_id, r.started_at, r.organization_id, r.brand_ids, r.feature_slug, r.workflow_slug,
        NEW.cost_source, NEW.status, 1,
        NEW.total_cost_in_usd_cents, COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents));
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_campaign_run_insert ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_campaign_run_insert AFTER INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_campaign_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_campaign_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_campaign_run_update
  AFTER UPDATE OF campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_campaign_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_campaign_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_campaign_run_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_campaign_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_campaign_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_campaign_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF run_id, cost_source, status, total_cost_in_usd_cents, net_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_campaign_on_cost();
--> statement-breakpoint

-- Fresh database: nothing to backfill, the triggers see every row from the first.
INSERT INTO stats_rollups (name, ready_at)
SELECT 'campaign_day', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
