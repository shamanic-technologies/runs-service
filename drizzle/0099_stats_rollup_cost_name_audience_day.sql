-- (campaign, UTC day, org, brand set, feature, workflow, COST NAME, AUDIENCE) rollup
-- for the org-scoped GET /v1/stats/costs grouped by costName AND audienceId
-- (features-service's offer-sourcing "unrecorded evidence" read:
-- groupBy=campaignId,audienceId,costName, org + brand + the offer's channel and
-- sourcing slugs, often startedBefore=<UTC day end>).
--
-- WHY. No rollup carried both dimensions (0052 has the audience, 0053 the cost
-- name), so the read ran live: an INNER JOIN of the brand's whole history to the
-- cost ledger. Doc Dinners (org 91e76989, brand 75d7e3e8, 656k runs in scope):
-- a parallel seq scan of all 2.77M cost rows, 508k joined rows sorted for
-- COUNT(DISTINCT r.id), 12-19 s on the loaded box and past the 30 s statement
-- timeout under load: 10 x 500 in two hours for brands f4d73dab, a179bbd9 and
-- 75d7e3e8, each one a 500 of features-service's offer sourcing (2026-11-06).
--
-- GRAIN. 0053's table + the EFFECTIVE audience COALESCE(rc.audience_id,
-- r.audience_id). A run sits in one group per DISTINCT (cost name, effective
-- audience) pair among its cost rows, none without a row (the live INNER JOIN);
-- run_count is COUNT(DISTINCT r.id) per group. Its own table: adding the audience
-- to 0053's grain would count such a run once per audience in every cost-name read.
--
-- RUN COUNT (0053's rule, keyed on the pair). A cost row entering a group adds
-- its run only when no OTHER row of that run carries the same pair; a row leaving
-- removes it only when none remains. Every trigger upserts the key row FIRST
-- (taking its lock: all rows of one run and one pair share it) and checks the
-- other rows in a LATER statement, whose fresh snapshot sees what a concurrent
-- writer of the same run committed. A status / amount / quantity change leaves
-- membership untouched. A run's own audience is part of the pair of its rows
-- with no audience, so a run update of audience_id moves the whole run.
--
-- MIN/MAX and BYTE-IDENTITY as 0053. READINESS: stamp `cost_name_audience_day`;
-- on a database that already holds runs the table starts EMPTY and the read stays
-- live until `scripts/rebuild-stats-rollup.ts cost_name_audience_day` has rebuilt
-- and stamped it.
--
-- BOOT-WINDOW SAFE. One empty table, one index on it, functions, triggers.

CREATE TABLE IF NOT EXISTS stats_rollup_cost_name_audience_day (
  campaign_id text,
  day date NOT NULL,
  organization_id uuid,
  brand_ids text[],
  feature_slug text,
  workflow_slug text,
  cost_name text NOT NULL,
  audience_id text,
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
  quantity numeric NOT NULL DEFAULT 0,
  CONSTRAINT stats_rollup_cost_name_audience_day_key
    UNIQUE NULLS NOT DISTINCT (campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, cost_name, audience_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_stats_rollup_cost_name_audience_day_org
  ON stats_rollup_cost_name_audience_day (organization_id, feature_slug, day);
--> statement-breakpoint

-- Add runs (p_runs > 0 widens min/max, < 0 marks stale, 0 leaves them) and cost
-- amounts (signed) to one group. Atomic status literals only (cost predicate doctrine).
CREATE OR REPLACE FUNCTION stats_rollup_cna_add(
  p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text,
  p_cost_name text, p_audience text, p_runs bigint, p_status text, p_count bigint, p_gross numeric, p_net numeric, p_quantity numeric
) RETURNS void AS $$
DECLARE
  v_status text := CASE WHEN p_status IN ('actual', 'provisioned', 'cancelled', 'refunded') THEN p_status END;
BEGIN
  INSERT INTO stats_rollup_cost_name_audience_day (
    campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, cost_name, audience_id,
    run_count, min_started_at, max_started_at, minmax_stale,
    n_actual, n_provisioned, n_cancelled, n_refunded,
    gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
    net_actual, net_provisioned, net_refunded, quantity
  ) VALUES (
    p_campaign, (p_started AT TIME ZONE 'UTC')::date, p_org, p_brands, p_feature, p_workflow, p_cost_name, p_audience,
    p_runs,
    CASE WHEN p_runs > 0 THEN p_started END,
    CASE WHEN p_runs > 0 THEN p_started END,
    p_runs < 0,
    CASE WHEN v_status = 'actual'      THEN p_count ELSE 0 END,
    CASE WHEN v_status = 'provisioned' THEN p_count ELSE 0 END,
    CASE WHEN v_status = 'cancelled'   THEN p_count ELSE 0 END,
    CASE WHEN v_status = 'refunded'    THEN p_count ELSE 0 END,
    CASE WHEN v_status = 'actual'      THEN p_gross ELSE 0 END,
    CASE WHEN v_status = 'provisioned' THEN p_gross ELSE 0 END,
    CASE WHEN v_status = 'cancelled'   THEN p_gross ELSE 0 END,
    CASE WHEN v_status = 'refunded'    THEN p_gross ELSE 0 END,
    CASE WHEN v_status = 'actual'      THEN p_net ELSE 0 END,
    CASE WHEN v_status = 'provisioned' THEN p_net ELSE 0 END,
    CASE WHEN v_status = 'refunded'    THEN p_net ELSE 0 END,
    COALESCE(p_quantity, 0)
  )
  ON CONFLICT ON CONSTRAINT stats_rollup_cost_name_audience_day_key DO UPDATE SET
    run_count         = stats_rollup_cost_name_audience_day.run_count + EXCLUDED.run_count,
    min_started_at    = CASE WHEN EXCLUDED.run_count > 0
                          THEN LEAST(stats_rollup_cost_name_audience_day.min_started_at, EXCLUDED.min_started_at)
                          ELSE stats_rollup_cost_name_audience_day.min_started_at END,
    max_started_at    = CASE WHEN EXCLUDED.run_count > 0
                          THEN GREATEST(stats_rollup_cost_name_audience_day.max_started_at, EXCLUDED.max_started_at)
                          ELSE stats_rollup_cost_name_audience_day.max_started_at END,
    minmax_stale      = stats_rollup_cost_name_audience_day.minmax_stale OR EXCLUDED.run_count < 0,
    n_actual          = stats_rollup_cost_name_audience_day.n_actual          + EXCLUDED.n_actual,
    n_provisioned     = stats_rollup_cost_name_audience_day.n_provisioned     + EXCLUDED.n_provisioned,
    n_cancelled       = stats_rollup_cost_name_audience_day.n_cancelled       + EXCLUDED.n_cancelled,
    n_refunded        = stats_rollup_cost_name_audience_day.n_refunded        + EXCLUDED.n_refunded,
    gross_actual      = stats_rollup_cost_name_audience_day.gross_actual      + EXCLUDED.gross_actual,
    gross_provisioned = stats_rollup_cost_name_audience_day.gross_provisioned + EXCLUDED.gross_provisioned,
    gross_cancelled   = stats_rollup_cost_name_audience_day.gross_cancelled   + EXCLUDED.gross_cancelled,
    gross_refunded    = stats_rollup_cost_name_audience_day.gross_refunded    + EXCLUDED.gross_refunded,
    net_actual        = stats_rollup_cost_name_audience_day.net_actual        + EXCLUDED.net_actual,
    net_provisioned   = stats_rollup_cost_name_audience_day.net_provisioned   + EXCLUDED.net_provisioned,
    net_refunded      = stats_rollup_cost_name_audience_day.net_refunded      + EXCLUDED.net_refunded,
    quantity          = stats_rollup_cost_name_audience_day.quantity          + EXCLUDED.quantity;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Move a whole run (one run per (cost name, effective audience) pair it carries +
-- every cost row) into (p_sign = 1) or out of (p_sign = -1) the groups of the
-- given run identity; p_run_audience = the run's own audience under that identity.
CREATE OR REPLACE FUNCTION stats_rollup_cna_move_run(
  p_run_id uuid, p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text,
  p_run_audience text, p_sign bigint
) RETURNS void AS $$
DECLARE
  g record;
  v_first boolean;
  v_name text := NULL;
  v_aud text := NULL;
  v_any boolean := false;
BEGIN
  FOR g IN
    SELECT cost_name, COALESCE(audience_id, p_run_audience) AS aud, status, count(*) AS n,
      SUM(total_cost_in_usd_cents) AS gross,
      SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) AS net, SUM(quantity) AS quantity
    FROM runs_costs WHERE run_id = p_run_id
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
  LOOP
    -- The run counts once per pair: on the first status row of each pair.
    v_first := NOT v_any OR v_name IS DISTINCT FROM g.cost_name OR v_aud IS DISTINCT FROM g.aud;
    v_any := true;
    v_name := g.cost_name;
    v_aud := g.aud;
    PERFORM stats_rollup_cna_add(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow,
      g.cost_name, g.aud, CASE WHEN v_first THEN p_sign ELSE 0 END,
      g.status, p_sign * g.n, p_sign * g.gross, p_sign * g.net, p_sign * g.quantity);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_cna_on_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.brand_ids IS DISTINCT FROM OLD.brand_ids
       OR NEW.feature_slug IS DISTINCT FROM OLD.feature_slug
       OR NEW.workflow_slug IS DISTINCT FROM OLD.workflow_slug
       OR NEW.audience_id IS DISTINCT FROM OLD.audience_id THEN
      PERFORM stats_rollup_cna_move_run(NEW.id, OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids,
        OLD.feature_slug, OLD.workflow_slug, OLD.audience_id, -1);
      PERFORM stats_rollup_cna_move_run(NEW.id, NEW.campaign_id, NEW.started_at, NEW.organization_id, NEW.brand_ids,
        NEW.feature_slug, NEW.workflow_slug, NEW.audience_id, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: the run and its cost rows are still visible (their own
    -- cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_cna_move_run(OLD.id, OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids,
      OLD.feature_slug, OLD.workflow_slug, OLD.audience_id, -1);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_cna_on_cost() RETURNS trigger AS $$
DECLARE
  r record;
  v_aud text;
  -- Membership moves only when the row changes run, cost name or audience.
  v_moves boolean := TG_OP <> 'UPDATE'
    OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.cost_name IS DISTINCT FROM OLD.cost_name
    OR NEW.audience_id IS DISTINCT FROM OLD.audience_id;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug, audience_id
      INTO r FROM runs WHERE id = OLD.run_id;
    -- Run gone = the cascade of a run delete, already accounted for.
    IF FOUND THEN
      v_aud := COALESCE(OLD.audience_id, r.audience_id);
      -- Money out first: takes the group row's lock before the membership read.
      PERFORM stats_rollup_cna_add(r.campaign_id, r.started_at, r.organization_id, r.brand_ids,
        r.feature_slug, r.workflow_slug, OLD.cost_name, v_aud, 0,
        OLD.status, -1, -OLD.total_cost_in_usd_cents,
        -COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents), -OLD.quantity);
      IF v_moves AND NOT EXISTS (
        SELECT 1 FROM runs_costs
        WHERE run_id = OLD.run_id AND cost_name = OLD.cost_name AND id <> OLD.id
          AND COALESCE(audience_id, r.audience_id) IS NOT DISTINCT FROM v_aud
      ) THEN
        PERFORM stats_rollup_cna_add(r.campaign_id, r.started_at, r.organization_id, r.brand_ids,
          r.feature_slug, r.workflow_slug, OLD.cost_name, v_aud, -1, NULL, 0, 0, 0, 0);
      END IF;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug, audience_id
      INTO r FROM runs WHERE id = NEW.run_id;
    IF FOUND THEN
      v_aud := COALESCE(NEW.audience_id, r.audience_id);
      PERFORM stats_rollup_cna_add(r.campaign_id, r.started_at, r.organization_id, r.brand_ids,
        r.feature_slug, r.workflow_slug, NEW.cost_name, v_aud, 0,
        NEW.status, 1, NEW.total_cost_in_usd_cents,
        COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents), NEW.quantity);
      IF v_moves AND NOT EXISTS (
        SELECT 1 FROM runs_costs
        WHERE run_id = NEW.run_id AND cost_name = NEW.cost_name AND id <> NEW.id
          AND COALESCE(audience_id, r.audience_id) IS NOT DISTINCT FROM v_aud
      ) THEN
        PERFORM stats_rollup_cna_add(r.campaign_id, r.started_at, r.organization_id, r.brand_ids,
          r.feature_slug, r.workflow_slug, NEW.cost_name, v_aud, 1, NULL, 0, 0, 0, 0);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_cna_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_cna_run_update
  AFTER UPDATE OF campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug, audience_id ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_cna_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_cna_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_cna_run_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_cna_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_cna_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_cna_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF run_id, cost_name, audience_id, status, quantity, total_cost_in_usd_cents, net_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_cna_on_cost();
--> statement-breakpoint

-- Fresh database: nothing to backfill, the triggers see every row from the first.
INSERT INTO stats_rollups (name, ready_at)
SELECT 'cost_name_audience_day', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
