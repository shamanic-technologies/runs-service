-- Dashboard v2 reads, measured in prod on 2026-10-08 (PERF-SWEEP): the staff
-- margin read took 9-13 s, run-outcomes 2-24 s, the Billing page's runs list
-- 1.5-6.5 s, the Today page's per-day cost stats 0.6-4 s. Four serving structures,
-- no figure and no response shape changes. Every read keeps its live query and
-- uses the new structure only once it is ready.
--
-- BOOT-WINDOW SAFE. Two empty tables, functions, triggers. The three indexes on
-- the large tables are built out-of-band CONCURRENTLY on prod first, so their
-- IF NOT EXISTS statements no-op there (migration 0027 / 0029 / 0030 / 0036 /
-- 0039 pattern); a fresh/test database builds them here on empty tables.

-- ===========================================================================
-- 1. (org, cost name, billed unit price, status, UTC day) rollup of the PLATFORM
--    cost rows the margin reads price (GET /internal/stats/costs/margin and its
--    /timeseries). Live, they priced all 1.27M charged/refunded rows on every
--    call; the rollup holds ~8k groups.
--
--    Exactness. A row's vendor price and provider depend only on its cost name,
--    billed unit price and created_at relative to the catalogue's served-from
--    instants. Every row of a group shares the first two; the group carries the
--    min and max created_at of its rows, so when no served-from instant of the
--    name lies in (min, max] all its rows price the same as its min, and
--    quantity x vendor sums exactly (numeric is exact). A group straddling an
--    instant is read row by row from the ledger (idx_runs_costs_margin_raw):
--    22 groups / 5.7k rows in prod. min/max are only ever widened (a removed row
--    leaves them as they were), which can only send a group to the raw path.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS stats_rollup_cost_day (
  organization_id uuid,
  cost_name text NOT NULL,
  unit_cost_in_usd_cents numeric(16,10) NOT NULL,
  status text NOT NULL,
  day date NOT NULL,
  n bigint NOT NULL DEFAULT 0,
  quantity numeric NOT NULL DEFAULT 0,
  gross numeric NOT NULL DEFAULT 0,
  net numeric NOT NULL DEFAULT 0,
  min_created_at timestamptz NOT NULL,
  max_created_at timestamptz NOT NULL,
  CONSTRAINT stats_rollup_cost_day_key
    UNIQUE NULLS NOT DISTINCT (organization_id, cost_name, unit_cost_in_usd_cents, status, day)
);
--> statement-breakpoint

-- Add (p_sign = 1) or remove (p_sign = -1) one cost row. Only PLATFORM rows that
-- were charged or refunded are priced by the margin reads (atomic literals).
CREATE OR REPLACE FUNCTION stats_rollup_cost_day_add(
  p_org uuid, p_name text, p_unit numeric, p_status text, p_source text, p_created timestamptz,
  p_sign bigint, p_qty numeric, p_gross numeric, p_net numeric
) RETURNS void AS $$
BEGIN
  IF p_source = 'platform' AND p_status IN ('actual', 'refunded') THEN
    INSERT INTO stats_rollup_cost_day (
      organization_id, cost_name, unit_cost_in_usd_cents, status, day,
      n, quantity, gross, net, min_created_at, max_created_at
    ) VALUES (
      p_org, p_name, p_unit, p_status, (p_created AT TIME ZONE 'UTC')::date,
      p_sign, p_sign * p_qty, p_sign * p_gross, p_sign * p_net, p_created, p_created
    )
    ON CONFLICT ON CONSTRAINT stats_rollup_cost_day_key DO UPDATE SET
      n              = stats_rollup_cost_day.n + EXCLUDED.n,
      quantity       = stats_rollup_cost_day.quantity + EXCLUDED.quantity,
      gross          = stats_rollup_cost_day.gross + EXCLUDED.gross,
      net            = stats_rollup_cost_day.net + EXCLUDED.net,
      min_created_at = LEAST(stats_rollup_cost_day.min_created_at, EXCLUDED.min_created_at),
      max_created_at = GREATEST(stats_rollup_cost_day.max_created_at, EXCLUDED.max_created_at);
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_cost_day_on_cost() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM stats_rollup_cost_day_add(OLD.organization_id, OLD.cost_name, OLD.unit_cost_in_usd_cents, OLD.status,
      OLD.cost_source, OLD.created_at, -1, OLD.quantity, OLD.total_cost_in_usd_cents,
      COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM stats_rollup_cost_day_add(NEW.organization_id, NEW.cost_name, NEW.unit_cost_in_usd_cents, NEW.status,
      NEW.cost_source, NEW.created_at, 1, NEW.quantity, NEW.total_cost_in_usd_cents,
      COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_cost_day_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_cost_day_write
  AFTER INSERT OR DELETE OR UPDATE OF organization_id, cost_name, unit_cost_in_usd_cents, status, cost_source,
    created_at, quantity, total_cost_in_usd_cents, net_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_cost_day_on_cost();
--> statement-breakpoint

-- Raw read of the groups that straddle a served-from instant.
CREATE INDEX IF NOT EXISTS "idx_runs_costs_margin_raw"
  ON "runs_costs" ("cost_name", "created_at")
  WHERE cost_source = 'platform' AND status IN ('actual', 'refunded');
--> statement-breakpoint

INSERT INTO stats_rollups (name, ready_at)
SELECT 'cost_day', now()
WHERE NOT EXISTS (SELECT 1 FROM runs_costs)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

-- ===========================================================================
-- 2. run_campaign_entries — the ENTRY runs of every campaign: runs carrying a
--    campaign whose parent is not a run of that same campaign. GET
--    /v1/stats/run-outcomes (default scope=entry) tested that with one parent
--    lookup per candidate run: 167k lookups for the owner's campaign family over
--    30 days, 2-24 s. Entries are ~1 run in 5.
--
--    A projection, maintained in the writing transaction: every insert/update of
--    a run upserts (entry) or deletes (not an entry) its row with the run's
--    current values; a run delete cascades. Membership is decided the same way
--    as the live query (parent lookup), once per write instead of once per read.
--    If a run's campaign changes, its children's membership is recomputed too.
--    Runs without a campaign are never entries here: the read uses this table
--    only when it filters on a campaign.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS run_campaign_entries (
  run_id uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  campaign_id text NOT NULL,
  organization_id uuid,
  brand_ids text[],
  feature_slug text,
  workflow_slug text,
  service_name text NOT NULL,
  task_name text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_run_campaign_entries_campaign_started"
  ON "run_campaign_entries" ("campaign_id", "started_at");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION run_campaign_entries_on_run() RETURNS trigger AS $$
BEGIN
  IF NEW.campaign_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runs p WHERE p.id = NEW.parent_run_id AND p.campaign_id = NEW.campaign_id
  ) THEN
    INSERT INTO run_campaign_entries (
      run_id, campaign_id, organization_id, brand_ids, feature_slug, workflow_slug,
      service_name, task_name, status, started_at, completed_at
    ) VALUES (
      NEW.id, NEW.campaign_id, NEW.organization_id, NEW.brand_ids, NEW.feature_slug, NEW.workflow_slug,
      NEW.service_name, NEW.task_name, NEW.status, NEW.started_at, NEW.completed_at
    )
    ON CONFLICT (run_id) DO UPDATE SET
      campaign_id = EXCLUDED.campaign_id, organization_id = EXCLUDED.organization_id,
      brand_ids = EXCLUDED.brand_ids, feature_slug = EXCLUDED.feature_slug,
      workflow_slug = EXCLUDED.workflow_slug, service_name = EXCLUDED.service_name,
      task_name = EXCLUDED.task_name, status = EXCLUDED.status,
      started_at = EXCLUDED.started_at, completed_at = EXCLUDED.completed_at;
  ELSIF TG_OP = 'UPDATE' THEN
    DELETE FROM run_campaign_entries WHERE run_id = NEW.id;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.campaign_id IS DISTINCT FROM OLD.campaign_id THEN
    -- Children of the same (new) campaign stop being entries; children of any
    -- other campaign (incl. the old one) become entries.
    DELETE FROM run_campaign_entries e USING runs c
      WHERE c.parent_run_id = NEW.id AND e.run_id = c.id AND c.campaign_id = NEW.campaign_id;
    INSERT INTO run_campaign_entries (
      run_id, campaign_id, organization_id, brand_ids, feature_slug, workflow_slug,
      service_name, task_name, status, started_at, completed_at
    )
    SELECT c.id, c.campaign_id, c.organization_id, c.brand_ids, c.feature_slug, c.workflow_slug,
      c.service_name, c.task_name, c.status, c.started_at, c.completed_at
    FROM runs c
    WHERE c.parent_run_id = NEW.id AND c.campaign_id IS NOT NULL AND c.campaign_id IS DISTINCT FROM NEW.campaign_id
    ON CONFLICT (run_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS run_campaign_entries_write ON runs;
--> statement-breakpoint
CREATE TRIGGER run_campaign_entries_write AFTER INSERT OR UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION run_campaign_entries_on_run();
--> statement-breakpoint

INSERT INTO stats_rollups (name, ready_at)
SELECT 'campaign_entry', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

-- ===========================================================================
-- 3. Two serving indexes on runs.
--
--    idx_runs_org_started — an org's runs in a time window (GET /v1/stats/costs
--    with startedAfter/startedBefore, one call per day of the Today chart). The
--    planner AND-ed a bitmap of idx_runs_started_status (every org's runs that
--    day) with idx_runs_org_service (all 550k runs of the org): 0.3-0.7 s of
--    bitmap building for a 7k-run day.
--
--    idx_runs_campaign_task_started — a campaign's newest runs of ONE task (the
--    Billing page lists `execute-workflow` runs of a campaign family with
--    limit=240). On idx_runs_campaign_started each member walked ~64k runs to
--    find its 240 workflow runs (3.5 s); here the walk stops at the page.
-- ===========================================================================

CREATE INDEX IF NOT EXISTS "idx_runs_org_started"
  ON "runs" ("organization_id", "started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_campaign_task_started"
  ON "runs" ("campaign_id", "task_name", "started_at" DESC, "id" DESC);
