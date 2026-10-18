-- (campaign, run-start UTC day, org, brand set, feature, workflow, cost source,
-- status, cost name, billed unit price) rollup of committed + refunded cost rows,
-- for the VENDOR-basis grouped read GET /internal/stats/costs/vendor.
--
-- WHY. The billed grouped read (GET /v1/stats/public/costs) is served from the
-- campaign_day rollup (0037/0041) in O(groups): 149 ms for the 144 campaigns of
-- the cold email website-visit leg. Its vendor twin had to join every run of the
-- scope to its cost rows and price each row against the version windows: 934k
-- runs x 520k cost rows, 16 s warm and past the statement timeout as soon as
-- features-service asked three or four of them at once (2026-10-18). The vendor
-- price of a row depends on (cost name, billed unit price, created_at), so the
-- billed rollup cannot answer it; this one keeps exactly those columns.
--
-- GRAIN. Every dimension the grouped read filters or groups on, as on runs (the
-- run's campaign, started_at as a UTC day, org, brand_ids, feature_slug,
-- workflow_slug) plus the cost row's cost_source, status, cost_name and
-- unit_cost_in_usd_cents. n / quantity / gross are the rows' count and sums;
-- min_created_at / max_created_at bound their created_at. NULLs are real groups.
-- Fleet-wide: 27k groups for the 2.16M-row ledger (2026-10-18).
--
-- PRICING FROM A GROUP. A group prices exactly like its ledger rows when no
-- served-from instant of its cost name falls in (min_created_at, max_created_at]:
-- every row then sits in the same version window as min_created_at, and
-- Σ(quantity × vendor) = Σquantity × vendor in numeric. A group that straddles an
-- instant is read row by row from the ledger (same rule as the 0040 margin rollup).
-- A removal never narrows min/max: the bounds stay a superset of the rows', which
-- keeps that rule exact (it only sends a group to the ledger more often).
--
-- READINESS. Stamp `campaign_cost_items`. On a database that already holds runs
-- the table starts EMPTY and the read keeps the live join until
-- `scripts/rebuild-stats-rollup.ts campaign_cost_items` has rebuilt and stamped it.
--
-- BOOT-WINDOW SAFE. One empty table, functions, triggers. No scan.

CREATE TABLE IF NOT EXISTS stats_rollup_campaign_cost_items (
  campaign_id text,
  day date NOT NULL,
  organization_id uuid,
  brand_ids text[],
  feature_slug text,
  workflow_slug text,
  cost_source text NOT NULL,
  status text NOT NULL,
  cost_name text NOT NULL,
  unit_cost_in_usd_cents numeric(16,10) NOT NULL,
  n bigint NOT NULL DEFAULT 0,
  quantity numeric NOT NULL DEFAULT 0,
  gross numeric NOT NULL DEFAULT 0,
  min_created_at timestamptz,
  max_created_at timestamptz,
  CONSTRAINT stats_rollup_campaign_cost_items_key
    UNIQUE NULLS NOT DISTINCT (campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug,
      cost_source, status, cost_name, unit_cost_in_usd_cents)
);
--> statement-breakpoint

-- Add (p_n > 0) or remove (p_n < 0) cost rows to one group. Removal passes NULL
-- bounds: LEAST/GREATEST ignore NULL, so the stored bounds never narrow.
-- Atomic status literals only (cost predicate doctrine).
CREATE OR REPLACE FUNCTION stats_rollup_campaign_cost_items_add(
  p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text,
  p_source text, p_status text, p_cost_name text, p_unit numeric,
  p_n bigint, p_quantity numeric, p_gross numeric, p_min timestamptz, p_max timestamptz
) RETURNS void AS $$
BEGIN
  IF p_status NOT IN ('actual', 'provisioned', 'refunded') THEN
    RETURN;
  END IF;
  INSERT INTO stats_rollup_campaign_cost_items (
    campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug,
    cost_source, status, cost_name, unit_cost_in_usd_cents,
    n, quantity, gross, min_created_at, max_created_at
  ) VALUES (
    p_campaign, (p_started AT TIME ZONE 'UTC')::date, p_org, p_brands, p_feature, p_workflow,
    p_source, p_status, p_cost_name, p_unit,
    p_n, p_quantity, p_gross, p_min, p_max
  )
  ON CONFLICT ON CONSTRAINT stats_rollup_campaign_cost_items_key DO UPDATE SET
    n              = stats_rollup_campaign_cost_items.n + EXCLUDED.n,
    quantity       = stats_rollup_campaign_cost_items.quantity + EXCLUDED.quantity,
    gross          = stats_rollup_campaign_cost_items.gross + EXCLUDED.gross,
    min_created_at = LEAST(stats_rollup_campaign_cost_items.min_created_at, EXCLUDED.min_created_at),
    max_created_at = GREATEST(stats_rollup_campaign_cost_items.max_created_at, EXCLUDED.max_created_at);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Move every cost row of one run into (p_sign = 1) or out of (p_sign = -1) the
-- groups of the given run identity.
CREATE OR REPLACE FUNCTION stats_rollup_campaign_cost_items_move_run(
  p_run_id uuid, p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text, p_sign bigint
) RETURNS void AS $$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT cost_source, status, cost_name, unit_cost_in_usd_cents AS unit, count(*) AS n,
      SUM(quantity) AS quantity, SUM(total_cost_in_usd_cents) AS gross,
      MIN(created_at) AS min_at, MAX(created_at) AS max_at
    FROM runs_costs
    WHERE run_id = p_run_id AND status IN ('actual', 'provisioned', 'refunded')
    GROUP BY 1, 2, 3, 4
  LOOP
    PERFORM stats_rollup_campaign_cost_items_add(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow,
      g.cost_source, g.status, g.cost_name, g.unit, p_sign * g.n, p_sign * g.quantity, p_sign * g.gross,
      CASE WHEN p_sign > 0 THEN g.min_at END, CASE WHEN p_sign > 0 THEN g.max_at END);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_campaign_cost_items_on_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.brand_ids IS DISTINCT FROM OLD.brand_ids
       OR NEW.feature_slug IS DISTINCT FROM OLD.feature_slug
       OR NEW.workflow_slug IS DISTINCT FROM OLD.workflow_slug THEN
      PERFORM stats_rollup_campaign_cost_items_move_run(NEW.id, OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids, OLD.feature_slug, OLD.workflow_slug, -1);
      PERFORM stats_rollup_campaign_cost_items_move_run(NEW.id, NEW.campaign_id, NEW.started_at, NEW.organization_id, NEW.brand_ids, NEW.feature_slug, NEW.workflow_slug, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: the run is still visible, so its cost rows are removed here
    -- (their own cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_campaign_cost_items_move_run(OLD.id, OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids, OLD.feature_slug, OLD.workflow_slug, -1);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_campaign_cost_items_on_cost() RETURNS trigger AS $$
DECLARE
  r record;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug
      INTO r FROM runs WHERE id = OLD.run_id;
    -- Run gone = this delete is the cascade of a run delete, already accounted for.
    IF FOUND THEN
      PERFORM stats_rollup_campaign_cost_items_add(r.campaign_id, r.started_at, r.organization_id, r.brand_ids, r.feature_slug, r.workflow_slug,
        OLD.cost_source, OLD.status, OLD.cost_name, OLD.unit_cost_in_usd_cents,
        -1, -OLD.quantity, -OLD.total_cost_in_usd_cents, NULL, NULL);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug
      INTO r FROM runs WHERE id = NEW.run_id;
    IF FOUND THEN
      PERFORM stats_rollup_campaign_cost_items_add(r.campaign_id, r.started_at, r.organization_id, r.brand_ids, r.feature_slug, r.workflow_slug,
        NEW.cost_source, NEW.status, NEW.cost_name, NEW.unit_cost_in_usd_cents,
        1, NEW.quantity, NEW.total_cost_in_usd_cents, NEW.created_at, NEW.created_at);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_campaign_cost_items_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_campaign_cost_items_run_update
  AFTER UPDATE OF campaign_id, started_at, organization_id, brand_ids, feature_slug, workflow_slug ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_campaign_cost_items_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_campaign_cost_items_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_campaign_cost_items_run_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_campaign_cost_items_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_campaign_cost_items_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_campaign_cost_items_cost_write
  AFTER INSERT OR DELETE OR UPDATE OF run_id, cost_source, status, cost_name, unit_cost_in_usd_cents, quantity, total_cost_in_usd_cents, created_at ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_campaign_cost_items_on_cost();
--> statement-breakpoint

-- Fresh database: nothing to backfill, the triggers see every row from the first.
INSERT INTO stats_rollups (name, ready_at)
SELECT 'campaign_cost_items', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
