-- Incrementally-maintained rollup for the cross-org per-workflow cost read
-- (GET /v1/stats/public/costs?featureSlugs=X&groupBy=workflowSlug).
--
-- WHY. features-service builds the fleet benchmark for its workflow ranking from
-- that read, once per viewed brand / campaign / leg cell. Every call re-scanned
-- the feature's WHOLE history: 1,164,010 runs for sales-cold-email-outreach, a
-- 60 MB disk-spilling distinct-hash, 1.4 s of JIT compilation and a parallel
-- join of the full cost ledger — 5-9 s per call, 3-8 calls in flight at once,
-- and it grew with the ledger whether or not traffic did (2026-09-24, shared
-- Postgres at ~400% CPU). The answer (~160 groups) only changes when a run or a
-- cost row lands, so it is maintained at WRITE time instead of recomputed on
-- every READ.
--
-- GRAIN. (feature_slug, workflow_slug) for run counts, plus cost_source for
-- money. That is exactly what the served shape needs — filters on feature and
-- workflow, an optional payer filter, grouping by workflow (or its dynasty) or
-- feature — and nothing else: any request outside that shape keeps the live
-- query. NULLs are real groups (a run with no workflow is its own group, exactly
-- as `GROUP BY` treats it), hence UNIQUE NULLS NOT DISTINCT.
--
-- BYTE-IDENTITY. numeric addition is exact, so maintained sums equal a fresh
-- SUM to the last digit. The live query renders each money column as
-- `SUM(CASE WHEN <status> THEN amount ELSE 0 END)::text`, whose text SCALE is 10
-- when at least one row matched and 0 (`'0'`) when none did — and the response
-- is ORDERed by that text. So each status carries its matched-row COUNT beside
-- its sums, and the read renders `'0'` when the count is zero and
-- `round(sum, 10)::text` otherwise. See `src/services/stats-rollup.ts`.
--
-- READINESS. Triggers start maintaining deltas the moment this migration runs,
-- but on a database that already holds runs the tables start EMPTY, so the read
-- path must not use them until `scripts/rebuild-stats-rollup.ts` has rebuilt
-- them from the ledger and stamped `stats_rollups` (writers queue for well under
-- a second; the aggregate itself runs lock-free on an exported snapshot). On a
-- fresh (empty) database there is nothing to backfill, so this migration stamps
-- it ready itself — which is what CI and a from-zero build see.
--
-- BOOT-WINDOW SAFE. Three empty tables, five functions, four triggers: catalog
-- work plus a brief SHARE ROW EXCLUSIVE lock per CREATE TRIGGER. No scan.

CREATE TABLE IF NOT EXISTS stats_rollups (
  name text PRIMARY KEY,
  ready_at timestamptz NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS stats_rollup_runs (
  feature_slug text,
  workflow_slug text,
  run_count bigint NOT NULL DEFAULT 0,
  CONSTRAINT stats_rollup_runs_key UNIQUE NULLS NOT DISTINCT (feature_slug, workflow_slug)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS stats_rollup_costs (
  feature_slug text,
  workflow_slug text,
  cost_source text NOT NULL,
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
  CONSTRAINT stats_rollup_costs_key UNIQUE NULLS NOT DISTINCT (feature_slug, workflow_slug, cost_source)
);
--> statement-breakpoint

-- Add `delta` runs to one (feature, workflow) group.
CREATE OR REPLACE FUNCTION stats_rollup_add_runs(p_feature text, p_workflow text, p_delta bigint) RETURNS void AS $$
BEGIN
  INSERT INTO stats_rollup_runs (feature_slug, workflow_slug, run_count)
  VALUES (p_feature, p_workflow, p_delta)
  ON CONFLICT ON CONSTRAINT stats_rollup_runs_key
  DO UPDATE SET run_count = stats_rollup_runs.run_count + EXCLUDED.run_count;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Add (p_sign = 1) or remove (p_sign = -1) cost amounts to one
-- (feature, workflow, cost_source) group. Atomic status literals only (cost
-- predicate doctrine): a status outside the four known ones contributes nothing,
-- exactly as the live aggregation ignores it.
CREATE OR REPLACE FUNCTION stats_rollup_add_cost(
  p_feature text, p_workflow text, p_source text, p_status text,
  p_count bigint, p_gross numeric, p_net numeric
) RETURNS void AS $$
BEGIN
  IF p_status NOT IN ('actual', 'provisioned', 'cancelled', 'refunded') THEN
    RETURN;
  END IF;
  INSERT INTO stats_rollup_costs (
    feature_slug, workflow_slug, cost_source,
    n_actual, n_provisioned, n_cancelled, n_refunded,
    gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
    net_actual, net_provisioned, net_refunded
  ) VALUES (
    p_feature, p_workflow, p_source,
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
  ON CONFLICT ON CONSTRAINT stats_rollup_costs_key DO UPDATE SET
    n_actual          = stats_rollup_costs.n_actual          + EXCLUDED.n_actual,
    n_provisioned     = stats_rollup_costs.n_provisioned     + EXCLUDED.n_provisioned,
    n_cancelled       = stats_rollup_costs.n_cancelled       + EXCLUDED.n_cancelled,
    n_refunded        = stats_rollup_costs.n_refunded        + EXCLUDED.n_refunded,
    gross_actual      = stats_rollup_costs.gross_actual      + EXCLUDED.gross_actual,
    gross_provisioned = stats_rollup_costs.gross_provisioned + EXCLUDED.gross_provisioned,
    gross_cancelled   = stats_rollup_costs.gross_cancelled   + EXCLUDED.gross_cancelled,
    gross_refunded    = stats_rollup_costs.gross_refunded    + EXCLUDED.gross_refunded,
    net_actual        = stats_rollup_costs.net_actual        + EXCLUDED.net_actual,
    net_provisioned   = stats_rollup_costs.net_provisioned   + EXCLUDED.net_provisioned,
    net_refunded      = stats_rollup_costs.net_refunded      + EXCLUDED.net_refunded;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Move every cost row of one run into (p_sign = 1) or out of (p_sign = -1) the
-- given (feature, workflow) group, one upsert per (cost_source, status).
CREATE OR REPLACE FUNCTION stats_rollup_move_run_costs(p_run_id uuid, p_feature text, p_workflow text, p_sign bigint) RETURNS void AS $$
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
    PERFORM stats_rollup_add_cost(p_feature, p_workflow, g.cost_source, g.status, p_sign * g.n, p_sign * g.gross, p_sign * g.net);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_on_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM stats_rollup_add_runs(NEW.feature_slug, NEW.workflow_slug, 1);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.feature_slug IS DISTINCT FROM OLD.feature_slug OR NEW.workflow_slug IS DISTINCT FROM OLD.workflow_slug THEN
      PERFORM stats_rollup_add_runs(OLD.feature_slug, OLD.workflow_slug, -1);
      PERFORM stats_rollup_add_runs(NEW.feature_slug, NEW.workflow_slug, 1);
      PERFORM stats_rollup_move_run_costs(NEW.id, OLD.feature_slug, OLD.workflow_slug, -1);
      PERFORM stats_rollup_move_run_costs(NEW.id, NEW.feature_slug, NEW.workflow_slug, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: the run's cost rows are about to go with it (ON DELETE
    -- CASCADE), and by the time their own DELETE trigger fires the run is no
    -- longer visible, so their dimensions cannot be resolved. Remove them here
    -- while the run still exists; the per-cost trigger then skips (run gone).
    PERFORM stats_rollup_add_runs(OLD.feature_slug, OLD.workflow_slug, -1);
    PERFORM stats_rollup_move_run_costs(OLD.id, OLD.feature_slug, OLD.workflow_slug, -1);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stats_rollup_on_cost() RETURNS trigger AS $$
DECLARE
  r_feature text;
  r_workflow text;
  r_found boolean;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT feature_slug, workflow_slug, true INTO r_feature, r_workflow, r_found FROM runs WHERE id = OLD.run_id;
    -- Run gone = this delete is the cascade of a run delete, already accounted
    -- for by stats_rollup_on_run.
    IF r_found THEN
      PERFORM stats_rollup_add_cost(r_feature, r_workflow, OLD.cost_source, OLD.status, -1,
        -OLD.total_cost_in_usd_cents, -COALESCE(OLD.net_cost_in_usd_cents, OLD.total_cost_in_usd_cents));
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT feature_slug, workflow_slug INTO r_feature, r_workflow FROM runs WHERE id = NEW.run_id;
    PERFORM stats_rollup_add_cost(r_feature, r_workflow, NEW.cost_source, NEW.status, 1,
      NEW.total_cost_in_usd_cents, COALESCE(NEW.net_cost_in_usd_cents, NEW.total_cost_in_usd_cents));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stats_rollup_run_insert ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_run_insert AFTER INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_run_update AFTER UPDATE OF feature_slug, workflow_slug ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_run_delete BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_on_run();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_cost_write ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_cost_write AFTER INSERT OR DELETE OR UPDATE OF run_id, cost_source, status, total_cost_in_usd_cents, net_cost_in_usd_cents ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION stats_rollup_on_cost();
--> statement-breakpoint

-- Fresh database: nothing to backfill, the triggers see every row from the first.
INSERT INTO stats_rollups (name, ready_at)
SELECT 'feature_workflow', now()
WHERE NOT EXISTS (SELECT 1 FROM runs)
ON CONFLICT (name) DO NOTHING;
