-- (org, campaign, feature, service, task, UTC day, brand set) rollup for the
-- spend-by-action read: GET /v1/stats/costs/timeseries?groupBy=serviceName,taskName
-- (SPEND-BY-ACTION-TIMEOUT-1106).
--
-- WHY. features-service draws a campaign's spend per day split by action
-- (prospects found, first emails, follow-ups...) from that read, scoped to org +
-- brand + the funnel's feature slugs + 1..~230 campaign ids, whole history. Live it
-- reads every run of those campaigns plus their cost rows: 147k runs for 3
-- campaigns of brand 33211c62 = 22k cold heap pages, 51 s for the run count alone
-- at box load ~50 (2026-11-06), past the 30 s stats statement_timeout: HTTP 500,
-- the chart showed the day's spend with no split. No existing rollup carries
-- service/task AND brand/feature (0043 org_task has no brand/feature and serves
-- three other reads; re-keying it would blank them during its rebuild).
--
-- GRAIN. One row per (organization_id, campaign_id, feature_slug, service_name,
-- task_name, day, brand_ids): run count, min/max started_at (+ stale flag, 0041's
-- rule), per cost status the matched-row count + gross + net, and
-- committed_run_count = runs of the row with >= 1 actual or provisioned cost row
-- (the read's `committedRunCount`). A run sits in exactly one row, so every sum
-- over rows is exact. NULLs are real groups (UNIQUE NULLS NOT DISTINCT).
--
-- COMMITTED MEMBERSHIP (0035/0049 lock-then-read): a cost write upserts its money
-- delta FIRST (locking the key row), then checks, in a later statement (fresh
-- snapshot), whether ANOTHER committed row of the run exists. Two writers on one
-- run meet on that row lock, so the second sees the first's committed row.
--
-- READINESS. Stamp `task_day`. A database holding runs starts EMPTY and the read
-- stays live until `scripts/rebuild-stats-rollup.ts task_day` stamps it.
--
-- BOOT-WINDOW SAFE. One empty table, functions, triggers. No scan.

CREATE TABLE IF NOT EXISTS stats_rollup_task_day (
  organization_id uuid,
  campaign_id text,
  feature_slug text,
  service_name text NOT NULL,
  task_name text NOT NULL,
  day date NOT NULL,
  brand_ids text[],
  run_count bigint NOT NULL DEFAULT 0,
  committed_run_count bigint NOT NULL DEFAULT 0,
  min_started_at timestamptz,
  max_started_at timestamptz,
  minmax_stale boolean NOT NULL DEFAULT false,
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
  CONSTRAINT stats_rollup_task_day_key
    UNIQUE NULLS NOT DISTINCT (organization_id, campaign_id, feature_slug, service_name, task_name, day, brand_ids)
);
--> statement-breakpoint

-- Add (p_delta > 0) or remove (p_delta < 0) runs of one group; p_committed moves
-- committed_run_count alongside.
CREATE OR REPLACE FUNCTION stats_rollup_task_day_add_runs(
  p_org uuid, p_campaign text, p_feature text, p_service text, p_task text, p_brands text[],
  p_started timestamptz, p_delta bigint, p_committed bigint
) RETURNS void AS $$
BEGIN
  IF p_delta > 0 THEN
    INSERT INTO stats_rollup_task_day (organization_id, campaign_id, feature_slug, service_name, task_name, day, brand_ids,
      run_count, committed_run_count, min_started_at, max_started_at)
    VALUES (p_org, p_campaign, p_feature, p_service, p_task, (p_started AT TIME ZONE 'UTC')::date, p_brands,
      p_delta, p_committed, p_started, p_started)
    ON CONFLICT ON CONSTRAINT stats_rollup_task_day_key DO UPDATE SET
      run_count           = stats_rollup_task_day.run_count + EXCLUDED.run_count,
      committed_run_count = stats_rollup_task_day.committed_run_count + EXCLUDED.committed_run_count,
      min_started_at      = LEAST(stats_rollup_task_day.min_started_at, EXCLUDED.min_started_at),
      max_started_at      = GREATEST(stats_rollup_task_day.max_started_at, EXCLUDED.max_started_at);
  ELSIF p_delta < 0 THEN
    INSERT INTO stats_rollup_task_day (organization_id, campaign_id, feature_slug, service_name, task_name, day, brand_ids,
      run_count, committed_run_count, minmax_stale)
    VALUES (p_org, p_campaign, p_feature, p_service, p_task, (p_started AT TIME ZONE 'UTC')::date, p_brands,
      p_delta, p_committed, true)
    ON CONFLICT ON CONSTRAINT stats_rollup_task_day_key DO UPDATE SET
      run_count           = stats_rollup_task_day.run_count + EXCLUDED.run_count,
      committed_run_count = stats_rollup_task_day.committed_run_count + EXCLUDED.committed_run_count,
      minmax_stale        = true;
  ELSE
    INSERT INTO stats_rollup_task_day (organization_id, campaign_id, feature_slug, service_name, task_name, day, brand_ids,
      committed_run_count)
    VALUES (p_org, p_campaign, p_feature, p_service, p_task, (p_started AT TIME ZONE 'UTC')::date, p_brands, p_committed)
    ON CONFLICT ON CONSTRAINT stats_rollup_task_day_key DO UPDATE SET
      committed_run_count = stats_rollup_task_day.committed_run_count + EXCLUDED.committed_run_count;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Add (positive count) or remove (negative count) cost amounts. Atomic status
-- literals. Always upserts (so the key row is locked even for an unknown status).
CREATE OR REPLACE FUNCTION stats_rollup_task_day_add_cost(
  p_org uuid, p_campaign text, p_feature text, p_service text, p_task text, p_brands text[],
  p_started timestamptz, p_status text, p_count bigint, p_gross numeric, p_net numeric
) RETURNS void AS $$
BEGIN
  INSERT INTO stats_rollup_task_day (
    organization_id, campaign_id, feature_slug, service_name, task_name, day, brand_ids,
    n_actual, n_provisioned, n_cancelled, n_refunded,
    gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
    net_actual, net_provisioned, net_refunded
  ) VALUES (
    p_org, p_campaign, p_feature, p_service, p_task, (p_started AT TIME ZONE 'UTC')::date, p_brands,
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
  ON CONFLICT ON CONSTRAINT stats_rollup_task_day_key DO UPDATE SET
    n_actual          = stats_rollup_task_day.n_actual          + EXCLUDED.n_actual,
    n_provisioned     = stats_rollup_task_day.n_provisioned     + EXCLUDED.n_provisioned,
    n_cancelled       = stats_rollup_task_day.n_cancelled       + EXCLUDED.n_cancelled,
    n_refunded        = stats_rollup_task_day.n_refunded        + EXCLUDED.n_refunded,
    gross_actual      = stats_rollup_task_day.gross_actual      + EXCLUDED.gross_actual,
    gross_provisioned = stats_rollup_task_day.gross_provisioned + EXCLUDED.gross_provisioned,
    gross_cancelled   = stats_rollup_task_day.gross_cancelled   + EXCLUDED.gross_cancelled,
    gross_refunded    = stats_rollup_task_day.gross_refunded    + EXCLUDED.gross_refunded,
    net_actual        = stats_rollup_task_day.net_actual        + EXCLUDED.net_actual,
    net_provisioned   = stats_rollup_task_day.net_provisioned   + EXCLUDED.net_provisioned,
    net_refunded      = stats_rollup_task_day.net_refunded      + EXCLUDED.net_refunded;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Move one run (its run count, every cost row, its committed membership) into
-- (p_sign = 1) or out of (p_sign = -1) a group.
CREATE OR REPLACE FUNCTION stats_rollup_task_day_move_run(
  p_run_id uuid, p_org uuid, p_campaign text, p_feature text, p_service text, p_task text, p_brands text[],
  p_started timestamptz, p_sign bigint
) RETURNS void AS $$
DECLARE
  g record;
  v_committed bigint;
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM runs_costs WHERE run_id = p_run_id AND status IN ('actual', 'provisioned')
  ) THEN 1 ELSE 0 END INTO v_committed;
  PERFORM stats_rollup_task_day_add_runs(p_org, p_campaign, p_feature, p_service, p_task, p_brands, p_started,
    p_sign, p_sign * v_committed);
  FOR g IN
    SELECT status, count(*) AS n,
      SUM(total_cost_in_usd_cents) AS gross,
      SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) AS net
    FROM runs_costs WHERE run_id = p_run_id AND status IN ('actual', 'provisioned', 'cancelled', 'refunded')
    GROUP BY status
  LOOP
    PERFORM stats_rollup_task_day_add_cost(p_org, p_campaign, p_feature, p_service, p_task, p_brands, p_started,
      g.status, p_sign * g.n, p_sign * g.gross, p_sign * g.net);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_task_day_on_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM stats_rollup_task_day_add_runs(NEW.organization_id, NEW.campaign_id, NEW.feature_slug, NEW.service_name,
      NEW.task_name, NEW.brand_ids, NEW.started_at, 1, 0);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.feature_slug IS DISTINCT FROM OLD.feature_slug
       OR NEW.service_name IS DISTINCT FROM OLD.service_name
       OR NEW.task_name IS DISTINCT FROM OLD.task_name
       OR NEW.brand_ids IS DISTINCT FROM OLD.brand_ids
       OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      PERFORM stats_rollup_task_day_move_run(NEW.id, OLD.organization_id, OLD.campaign_id, OLD.feature_slug,
        OLD.service_name, OLD.task_name, OLD.brand_ids, OLD.started_at, -1);
      PERFORM stats_rollup_task_day_move_run(NEW.id, NEW.organization_id, NEW.campaign_id, NEW.feature_slug,
        NEW.service_name, NEW.task_name, NEW.brand_ids, NEW.started_at, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: the run is still visible, so its cost rows are removed here
    -- (their own cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_task_day_move_run(OLD.id, OLD.organization_id, OLD.campaign_id, OLD.feature_slug,
      OLD.service_name, OLD.task_name, OLD.brand_ids, OLD.started_at, -1);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_task_day_on_cost() RETURNS trigger AS $$
DECLARE
  r record;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT organization_id, campaign_id, feature_slug, service_name, task_name, brand_ids, started_at
      INTO r FROM runs WHERE id = OLD.run_id;
    -- Run gone = this delete is the cascade of a run delete, already accounted for.
    IF FOUND THEN
      PERFORM stats_rollup_task_day_add_cost(r.organization_id, r.campaign_id, r.feature_slug, r.service_name,
        r.task_name, r.brand_ids, r.started_at,
        OLD.status, -1, -OLD.total_cost_in_usd_cents, -COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents));
      -- Lock taken above; this statement sees every committed sibling row.
      IF OLD.status IN ('actual', 'provisioned') AND NOT EXISTS (
        SELECT 1 FROM runs_costs
        WHERE run_id = OLD.run_id AND status IN ('actual', 'provisioned') AND id <> OLD.id
      ) THEN
        PERFORM stats_rollup_task_day_add_runs(r.organization_id, r.campaign_id, r.feature_slug, r.service_name,
          r.task_name, r.brand_ids, r.started_at, 0, -1);
      END IF;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT organization_id, campaign_id, feature_slug, service_name, task_name, brand_ids, started_at
      INTO r FROM runs WHERE id = NEW.run_id;
    IF FOUND THEN
      PERFORM stats_rollup_task_day_add_cost(r.organization_id, r.campaign_id, r.feature_slug, r.service_name,
        r.task_name, r.brand_ids, r.started_at,
        NEW.status, 1, NEW.total_cost_in_usd_cents, COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents));
      IF NEW.status IN ('actual', 'provisioned') AND NOT EXISTS (
        SELECT 1 FROM runs_costs
        WHERE run_id = NEW.run_id AND status IN ('actual', 'provisioned') AND id <> NEW.id
      ) THEN
        PERFORM stats_rollup_task_day_add_runs(r.organization_id, r.campaign_id, r.feature_slug, r.service_name,
          r.task_name, r.brand_ids, r.started_at, 0, 1);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_task_day_run_insert ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_task_day_run_insert AFTER INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_task_day_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_task_day_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_task_day_run_update
  AFTER UPDATE OF organization_id, campaign_id, feature_slug, service_name, task_name, brand_ids, started_at ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_task_day_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_task_day_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_task_day_run_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_task_day_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_task_day_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_task_day_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF run_id, status, total_cost_in_usd_cents, net_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_task_day_on_cost();
--> statement-breakpoint

INSERT INTO stats_rollups (name, ready_at)
SELECT 'task_day', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
