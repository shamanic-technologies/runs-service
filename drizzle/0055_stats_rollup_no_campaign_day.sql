-- GET /internal/stats/costs/no-campaign/monthly (staff, billing's absorbed-costs
-- read behind dashboard v2 Monitoring > Customers) grouped EVERY platform-projected
-- cost row of the fleet by (org, UTC month, cost name) on each call: 1.32M rows,
-- a seq scan + a 109 MB external sort, 95 s on prod at box load ~89 (2026-10-23),
-- past the 30 s stats statement_timeout, so every call 500'd.
--
-- Same figures from a rollup maintained ON WRITE: platform-projected cost rows
-- with an org, per (cost row's org, UTC day of created_at, cost name,
-- run_has_campaign) -> n, gross, net. A pure function of the cost row, so each
-- trigger is an atomic +/- upsert (no read, no lock). NULL run_has_campaign
-- (not known yet) is its own group, as in the live read. n carries the matched
-- row count so the read renders '0' exactly when the live SUM matched no row.
--
-- BOOT-WINDOW SAFE: an empty table, functions, a trigger. An existing database is
-- filled by `scripts/rebuild-stats-rollup.ts no_campaign_day` after the deploy;
-- until it stamps `no_campaign_day`, the read keeps the live query.

CREATE TABLE IF NOT EXISTS stats_rollup_no_campaign_day (
  organization_id uuid NOT NULL,
  day date NOT NULL,
  cost_name text NOT NULL,
  run_has_campaign boolean,
  n bigint NOT NULL DEFAULT 0,
  gross numeric NOT NULL DEFAULT 0,
  net numeric NOT NULL DEFAULT 0,
  CONSTRAINT stats_rollup_no_campaign_day_key
    UNIQUE NULLS NOT DISTINCT (organization_id, day, cost_name, run_has_campaign)
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_no_campaign_day_add(
  p_org uuid, p_projected boolean, p_created timestamptz, p_name text, p_has boolean,
  p_sign bigint, p_gross numeric, p_net numeric
) RETURNS void AS $$
BEGIN
  IF p_org IS NULL OR p_projected IS NOT TRUE THEN
    RETURN;
  END IF;
  INSERT INTO stats_rollup_no_campaign_day AS d (organization_id, day, cost_name, run_has_campaign, n, gross, net)
  VALUES (p_org, (p_created AT TIME ZONE 'UTC')::date, p_name, p_has, p_sign, p_sign * p_gross, p_sign * p_net)
  ON CONFLICT ON CONSTRAINT stats_rollup_no_campaign_day_key DO UPDATE SET
    n     = d.n + EXCLUDED.n,
    gross = d.gross + EXCLUDED.gross,
    net   = d.net + EXCLUDED.net;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_no_campaign_day_on_cost() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM stats_rollup_no_campaign_day_add(OLD.organization_id, OLD.is_platform_projected, OLD.created_at,
      OLD.cost_name, OLD.run_has_campaign, -1, OLD.total_cost_in_usd_cents,
      COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM stats_rollup_no_campaign_day_add(NEW.organization_id, NEW.is_platform_projected, NEW.created_at,
      NEW.cost_name, NEW.run_has_campaign, 1, NEW.total_cost_in_usd_cents,
      COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_no_campaign_day_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_no_campaign_day_write
  AFTER INSERT OR DELETE OR UPDATE OF organization_id, status, cost_source, created_at, cost_name,
    run_has_campaign, total_cost_in_usd_cents, net_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_no_campaign_day_on_cost();
--> statement-breakpoint

INSERT INTO stats_rollups (name, ready_at)
SELECT 'no_campaign_day', now()
WHERE NOT EXISTS (SELECT 1 FROM runs_costs)
ON CONFLICT (name) DO NOTHING;
