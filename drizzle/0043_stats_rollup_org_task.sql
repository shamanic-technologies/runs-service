-- (org, service, task, campaign, UTC day) rollup for the org usage read:
-- GET /v1/stats/costs?groupBy=serviceName,taskName,campaignId, org-scoped.
--
-- WHY. features-service answers "everything the org has been billed, by kind of
-- work" (GET /orgs/usage: dashboard Billing + Today, the copilot's
-- get_org_usage) from that read. Live it groups EVERY run of the org: 985k runs
-- for the owner org (f0420eb5), 29.7 s for the run count alone (a bitmap heap
-- scan of ~110k pages + an on-disk sort) + 3.3 s for the money, past the 30 s
-- stats statement_timeout: 12 failures a day, and the usage figure blank for the
-- largest orgs (2026-10-09). The (campaign, UTC day) rollup of 0037/0041 cannot
-- serve it: it does not carry service_name / task_name.
--
-- GRAIN. One row per (organization_id, service_name, task_name, campaign_id,
-- day): run count, min/max started_at, and per cost status the matched-row
-- count + gross + net of those runs' cost rows (all payers; the read has no
-- costSource filter). Every filter the read serves from it (org, service, task,
-- campaignId(s)) is an exact predicate on a row. NULLs are real groups (UNIQUE
-- NULLS NOT DISTINCT). Prod: ~77k rows for 4.9M runs.
--
-- BYTE-IDENTITY. As in 0034/0037: numeric addition is exact, and each status
-- carries its matched-row COUNT so the read renders `'0'` exactly where the live
-- `SUM(CASE … ELSE 0 END)::text` would (the read ORDERs BY that text).
--
-- MIN/MAX. A removed run (delete, or a key move by POST /internal/transfer-brand)
-- cannot shrink a min/max without a scan, so it marks the row `minmax_stale`;
-- the read takes every day holding a stale row from the live ledger (0041's
-- rule). A rebuild clears it.
--
-- READINESS. Stamp `org_task`. On a database that already holds runs the table
-- starts EMPTY and the read keeps its live query until
-- `scripts/rebuild-stats-rollup.ts org_task` has rebuilt it and stamped it.
--
-- BOOT-WINDOW SAFE. One empty table, functions, triggers. No scan.

CREATE TABLE IF NOT EXISTS stats_rollup_org_task (
  organization_id uuid,
  service_name text NOT NULL,
  task_name text NOT NULL,
  campaign_id text,
  day date NOT NULL,
  run_count bigint NOT NULL DEFAULT 0,
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
  CONSTRAINT stats_rollup_org_task_key
    UNIQUE NULLS NOT DISTINCT (organization_id, service_name, task_name, campaign_id, day)
);
--> statement-breakpoint

-- Add (p_delta > 0) or remove (p_delta < 0) runs of one group.
CREATE OR REPLACE FUNCTION stats_rollup_org_task_add_runs(
  p_org uuid, p_service text, p_task text, p_campaign text, p_started timestamptz, p_delta bigint
) RETURNS void AS $$
BEGIN
  IF p_delta > 0 THEN
    INSERT INTO stats_rollup_org_task (organization_id, service_name, task_name, campaign_id, day, run_count, min_started_at, max_started_at)
    VALUES (p_org, p_service, p_task, p_campaign, (p_started AT TIME ZONE 'UTC')::date, p_delta, p_started, p_started)
    ON CONFLICT ON CONSTRAINT stats_rollup_org_task_key DO UPDATE SET
      run_count      = stats_rollup_org_task.run_count + EXCLUDED.run_count,
      min_started_at = LEAST(stats_rollup_org_task.min_started_at, EXCLUDED.min_started_at),
      max_started_at = GREATEST(stats_rollup_org_task.max_started_at, EXCLUDED.max_started_at);
  ELSE
    INSERT INTO stats_rollup_org_task (organization_id, service_name, task_name, campaign_id, day, run_count, minmax_stale)
    VALUES (p_org, p_service, p_task, p_campaign, (p_started AT TIME ZONE 'UTC')::date, p_delta, true)
    ON CONFLICT ON CONSTRAINT stats_rollup_org_task_key DO UPDATE SET
      run_count    = stats_rollup_org_task.run_count + EXCLUDED.run_count,
      minmax_stale = true;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Add (positive count) or remove (negative count) cost amounts. Atomic status literals.
CREATE OR REPLACE FUNCTION stats_rollup_org_task_add_cost(
  p_org uuid, p_service text, p_task text, p_campaign text, p_started timestamptz,
  p_status text, p_count bigint, p_gross numeric, p_net numeric
) RETURNS void AS $$
BEGIN
  IF p_status NOT IN ('actual', 'provisioned', 'cancelled', 'refunded') THEN
    RETURN;
  END IF;
  INSERT INTO stats_rollup_org_task (
    organization_id, service_name, task_name, campaign_id, day,
    n_actual, n_provisioned, n_cancelled, n_refunded,
    gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
    net_actual, net_provisioned, net_refunded
  ) VALUES (
    p_org, p_service, p_task, p_campaign, (p_started AT TIME ZONE 'UTC')::date,
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
  ON CONFLICT ON CONSTRAINT stats_rollup_org_task_key DO UPDATE SET
    n_actual          = stats_rollup_org_task.n_actual          + EXCLUDED.n_actual,
    n_provisioned     = stats_rollup_org_task.n_provisioned     + EXCLUDED.n_provisioned,
    n_cancelled       = stats_rollup_org_task.n_cancelled       + EXCLUDED.n_cancelled,
    n_refunded        = stats_rollup_org_task.n_refunded        + EXCLUDED.n_refunded,
    gross_actual      = stats_rollup_org_task.gross_actual      + EXCLUDED.gross_actual,
    gross_provisioned = stats_rollup_org_task.gross_provisioned + EXCLUDED.gross_provisioned,
    gross_cancelled   = stats_rollup_org_task.gross_cancelled   + EXCLUDED.gross_cancelled,
    gross_refunded    = stats_rollup_org_task.gross_refunded    + EXCLUDED.gross_refunded,
    net_actual        = stats_rollup_org_task.net_actual        + EXCLUDED.net_actual,
    net_provisioned   = stats_rollup_org_task.net_provisioned   + EXCLUDED.net_provisioned,
    net_refunded      = stats_rollup_org_task.net_refunded      + EXCLUDED.net_refunded;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Move every cost row of one run into (p_sign = 1) or out of (p_sign = -1) a group.
CREATE OR REPLACE FUNCTION stats_rollup_org_task_move_run_costs(
  p_run_id uuid, p_org uuid, p_service text, p_task text, p_campaign text, p_started timestamptz, p_sign bigint
) RETURNS void AS $$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT status, count(*) AS n,
      SUM(total_cost_in_usd_cents) AS gross,
      SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) AS net
    FROM runs_costs WHERE run_id = p_run_id
    GROUP BY status
  LOOP
    PERFORM stats_rollup_org_task_add_cost(p_org, p_service, p_task, p_campaign, p_started,
      g.status, p_sign * g.n, p_sign * g.gross, p_sign * g.net);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_org_task_on_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM stats_rollup_org_task_add_runs(NEW.organization_id, NEW.service_name, NEW.task_name, NEW.campaign_id, NEW.started_at, 1);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.service_name IS DISTINCT FROM OLD.service_name
       OR NEW.task_name IS DISTINCT FROM OLD.task_name
       OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      PERFORM stats_rollup_org_task_add_runs(OLD.organization_id, OLD.service_name, OLD.task_name, OLD.campaign_id, OLD.started_at, -1);
      PERFORM stats_rollup_org_task_add_runs(NEW.organization_id, NEW.service_name, NEW.task_name, NEW.campaign_id, NEW.started_at, 1);
      PERFORM stats_rollup_org_task_move_run_costs(NEW.id, OLD.organization_id, OLD.service_name, OLD.task_name, OLD.campaign_id, OLD.started_at, -1);
      PERFORM stats_rollup_org_task_move_run_costs(NEW.id, NEW.organization_id, NEW.service_name, NEW.task_name, NEW.campaign_id, NEW.started_at, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: the run is still visible, so its cost rows can be removed here
    -- (their own cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_org_task_add_runs(OLD.organization_id, OLD.service_name, OLD.task_name, OLD.campaign_id, OLD.started_at, -1);
    PERFORM stats_rollup_org_task_move_run_costs(OLD.id, OLD.organization_id, OLD.service_name, OLD.task_name, OLD.campaign_id, OLD.started_at, -1);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_org_task_on_cost() RETURNS trigger AS $$
DECLARE
  r record;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT organization_id, service_name, task_name, campaign_id, started_at INTO r FROM runs WHERE id = OLD.run_id;
    -- Run gone = this delete is the cascade of a run delete, already accounted for.
    IF FOUND THEN
      PERFORM stats_rollup_org_task_add_cost(r.organization_id, r.service_name, r.task_name, r.campaign_id, r.started_at,
        OLD.status, -1, -OLD.total_cost_in_usd_cents, -COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents));
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT organization_id, service_name, task_name, campaign_id, started_at INTO r FROM runs WHERE id = NEW.run_id;
    IF FOUND THEN
      PERFORM stats_rollup_org_task_add_cost(r.organization_id, r.service_name, r.task_name, r.campaign_id, r.started_at,
        NEW.status, 1, NEW.total_cost_in_usd_cents, COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents));
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_org_task_run_insert ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_org_task_run_insert AFTER INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_org_task_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_org_task_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_org_task_run_update
  AFTER UPDATE OF organization_id, service_name, task_name, campaign_id, started_at ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_org_task_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_org_task_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_org_task_run_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_org_task_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_org_task_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_org_task_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF run_id, status, total_cost_in_usd_cents, net_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_org_task_on_cost();
--> statement-breakpoint

INSERT INTO stats_rollups (name, ready_at)
SELECT 'org_task', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
