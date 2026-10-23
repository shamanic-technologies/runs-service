-- The staff monthly no-campaign read groups cost rows by their CURRENT org. A
-- brand transfer (POST /internal/transfer-brand) moves every past cost row of the
-- brand to the target org, so the target read the brand's whole history: Doc
-- Dinners (91e76989) showed ~$5.6k of campaign spend the agency org (b645207b)
-- had spent and paid before the brand moved on 2026-09-27/28 (billing-service,
-- 2026-10-23).
--
-- The org that INCURRED a cost row is the org its run was opened under: the
-- bronze run.created payload's organizationId (append-only, never touched by a
-- transfer, which mutates silver only). The rollup now also keys on it
-- (origin_org_id, NULL when the run has no run.created event: helper-inserted
-- test rows; the read then falls back to the row's org). The incurred basis is
-- served by GET /internal/stats/costs/no-campaign/monthly?orgBasis=incurred.
--
-- BOOT-WINDOW SAFE: a nullable column, a constraint swap on a ~tens-of-thousands
-- row table, functions. Rows written before this have origin NULL, which is
-- still exact for the current-org basis (origin is only an extra key), so the
-- `no_campaign_day` stamp stays valid. The incurred basis needs its own stamp,
-- `no_campaign_origin`, set by `scripts/rebuild-stats-rollup.ts no_campaign_day`.

ALTER TABLE stats_rollup_no_campaign_day ADD COLUMN IF NOT EXISTS origin_org_id uuid;
--> statement-breakpoint
ALTER TABLE stats_rollup_no_campaign_day DROP CONSTRAINT IF EXISTS stats_rollup_no_campaign_day_key;
--> statement-breakpoint
ALTER TABLE stats_rollup_no_campaign_day ADD CONSTRAINT stats_rollup_no_campaign_day_key
  UNIQUE NULLS NOT DISTINCT (organization_id, day, cost_name, run_has_campaign, origin_org_id);
--> statement-breakpoint

-- The org a run was opened under, from bronze (one idx_rle_run_occurred probe).
CREATE OR REPLACE FUNCTION run_origin_org(p_run_id uuid) RETURNS uuid AS $$
  SELECT (payload->>'organizationId')::uuid
    FROM run_lifecycle_events
   WHERE run_id = p_run_id AND event_type = 'run.created'
   ORDER BY occurred_at
   LIMIT 1
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

DROP FUNCTION IF EXISTS stats_rollup_no_campaign_day_add(uuid, boolean, timestamptz, text, boolean, bigint, numeric, numeric);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_no_campaign_day_add(
  p_org uuid, p_projected boolean, p_created timestamptz, p_name text, p_has boolean,
  p_origin uuid, p_sign bigint, p_gross numeric, p_net numeric
) RETURNS void AS $$
BEGIN
  IF p_org IS NULL OR p_projected IS NOT TRUE THEN
    RETURN;
  END IF;
  INSERT INTO stats_rollup_no_campaign_day AS d (organization_id, day, cost_name, run_has_campaign, origin_org_id, n, gross, net)
  VALUES (p_org, (p_created AT TIME ZONE 'UTC')::date, p_name, p_has, p_origin, p_sign, p_sign * p_gross, p_sign * p_net)
  ON CONFLICT ON CONSTRAINT stats_rollup_no_campaign_day_key DO UPDATE SET
    n     = d.n + EXCLUDED.n,
    gross = d.gross + EXCLUDED.gross,
    net   = d.net + EXCLUDED.net;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Removal and addition of one row use the SAME origin lookup per run, so a
-- transfer (org change) moves the row between current orgs under one origin.
CREATE OR REPLACE FUNCTION stats_rollup_no_campaign_day_on_cost() RETURNS trigger AS $$
DECLARE
  v_origin uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.is_platform_projected AND OLD.organization_id IS NOT NULL THEN
    v_origin := run_origin_org(OLD.run_id);
    PERFORM stats_rollup_no_campaign_day_add(OLD.organization_id, OLD.is_platform_projected, OLD.created_at,
      OLD.cost_name, OLD.run_has_campaign, v_origin, -1, OLD.total_cost_in_usd_cents,
      COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.is_platform_projected AND NEW.organization_id IS NOT NULL THEN
    IF TG_OP = 'INSERT' OR NEW.run_id IS DISTINCT FROM OLD.run_id OR v_origin IS NULL THEN
      v_origin := run_origin_org(NEW.run_id);
    END IF;
    PERFORM stats_rollup_no_campaign_day_add(NEW.organization_id, NEW.is_platform_projected, NEW.created_at,
      NEW.cost_name, NEW.run_has_campaign, v_origin, 1, NEW.total_cost_in_usd_cents,
      COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_no_campaign_day_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_no_campaign_day_write
  AFTER INSERT OR DELETE OR UPDATE OF run_id, organization_id, status, cost_source, created_at, cost_name,
    run_has_campaign, total_cost_in_usd_cents, net_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_no_campaign_day_on_cost();
--> statement-breakpoint

INSERT INTO stats_rollups (name, ready_at)
SELECT 'no_campaign_origin', now()
WHERE NOT EXISTS (SELECT 1 FROM runs_costs)
ON CONFLICT (name) DO NOTHING;
