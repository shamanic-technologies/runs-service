-- Brand-history cost reads (GET /v1/stats/costs) answered from the (campaign, UTC
-- day) rollup of migration 0037, extended to EVERY run.
--
-- WHY. features-service asks GET /v1/stats/costs for a brand's whole history
-- (org + brand + its feature slugs, groupBy workflowSlug / campaignId /
-- workflowSlug,campaignId, sometimes bounded by startedAfter / startedBefore)
-- from several modules, several times a minute. Each call scanned the brand's
-- 500k+ runs and their cost rows, 1-3 s, several always in flight: ~3.6 of the
-- box's 8 cores went to Postgres steadily (pg_stat_activity sampling,
-- 2026-10-08). The answer only changes when a run or a cost row lands.
--
-- SAME GRAIN, SO THE SAME TABLES. 0037 already keeps (campaign_id, day,
-- organization_id, brand_ids, feature_slug, workflow_slug[, cost_source]) for
-- runs that carry a campaign. This migration:
--   1. rolls up runs WITHOUT a campaign too (campaign_id becomes nullable; a NULL
--      campaign is its own group, UNIQUE NULLS NOT DISTINCT already says so).
--      Every 0037 read filters on a campaign, so the new rows never reach them;
--   2. keeps min/max started_at per run group, so GET /v1/stats/costs can serve
--      its exact minStartedAt / maxStartedAt. A removed run (delete, or a key
--      move by POST /internal/transfer-brand) cannot shrink a min/max without a
--      scan, so it marks the group `minmax_stale` instead; the read takes every
--      day holding a stale group from the live ledger. A rebuild clears it.
--
-- READINESS. On a database that already holds runs, the tables lack the
-- NULL-campaign history and exact min/max, so the `campaign_day` stamp is removed
-- here and every read it gates (the 0037 campaign-family reads included) uses the
-- live query until `scripts/rebuild-stats-rollup.ts campaign_day` has rebuilt the
-- tables and stamped them again. Run it right after the deploy. A fresh (empty)
-- database keeps its stamp.
--
-- BOOT-WINDOW SAFE. Catalog-only ALTERs (DROP NOT NULL, ADD COLUMN with a
-- constant default) and function replacements. The two indexes are built
-- CONCURRENTLY out-of-band on prod first, so IF NOT EXISTS no-ops there.

ALTER TABLE stats_rollup_campaign_runs ALTER COLUMN campaign_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE stats_rollup_campaign_costs ALTER COLUMN campaign_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE stats_rollup_campaign_runs ADD COLUMN IF NOT EXISTS min_started_at timestamptz;
--> statement-breakpoint
ALTER TABLE stats_rollup_campaign_runs ADD COLUMN IF NOT EXISTS max_started_at timestamptz;
--> statement-breakpoint
ALTER TABLE stats_rollup_campaign_runs ADD COLUMN IF NOT EXISTS minmax_stale boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Org-scoped reads (the unique key leads with campaign_id, which they do not filter on).
CREATE INDEX IF NOT EXISTS idx_stats_rollup_campaign_runs_org
  ON stats_rollup_campaign_runs (organization_id, feature_slug, day);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stats_rollup_campaign_costs_org
  ON stats_rollup_campaign_costs (organization_id, feature_slug, day);
--> statement-breakpoint

-- Add (p_delta > 0) or remove (p_delta < 0) runs of one group. Every run,
-- campaign or not. A removal marks the group's min/max stale (it may have been
-- the min or the max; recomputing would scan the day).
CREATE OR REPLACE FUNCTION stats_rollup_campaign_add_runs(
  p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text, p_delta bigint
) RETURNS void AS $$
BEGIN
  IF p_delta > 0 THEN
    INSERT INTO stats_rollup_campaign_runs (
      campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug,
      run_count, min_started_at, max_started_at, minmax_stale
    ) VALUES (
      p_campaign, (p_started AT TIME ZONE 'UTC')::date, p_org, p_brands, p_feature, p_workflow,
      p_delta, p_started, p_started, false
    )
    ON CONFLICT ON CONSTRAINT stats_rollup_campaign_runs_key DO UPDATE SET
      run_count      = stats_rollup_campaign_runs.run_count + EXCLUDED.run_count,
      min_started_at = LEAST(stats_rollup_campaign_runs.min_started_at, EXCLUDED.min_started_at),
      max_started_at = GREATEST(stats_rollup_campaign_runs.max_started_at, EXCLUDED.max_started_at);
  ELSE
    INSERT INTO stats_rollup_campaign_runs (
      campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug,
      run_count, min_started_at, max_started_at, minmax_stale
    ) VALUES (
      p_campaign, (p_started AT TIME ZONE 'UTC')::date, p_org, p_brands, p_feature, p_workflow,
      p_delta, NULL, NULL, true
    )
    ON CONFLICT ON CONSTRAINT stats_rollup_campaign_runs_key DO UPDATE SET
      run_count    = stats_rollup_campaign_runs.run_count + EXCLUDED.run_count,
      minmax_stale = true;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Same body as 0037 without the "no campaign = not rolled up" guard.
CREATE OR REPLACE FUNCTION stats_rollup_campaign_add_cost(
  p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text,
  p_source text, p_status text, p_count bigint, p_gross numeric, p_net numeric
) RETURNS void AS $$
BEGIN
  IF p_status NOT IN ('actual', 'provisioned', 'cancelled', 'refunded') THEN
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

CREATE OR REPLACE FUNCTION stats_rollup_campaign_move_run_costs(
  p_run_id uuid, p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text, p_sign bigint
) RETURNS void AS $$
DECLARE
  g record;
BEGIN
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

-- Existing database: un-stamp until the rebuild (see READINESS).
DELETE FROM stats_rollups
WHERE name = 'campaign_day' AND EXISTS (SELECT 1 FROM runs);
