-- LEDGER-LOAD-1107-SPEND: an org's lifetime PLATFORM-PROJECTED spend (gross + frozen net), maintained ON WRITE.
--
-- Why: two reads re-summed an org's whole history on every call (pg_stat_statements, prod 2026-11-07 17:13-17:23 UTC):
--   * the usage hint after every cost write/update (routes/runs.ts fetchOrgPlatformSpent): 2,556 calls / 10 min, 784 ms each
--   * GET /internal/org-usage-total (billing-service, every authorize): 1,094 calls / 10 min, 869 ms each
-- = 38 % of runs-service statement time, ~5 busy backends on an 8-core box, growing with each org's history.
--
-- The figure is EXACTLY the live one:
--   included cost row = runs_costs.is_platform_projected, keyed on runs_costs.organization_id (0029 denorm),
--   gross = total_cost_in_usd_cents, net = COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents).
-- A row with organization_id NULL is in no org's total (as live).
--
-- NOT a cache: each change to an included row is applied as a delta in the SAME transaction (AFTER row trigger),
-- so the total is never stale and billing never authorizes on a lagging figure. The delta comes from OLD/NEW alone
-- (no other row is read), and INSERT .. ON CONFLICT DO UPDATE re-reads the latest committed version under the row
-- lock, so concurrent writers on one org add up exactly (no read-then-write race, unlike 0035 which reads run status).
--
-- Columns are UNCONSTRAINED numeric (a lifetime total overflows numeric(16,10)); every addend has scale 10, so the
-- value equals SUM(...) exactly and the route's Decimal(...).toFixed(10) serves byte-identical text.
--
-- READINESS: stamp `org_projected` in stats_rollups. A fresh database (no runs) is stamped here; an existing one is
-- filled + stamped by `scripts/rebuild-stats-rollup.ts org_projected` after the deploy. Until then both reads keep
-- the live SUM. TRUNCATE fires no row triggers: tests/global-setup.ts truncates this table with the ledger.
--
-- BOOT-WINDOW SAFE: one empty table, a function, a trigger. No scan.

CREATE TABLE IF NOT EXISTS org_projected_totals (
  organization_id uuid PRIMARY KEY,
  n_rows bigint NOT NULL DEFAULT 0,
  total_cost_in_usd_cents numeric NOT NULL DEFAULT 0,
  net_cost_in_usd_cents numeric NOT NULL DEFAULT 0
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION org_projected_totals_add(p_org uuid, p_n bigint, p_gross numeric, p_net numeric) RETURNS void AS $$
BEGIN
  INSERT INTO org_projected_totals (organization_id, n_rows, total_cost_in_usd_cents, net_cost_in_usd_cents)
  VALUES (p_org, p_n, p_gross, p_net)
  ON CONFLICT (organization_id) DO UPDATE SET
    n_rows                  = org_projected_totals.n_rows                  + EXCLUDED.n_rows,
    total_cost_in_usd_cents = org_projected_totals.total_cost_in_usd_cents + EXCLUDED.total_cost_in_usd_cents,
    net_cost_in_usd_cents   = org_projected_totals.net_cost_in_usd_cents   + EXCLUDED.net_cost_in_usd_cents;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- is_platform_projected is a STORED generated column: computed before AFTER triggers, so OLD and NEW both carry it.
CREATE OR REPLACE FUNCTION org_projected_totals_on_cost() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.is_platform_projected IS NOT DISTINCT FROM NEW.is_platform_projected
     AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id
     AND OLD.total_cost_in_usd_cents IS NOT DISTINCT FROM NEW.total_cost_in_usd_cents
     AND OLD.net_cost_in_usd_cents IS NOT DISTINCT FROM NEW.net_cost_in_usd_cents THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.is_platform_projected IS TRUE AND OLD.organization_id IS NOT NULL THEN
    PERFORM org_projected_totals_add(
      OLD.organization_id, -1,
      -COALESCE(OLD.total_cost_in_usd_cents, 0),
      -COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents, 0)
    );
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.is_platform_projected IS TRUE AND NEW.organization_id IS NOT NULL THEN
    PERFORM org_projected_totals_add(
      NEW.organization_id, 1,
      COALESCE(NEW.total_cost_in_usd_cents, 0),
      COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents, 0)
    );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS org_projected_totals_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER org_projected_totals_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF status, cost_source, organization_id, total_cost_in_usd_cents, net_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION org_projected_totals_on_cost();
--> statement-breakpoint

INSERT INTO stats_rollups (name, ready_at)
SELECT 'org_projected', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
