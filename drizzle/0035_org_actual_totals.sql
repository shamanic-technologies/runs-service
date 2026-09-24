-- Per-org ACTUALIZED platform total, maintained ON WRITE so billing-service can
-- read "how much has this org actually been charged" in O(1).
--
-- Why: billing-service reads the org's net actualized total on every dashboard
-- page (GET /v1/accounts). The only source was GET /internal/runs-expected-totals,
-- which re-aggregates the whole ledger per call: for the heaviest org that is a
-- runs JOIN runs_costs over ~700k committed rows (5.4s, 33 MB body with the
-- per-run list). Even without the list, any SCAN of those rows is >=400ms on prod
-- (measured: index-only scan 426ms, parallel bitmap 478ms), and the ledger only
-- grows. So the total is kept, not recomputed.
--
-- The figure is EXACTLY the one runs-expected-totals serves:
--   included cost row = runs_costs.is_platform_committed
--                       AND its run's status IN ('completed','failed')
--                       AND its run's organization_id IS NOT NULL
--   keyed on the RUN's organization_id (not the denormalized cost column), with
--   gross = total_cost_in_usd_cents, net = COALESCE(net_cost_in_usd_cents, gross).
-- runs-expected-totals' HAVING SUM(gross) > 0 per run drops only runs whose gross
-- is 0; costs are never negative and no row has gross 0 with a non-zero net
-- (both checked on prod 2026-09-24), so those runs contribute 0 to both sums.
--
-- NOT a cache: every change to an included row is applied in the SAME transaction
-- that makes it, so the total can never be read stale. The state changes that move
-- it, and where each is caught:
--   * a cost row inserted / updated (status, amounts, run) / deleted -> trg on runs_costs
--   * a run changing status or organization                            -> trg on runs (AFTER UPDATE)
--   * a run deleted (its costs go with it by FK cascade)               -> trg on runs (BEFORE DELETE,
--     while the costs are still there; the cascaded cost deletes then find no run and add nothing)
--
-- Concurrency: the org's row in org_actual_totals is the serialization point.
-- Every trigger locks it FIRST and only THEN reads run status / sums costs, and
-- each plpgsql statement takes a fresh snapshot (READ COMMITTED). So a cost
-- inserted while its run completes is counted exactly once: whichever transaction
-- takes the org lock second sees the other one's committed write. No trigger ever
-- waits on a runs row lock while holding the org lock, so there is no lock cycle.
--
-- Columns are UNCONSTRAINED numeric: an org's lifetime total overflows
-- numeric(16,10). Every addend is numeric(16,10), so the stored scale stays 10 —
-- the ::text reads byte-identical to SUM(...)::text in runs-expected-totals.

CREATE TABLE IF NOT EXISTS "org_actual_totals" (
  "organization_id" uuid PRIMARY KEY,
  "total_cost_in_usd_cents" numeric NOT NULL,
  "net_cost_in_usd_cents" numeric NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Lock (creating if needed) the org's row. Called before any status read.
CREATE OR REPLACE FUNCTION org_actual_totals_lock(p_org uuid) RETURNS void AS $$
BEGIN
  INSERT INTO org_actual_totals (organization_id, total_cost_in_usd_cents, net_cost_in_usd_cents)
  VALUES (p_org, 0, 0)
  ON CONFLICT (organization_id) DO NOTHING;
  PERFORM 1 FROM org_actual_totals WHERE organization_id = p_org FOR UPDATE;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION org_actual_totals_add(p_org uuid, p_gross numeric, p_net numeric) RETURNS void AS $$
BEGIN
  IF p_gross = 0 AND p_net = 0 THEN
    RETURN;
  END IF;
  UPDATE org_actual_totals
     SET total_cost_in_usd_cents = total_cost_in_usd_cents + p_gross,
         net_cost_in_usd_cents = net_cost_in_usd_cents + p_net,
         updated_at = now()
   WHERE organization_id = p_org;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- A cost row's contribution: +/- its amounts to its run's org, iff committed and
-- the run is settled. p_sign = 1 to add, -1 to remove.
CREATE OR REPLACE FUNCTION org_actual_totals_apply_cost(
  p_run_id uuid, p_gross numeric, p_net numeric, p_sign integer
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
  -- Fresh snapshot, taken after the org lock: sees any run change committed by
  -- the transaction that held the lock before us.
  SELECT status, organization_id INTO v_status, v_org_now FROM runs WHERE id = p_run_id;
  IF NOT FOUND OR v_org_now IS NULL THEN
    RETURN;
  END IF;
  IF v_org_now IS DISTINCT FROM v_org THEN
    PERFORM org_actual_totals_lock(v_org_now);
  END IF;
  IF v_status IN ('completed', 'failed') THEN
    PERFORM org_actual_totals_add(v_org_now, p_sign * p_gross, p_sign * p_net);
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION org_actual_totals_on_cost() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.run_id = NEW.run_id
     AND OLD.is_platform_committed = NEW.is_platform_committed
     AND OLD.total_cost_in_usd_cents = NEW.total_cost_in_usd_cents
     AND OLD.net_cost_in_usd_cents IS NOT DISTINCT FROM NEW.net_cost_in_usd_cents THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.is_platform_committed THEN
    PERFORM org_actual_totals_apply_cost(
      OLD.run_id,
      OLD.total_cost_in_usd_cents,
      COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents),
      -1
    );
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.is_platform_committed THEN
    PERFORM org_actual_totals_apply_cost(
      NEW.run_id,
      NEW.total_cost_in_usd_cents,
      COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents),
      1
    );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- A run's settled-ness or org changed: move the sum of its committed costs.
CREATE OR REPLACE FUNCTION org_actual_totals_on_run_update() RETURNS trigger AS $$
DECLARE
  v_old_in boolean := OLD.status IN ('completed', 'failed') AND OLD.organization_id IS NOT NULL;
  v_new_in boolean := NEW.status IN ('completed', 'failed') AND NEW.organization_id IS NOT NULL;
  v_gross numeric;
  v_net numeric;
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
  SELECT COALESCE(SUM(total_cost_in_usd_cents), 0),
         COALESCE(SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)), 0)
    INTO v_gross, v_net
    FROM runs_costs
   WHERE run_id = NEW.id AND is_platform_committed;
  IF v_old_in THEN
    PERFORM org_actual_totals_add(OLD.organization_id, -v_gross, -v_net);
  END IF;
  IF v_new_in THEN
    PERFORM org_actual_totals_add(NEW.organization_id, v_gross, v_net);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- BEFORE DELETE: the run's costs are still present here; the FK cascade removes
-- them after, and their own trigger then finds no run and adds nothing.
CREATE OR REPLACE FUNCTION org_actual_totals_on_run_delete() RETURNS trigger AS $$
DECLARE
  v_gross numeric;
  v_net numeric;
BEGIN
  IF OLD.organization_id IS NULL OR OLD.status NOT IN ('completed', 'failed') THEN
    RETURN OLD;
  END IF;
  PERFORM org_actual_totals_lock(OLD.organization_id);
  SELECT COALESCE(SUM(total_cost_in_usd_cents), 0),
         COALESCE(SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)), 0)
    INTO v_gross, v_net
    FROM runs_costs
   WHERE run_id = OLD.id AND is_platform_committed;
  PERFORM org_actual_totals_add(OLD.organization_id, -v_gross, -v_net);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_org_actual_totals_cost ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER trg_org_actual_totals_cost
  AFTER INSERT OR UPDATE OR DELETE ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION org_actual_totals_on_cost();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_org_actual_totals_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER trg_org_actual_totals_run_update
  AFTER UPDATE OF status, organization_id ON runs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION org_actual_totals_on_run_update();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_org_actual_totals_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER trg_org_actual_totals_run_delete
  BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION org_actual_totals_on_run_delete();
--> statement-breakpoint

-- Backfill AFTER the triggers exist, in the same migration transaction: creating
-- the triggers took SHARE ROW EXCLUSIVE on runs + runs_costs, so writers wait
-- until this commits and then go through the triggers — nothing is counted twice
-- or missed. The aggregate takes ~3s on prod (1M committed rows); writes queue
-- for that window.
DELETE FROM org_actual_totals;
--> statement-breakpoint
INSERT INTO org_actual_totals (organization_id, total_cost_in_usd_cents, net_cost_in_usd_cents)
SELECT r.organization_id,
       SUM(rc.total_cost_in_usd_cents),
       SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents))
  FROM runs r
  JOIN runs_costs rc ON rc.run_id = r.id
 WHERE r.organization_id IS NOT NULL
   AND r.status IN ('completed', 'failed')
   AND rc.is_platform_committed
 GROUP BY r.organization_id;
