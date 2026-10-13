-- No-campaign spend per (org, UTC day), maintained ON WRITE, so billing's
-- GET /internal/org-no-campaign-total reads O(days since its cutover) instead of
-- scanning every no-campaign cost row since then and probing each one's run
-- (owner org: 24k rows, 3.8 s cold for 13 days in prod, 2026-10-13, and growing).
--
-- Two figures per (org, day of the cost row's created_at, UTC):
--   projected_* = cost rows is_platform_projected AND run_has_campaign = false,
--                 keyed on the COST row's org (GET /internal/org-usage-total's key)
--   actual_*    = cost rows is_platform_committed AND run_has_campaign = false of a
--                 completed/failed run, keyed on the RUN's org (org_actual_totals' key)
-- gross = total_cost_in_usd_cents, net = COALESCE(net_cost_in_usd_cents, gross).
--
-- NOT a cache: applied in the same transaction as each write.
--   * projected: a pure function of the cost row -> +/- on cost INSERT/UPDATE/DELETE
--     (atomic upsert, no read, so no lock needed).
--   * actual: same state machine and same serialization point as org_actual_totals
--     (migration 0035): every trigger locks the org's org_actual_totals row FIRST
--     (org_actual_totals_lock), then reads run status / sums costs.
--   A cost row's org change (transfer-brand) moves projected; a run's org/status
--   change moves actual (the cost trigger ignores org for actual, as 0035 does).

CREATE TABLE IF NOT EXISTS "org_no_campaign_days" (
  "organization_id" uuid NOT NULL,
  "day" date NOT NULL,
  "projected_gross" numeric NOT NULL DEFAULT 0,
  "projected_net" numeric NOT NULL DEFAULT 0,
  "actual_gross" numeric NOT NULL DEFAULT 0,
  "actual_net" numeric NOT NULL DEFAULT 0,
  PRIMARY KEY ("organization_id", "day")
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION org_no_campaign_days_add(
  p_org uuid, p_day date, p_pg numeric, p_pn numeric, p_ag numeric, p_an numeric
) RETURNS void AS $$
BEGIN
  IF p_org IS NULL OR (p_pg = 0 AND p_pn = 0 AND p_ag = 0 AND p_an = 0) THEN
    RETURN;
  END IF;
  INSERT INTO org_no_campaign_days AS d (organization_id, day, projected_gross, projected_net, actual_gross, actual_net)
  VALUES (p_org, p_day, p_pg, p_pn, p_ag, p_an)
  ON CONFLICT (organization_id, day) DO UPDATE
     SET projected_gross = d.projected_gross + EXCLUDED.projected_gross,
         projected_net = d.projected_net + EXCLUDED.projected_net,
         actual_gross = d.actual_gross + EXCLUDED.actual_gross,
         actual_net = d.actual_net + EXCLUDED.actual_net;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- A cost row's ACTUAL contribution to its run's org, iff the run is settled.
CREATE OR REPLACE FUNCTION org_no_campaign_days_apply_actual(
  p_run_id uuid, p_day date, p_gross numeric, p_net numeric, p_sign integer
) RETURNS void AS $$
DECLARE
  v_org uuid;
  v_org_now uuid;
  v_status text;
BEGIN
  SELECT organization_id INTO v_org FROM runs WHERE id = p_run_id;
  IF NOT FOUND OR v_org IS NULL THEN
    RETURN;
  END IF;
  PERFORM org_actual_totals_lock(v_org);
  SELECT status, organization_id INTO v_status, v_org_now FROM runs WHERE id = p_run_id;
  IF NOT FOUND OR v_org_now IS NULL THEN
    RETURN;
  END IF;
  IF v_org_now IS DISTINCT FROM v_org THEN
    PERFORM org_actual_totals_lock(v_org_now);
  END IF;
  IF v_status IN ('completed', 'failed') THEN
    PERFORM org_no_campaign_days_add(v_org_now, p_day, 0, 0, p_sign * p_gross, p_sign * p_net);
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION org_no_campaign_days_on_cost() RETURNS trigger AS $$
DECLARE
  v_old_p boolean := TG_OP <> 'INSERT' AND OLD.is_platform_projected AND OLD.run_has_campaign IS FALSE;
  v_new_p boolean := TG_OP <> 'DELETE' AND NEW.is_platform_projected AND NEW.run_has_campaign IS FALSE;
  v_old_a boolean := TG_OP <> 'INSERT' AND OLD.is_platform_committed AND OLD.run_has_campaign IS FALSE;
  v_new_a boolean := TG_OP <> 'DELETE' AND NEW.is_platform_committed AND NEW.run_has_campaign IS FALSE;
BEGIN
  -- Projected: keyed on the cost row's own org.
  IF TG_OP = 'UPDATE'
     AND v_old_p = v_new_p
     AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id
     AND OLD.created_at = NEW.created_at
     AND OLD.total_cost_in_usd_cents = NEW.total_cost_in_usd_cents
     AND OLD.net_cost_in_usd_cents IS NOT DISTINCT FROM NEW.net_cost_in_usd_cents THEN
    NULL;
  ELSE
    IF v_old_p THEN
      PERFORM org_no_campaign_days_add(
        OLD.organization_id, (OLD.created_at AT TIME ZONE 'UTC')::date,
        -OLD.total_cost_in_usd_cents, -COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents), 0, 0);
    END IF;
    IF v_new_p THEN
      PERFORM org_no_campaign_days_add(
        NEW.organization_id, (NEW.created_at AT TIME ZONE 'UTC')::date,
        NEW.total_cost_in_usd_cents, COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents), 0, 0);
    END IF;
  END IF;

  -- Actual: keyed on the run's org, settled runs only (org_actual_totals' rule).
  IF TG_OP = 'UPDATE'
     AND v_old_a = v_new_a
     AND OLD.run_id = NEW.run_id
     AND OLD.created_at = NEW.created_at
     AND OLD.total_cost_in_usd_cents = NEW.total_cost_in_usd_cents
     AND OLD.net_cost_in_usd_cents IS NOT DISTINCT FROM NEW.net_cost_in_usd_cents THEN
    RETURN NULL;
  END IF;
  IF v_old_a THEN
    PERFORM org_no_campaign_days_apply_actual(
      OLD.run_id, (OLD.created_at AT TIME ZONE 'UTC')::date,
      OLD.total_cost_in_usd_cents, COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents), -1);
  END IF;
  IF v_new_a THEN
    PERFORM org_no_campaign_days_apply_actual(
      NEW.run_id, (NEW.created_at AT TIME ZONE 'UTC')::date,
      NEW.total_cost_in_usd_cents, COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents), 1);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- A run's settled-ness or org changed: move its committed no-campaign costs, per day.
CREATE OR REPLACE FUNCTION org_no_campaign_days_on_run_update() RETURNS trigger AS $$
DECLARE
  v_old_in boolean := OLD.status IN ('completed', 'failed') AND OLD.organization_id IS NOT NULL;
  v_new_in boolean := NEW.status IN ('completed', 'failed') AND NEW.organization_id IS NOT NULL;
  r record;
BEGIN
  IF NOT v_old_in AND NOT v_new_in THEN
    RETURN NULL;
  END IF;
  IF v_old_in THEN
    PERFORM org_actual_totals_lock(OLD.organization_id);
  END IF;
  IF v_new_in AND (NOT v_old_in OR NEW.organization_id IS DISTINCT FROM OLD.organization_id) THEN
    PERFORM org_actual_totals_lock(NEW.organization_id);
  END IF;
  FOR r IN
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
           SUM(total_cost_in_usd_cents) AS gross,
           SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) AS net
      FROM runs_costs
     WHERE run_id = NEW.id AND is_platform_committed AND run_has_campaign IS FALSE
     GROUP BY 1
  LOOP
    IF v_old_in THEN
      PERFORM org_no_campaign_days_add(OLD.organization_id, r.day, 0, 0, -r.gross, -r.net);
    END IF;
    IF v_new_in THEN
      PERFORM org_no_campaign_days_add(NEW.organization_id, r.day, 0, 0, r.gross, r.net);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- BEFORE DELETE: the run's costs are still here. The cascaded cost deletes then
-- remove their projected part themselves and find no run for the actual part.
CREATE OR REPLACE FUNCTION org_no_campaign_days_on_run_delete() RETURNS trigger AS $$
DECLARE
  r record;
BEGIN
  IF OLD.organization_id IS NULL OR OLD.status NOT IN ('completed', 'failed') THEN
    RETURN OLD;
  END IF;
  PERFORM org_actual_totals_lock(OLD.organization_id);
  FOR r IN
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
           SUM(total_cost_in_usd_cents) AS gross,
           SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) AS net
      FROM runs_costs
     WHERE run_id = OLD.id AND is_platform_committed AND run_has_campaign IS FALSE
     GROUP BY 1
  LOOP
    PERFORM org_no_campaign_days_add(OLD.organization_id, r.day, 0, 0, -r.gross, -r.net);
  END LOOP;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_org_no_campaign_days_cost ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER trg_org_no_campaign_days_cost
  AFTER INSERT OR UPDATE OR DELETE ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION org_no_campaign_days_on_cost();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_org_no_campaign_days_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER trg_org_no_campaign_days_run_update
  AFTER UPDATE OF status, organization_id ON runs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION org_no_campaign_days_on_run_update();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_org_no_campaign_days_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER trg_org_no_campaign_days_run_delete
  BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION org_no_campaign_days_on_run_delete();
--> statement-breakpoint

-- Rows whose campaign is not known yet (written before 0045's trigger, before the
-- backfill). The balance read refuses a window holding one; empty once backfilled.
CREATE INDEX IF NOT EXISTS idx_runs_costs_org_campaign_unknown
  ON runs_costs (organization_id, created_at)
  WHERE is_platform_projected AND run_has_campaign IS NULL;
--> statement-breakpoint

-- Backfill AFTER the triggers exist, in this migration's transaction: creating
-- them took SHARE ROW EXCLUSIVE on runs + runs_costs, so writers queue until this
-- commits and then go through the triggers. Only no-campaign rows are summed
-- (~2% of the ledger's money; idx_runs_costs_org_no_campaign).
DELETE FROM org_no_campaign_days;
--> statement-breakpoint
INSERT INTO org_no_campaign_days (organization_id, day, projected_gross, projected_net, actual_gross, actual_net)
SELECT org, day, SUM(pg), SUM(pn), SUM(ag), SUM(an)
  FROM (
    SELECT rc.organization_id AS org, (rc.created_at AT TIME ZONE 'UTC')::date AS day,
           rc.total_cost_in_usd_cents AS pg,
           COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) AS pn,
           0::numeric AS ag, 0::numeric AS an
      FROM runs_costs rc
     WHERE rc.is_platform_projected AND rc.run_has_campaign IS FALSE AND rc.organization_id IS NOT NULL
    UNION ALL
    SELECT r.organization_id, (rc.created_at AT TIME ZONE 'UTC')::date,
           0, 0,
           rc.total_cost_in_usd_cents,
           COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)
      FROM runs_costs rc
      JOIN runs r ON r.id = rc.run_id
     WHERE rc.is_platform_committed AND rc.run_has_campaign IS FALSE
       AND r.organization_id IS NOT NULL AND r.status IN ('completed', 'failed')
  ) s
 GROUP BY org, day;
