-- (campaign, UTC day, org, brand set, feature, workflow, AUDIENCE) rollup for the
-- org-scoped GET /v1/stats/costs grouped by audienceId (features-service's
-- per-audience x workflow spend: groupBy=audienceId,workflowSlug, org + brand +
-- campaign family + feature slugs, optionally startedBefore).
--
-- WHY. Live that read LEFT JOINs the brand's whole history to the cost ledger
-- and sorts every joined row for COUNT(DISTINCT r.id): 21-29 s for the busiest
-- brand on a loaded box (314k runs, 408k joined rows, 40 MB external sort), and
-- ~345 statement-timeout cancels (each a 500 to features-service) in 30 h
-- (2026-10-19). The answer only changes when a run or a cost row lands.
--
-- WHY NOT THE 0037/0041 TABLES. The audience is a COST-ROW dimension: the live
-- group is COALESCE(rc.audience_id, r.audience_id), so one run sits in one group
-- per DISTINCT effective audience among its cost rows (or under its own
-- audience when it has none), and run_count is COUNT(DISTINCT r.id) per group.
-- Adding the audience to the campaign-day grain would make every other read of
-- those tables count such a run twice.
--
-- MEMBERSHIP. A run R belongs to the audience set
--   S(R) = { COALESCE(rc.audience_id, R.audience_id) : rc a cost row of R }
--          or { R.audience_id } when R has no cost row,
-- and adds 1 run (and its started_at to min/max) to every group (key(R), a), a in
-- S(R). A cost write recomputes S before / after the write and applies the
-- difference. Before = the run's current rows minus NEW plus OLD. The per-run
-- advisory lock taken FIRST serialises concurrent cost writes of one run, and
-- the set is read in a LATER statement, whose fresh snapshot sees what the
-- other writer committed (0035's lock-then-read rule). In prod every cost row's
-- audience equals its run's (2.17M of 2.17M, 2026-10-19), so S(R) is
-- { R.audience_id } and membership never actually moves; the general rule keeps
-- the rollup exact if a writer ever tags a cost row differently.
--
-- MIN/MAX. As 0041: an addition widens with LEAST/GREATEST, a removal marks the
-- group `minmax_stale` (the read takes that day live, the repair pass recounts
-- it). BYTE-IDENTITY: as 0034/0037, matched-row count per status beside the sums.
--
-- READINESS. Stamp `audience_day`. On a database that already holds runs the
-- tables start EMPTY and the read stays live until
-- `scripts/rebuild-stats-rollup.ts audience_day` has rebuilt and stamped them.
--
-- BOOT-WINDOW SAFE. Two empty tables, two indexes on them, functions, triggers.

CREATE TABLE IF NOT EXISTS stats_rollup_audience_runs (
  campaign_id text,
  day date NOT NULL,
  organization_id uuid,
  brand_ids text[],
  feature_slug text,
  workflow_slug text,
  audience_id text,
  run_count bigint NOT NULL DEFAULT 0,
  min_started_at timestamptz,
  max_started_at timestamptz,
  minmax_stale boolean NOT NULL DEFAULT false,
  CONSTRAINT stats_rollup_audience_runs_key
    UNIQUE NULLS NOT DISTINCT (campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, audience_id)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS stats_rollup_audience_costs (
  campaign_id text,
  day date NOT NULL,
  organization_id uuid,
  brand_ids text[],
  feature_slug text,
  workflow_slug text,
  audience_id text,
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
  CONSTRAINT stats_rollup_audience_costs_key
    UNIQUE NULLS NOT DISTINCT (campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, audience_id)
);
--> statement-breakpoint

-- Org-scoped reads (the unique key leads with campaign_id, which a whole-brand read does not filter on).
CREATE INDEX IF NOT EXISTS idx_stats_rollup_audience_runs_org
  ON stats_rollup_audience_runs (organization_id, feature_slug, day);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stats_rollup_audience_costs_org
  ON stats_rollup_audience_costs (organization_id, feature_slug, day);
--> statement-breakpoint

-- Add (p_delta > 0) or remove (p_delta < 0) runs of one group (0041's body).
CREATE OR REPLACE FUNCTION stats_rollup_audience_add_runs(
  p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text,
  p_audience text, p_delta bigint
) RETURNS void AS $$
BEGIN
  IF p_delta > 0 THEN
    INSERT INTO stats_rollup_audience_runs (
      campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, audience_id,
      run_count, min_started_at, max_started_at, minmax_stale
    ) VALUES (
      p_campaign, (p_started AT TIME ZONE 'UTC')::date, p_org, p_brands, p_feature, p_workflow, p_audience,
      p_delta, p_started, p_started, false
    )
    ON CONFLICT ON CONSTRAINT stats_rollup_audience_runs_key DO UPDATE SET
      run_count      = stats_rollup_audience_runs.run_count + EXCLUDED.run_count,
      min_started_at = LEAST(stats_rollup_audience_runs.min_started_at, EXCLUDED.min_started_at),
      max_started_at = GREATEST(stats_rollup_audience_runs.max_started_at, EXCLUDED.max_started_at);
  ELSE
    INSERT INTO stats_rollup_audience_runs (
      campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, audience_id,
      run_count, min_started_at, max_started_at, minmax_stale
    ) VALUES (
      p_campaign, (p_started AT TIME ZONE 'UTC')::date, p_org, p_brands, p_feature, p_workflow, p_audience,
      p_delta, NULL, NULL, true
    )
    ON CONFLICT ON CONSTRAINT stats_rollup_audience_runs_key DO UPDATE SET
      run_count    = stats_rollup_audience_runs.run_count + EXCLUDED.run_count,
      minmax_stale = true;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Add (positive count) or remove (negative count) cost amounts of one group.
-- Atomic status literals only (cost predicate doctrine).
CREATE OR REPLACE FUNCTION stats_rollup_audience_add_cost(
  p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text,
  p_audience text, p_status text, p_count bigint, p_gross numeric, p_net numeric
) RETURNS void AS $$
BEGIN
  IF p_status NOT IN ('actual', 'provisioned', 'cancelled', 'refunded') THEN
    RETURN;
  END IF;
  INSERT INTO stats_rollup_audience_costs (
    campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, audience_id,
    n_actual, n_provisioned, n_cancelled, n_refunded,
    gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
    net_actual, net_provisioned, net_refunded
  ) VALUES (
    p_campaign, (p_started AT TIME ZONE 'UTC')::date, p_org, p_brands, p_feature, p_workflow, p_audience,
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
  ON CONFLICT ON CONSTRAINT stats_rollup_audience_costs_key DO UPDATE SET
    n_actual          = stats_rollup_audience_costs.n_actual          + EXCLUDED.n_actual,
    n_provisioned     = stats_rollup_audience_costs.n_provisioned     + EXCLUDED.n_provisioned,
    n_cancelled       = stats_rollup_audience_costs.n_cancelled       + EXCLUDED.n_cancelled,
    n_refunded        = stats_rollup_audience_costs.n_refunded        + EXCLUDED.n_refunded,
    gross_actual      = stats_rollup_audience_costs.gross_actual      + EXCLUDED.gross_actual,
    gross_provisioned = stats_rollup_audience_costs.gross_provisioned + EXCLUDED.gross_provisioned,
    gross_cancelled   = stats_rollup_audience_costs.gross_cancelled   + EXCLUDED.gross_cancelled,
    gross_refunded    = stats_rollup_audience_costs.gross_refunded    + EXCLUDED.gross_refunded,
    net_actual        = stats_rollup_audience_costs.net_actual        + EXCLUDED.net_actual,
    net_provisioned   = stats_rollup_audience_costs.net_provisioned   + EXCLUDED.net_provisioned,
    net_refunded      = stats_rollup_audience_costs.net_refunded      + EXCLUDED.net_refunded;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Serialise every rollup write of one run (released at commit). Taken in its own
-- statement BEFORE the run's cost rows are read.
CREATE OR REPLACE FUNCTION stats_rollup_audience_lock_run(p_run_id uuid) RETURNS void AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(52052, hashtext(p_run_id::text));
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- S(R) from the run's cost rows as seen now, minus the row `p_exclude` (NULL =
-- none), plus one extra row of effective audience `p_extra` when `p_with_extra`.
-- No row at all = { run audience }. NULL is a member like any other value.
CREATE OR REPLACE FUNCTION stats_rollup_audience_set(
  p_run_id uuid, p_run_audience text, p_exclude uuid, p_with_extra boolean, p_extra text
) RETURNS text[] AS $$
DECLARE
  v_set text[];
  v_rows bigint;
BEGIN
  SELECT array_agg(DISTINCT a), count(*) INTO v_set, v_rows FROM (
    SELECT COALESCE(audience_id, p_run_audience) AS a FROM runs_costs
    WHERE run_id = p_run_id AND (p_exclude IS NULL OR id <> p_exclude)
    UNION ALL
    SELECT p_extra WHERE p_with_extra
  ) s;
  IF v_rows = 0 THEN
    RETURN ARRAY[p_run_audience];
  END IF;
  RETURN v_set;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Move run membership from set p_old to set p_new within the run's group key.
CREATE OR REPLACE FUNCTION stats_rollup_audience_apply_sets(
  p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text,
  p_old text[], p_new text[]
) RETURNS void AS $$
DECLARE
  a record;
BEGIN
  FOR a IN SELECT o AS aud FROM unnest(p_old) o
           WHERE NOT EXISTS (SELECT 1 FROM unnest(p_new) n WHERE n IS NOT DISTINCT FROM o) LOOP
    PERFORM stats_rollup_audience_add_runs(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, a.aud, -1);
  END LOOP;
  FOR a IN SELECT n AS aud FROM unnest(p_new) n
           WHERE NOT EXISTS (SELECT 1 FROM unnest(p_old) o WHERE o IS NOT DISTINCT FROM n) LOOP
    PERFORM stats_rollup_audience_add_runs(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, a.aud, 1);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Move a whole run (membership + every cost row) into (p_sign = 1) or out of
-- (p_sign = -1) the groups of the given run identity.
CREATE OR REPLACE FUNCTION stats_rollup_audience_move_run(
  p_run_id uuid, p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text,
  p_run_audience text, p_sign bigint
) RETURNS void AS $$
DECLARE
  g record;
BEGIN
  FOR g IN SELECT unnest(stats_rollup_audience_set(p_run_id, p_run_audience, NULL, false, NULL)) AS aud LOOP
    PERFORM stats_rollup_audience_add_runs(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, g.aud, p_sign);
  END LOOP;
  FOR g IN
    SELECT COALESCE(audience_id, p_run_audience) AS aud, status, count(*) AS n,
      SUM(total_cost_in_usd_cents) AS gross,
      SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) AS net
    FROM runs_costs WHERE run_id = p_run_id
    GROUP BY 1, 2
  LOOP
    PERFORM stats_rollup_audience_add_cost(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow,
      g.aud, g.status, p_sign * g.n, p_sign * g.gross, p_sign * g.net);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_audience_on_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A new run has no cost row yet (FK): S = { its audience }.
    PERFORM stats_rollup_audience_add_runs(NEW.campaign_id, NEW.started_at, NEW.organization_id, NEW.brand_ids,
      NEW.feature_slug, NEW.workflow_slug, NEW.audience_id, 1);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.brand_ids IS DISTINCT FROM OLD.brand_ids
       OR NEW.feature_slug IS DISTINCT FROM OLD.feature_slug
       OR NEW.workflow_slug IS DISTINCT FROM OLD.workflow_slug
       OR NEW.audience_id IS DISTINCT FROM OLD.audience_id THEN
      PERFORM stats_rollup_audience_lock_run(NEW.id);
      PERFORM stats_rollup_audience_move_run(NEW.id, OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids,
        OLD.feature_slug, OLD.workflow_slug, OLD.audience_id, -1);
      PERFORM stats_rollup_audience_move_run(NEW.id, NEW.campaign_id, NEW.started_at, NEW.organization_id, NEW.brand_ids,
        NEW.feature_slug, NEW.workflow_slug, NEW.audience_id, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: the run and its cost rows are still visible (their own
    -- cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_audience_lock_run(OLD.id);
    PERFORM stats_rollup_audience_move_run(OLD.id, OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids,
      OLD.feature_slug, OLD.workflow_slug, OLD.audience_id, -1);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_audience_on_cost() RETURNS trigger AS $$
DECLARE
  r record;
  v_moves boolean := TG_OP <> 'UPDATE'
    OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.audience_id IS DISTINCT FROM OLD.audience_id;
  v_old_in boolean;
BEGIN
  -- OLD side: money out; membership of OLD's run recomputed when the row left
  -- that run or changed audience.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF v_moves THEN
      PERFORM stats_rollup_audience_lock_run(OLD.run_id);
    END IF;
    SELECT campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug, audience_id
      INTO r FROM runs WHERE id = OLD.run_id;
    -- Run gone = the cascade of a run delete, already accounted for.
    IF FOUND THEN
      PERFORM stats_rollup_audience_add_cost(r.campaign_id, r.started_at, r.organization_id, r.brand_ids,
        r.feature_slug, r.workflow_slug, COALESCE(OLD.audience_id, r.audience_id),
        OLD.status, -1, -OLD.total_cost_in_usd_cents, -COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents));
      IF v_moves THEN
        -- Before = the run's rows now, minus NEW if it sits in this run, plus OLD.
        -- After  = the run's rows now.
        PERFORM stats_rollup_audience_apply_sets(r.campaign_id, r.started_at, r.organization_id, r.brand_ids,
          r.feature_slug, r.workflow_slug,
          stats_rollup_audience_set(OLD.run_id, r.audience_id,
            CASE WHEN TG_OP = 'UPDATE' AND NEW.run_id = OLD.run_id THEN NEW.id END,
            true, COALESCE(OLD.audience_id, r.audience_id)),
          stats_rollup_audience_set(OLD.run_id, r.audience_id, NULL, false, NULL));
      END IF;
    END IF;
  END IF;
  -- NEW side: money in; membership of NEW's run (unless it is OLD's run, done above).
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_old_in := TG_OP = 'UPDATE' AND NEW.run_id = OLD.run_id;
    IF v_moves AND NOT v_old_in THEN
      PERFORM stats_rollup_audience_lock_run(NEW.run_id);
    END IF;
    SELECT campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug, audience_id
      INTO r FROM runs WHERE id = NEW.run_id;
    IF FOUND THEN
      PERFORM stats_rollup_audience_add_cost(r.campaign_id, r.started_at, r.organization_id, r.brand_ids,
        r.feature_slug, r.workflow_slug, COALESCE(NEW.audience_id, r.audience_id),
        NEW.status, 1, NEW.total_cost_in_usd_cents, COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents));
      IF v_moves AND NOT v_old_in THEN
        PERFORM stats_rollup_audience_apply_sets(r.campaign_id, r.started_at, r.organization_id, r.brand_ids,
          r.feature_slug, r.workflow_slug,
          stats_rollup_audience_set(NEW.run_id, r.audience_id, NEW.id, false, NULL),
          stats_rollup_audience_set(NEW.run_id, r.audience_id, NULL, false, NULL));
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_audience_run_insert ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_audience_run_insert AFTER INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_audience_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_audience_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_audience_run_update
  AFTER UPDATE OF campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug, audience_id ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_audience_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_audience_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_audience_run_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_audience_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_audience_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_audience_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF run_id, audience_id, status, total_cost_in_usd_cents, net_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_audience_on_cost();
--> statement-breakpoint

-- Fresh database: nothing to backfill, the triggers see every row from the first.
INSERT INTO stats_rollups (name, ready_at)
SELECT 'audience_day', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
