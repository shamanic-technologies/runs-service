-- Denormalize the owning run's `started_at` onto every cost row at write time.
--
-- Why: the cross-org public run/cost statistics (`GET /public/stats/runs`) bucket
-- platform spend by the RUN's start date, but the money lives on `runs_costs`
-- while the date lives on `runs`. Every call therefore joined the entire runs
-- ledger to the entire costs ledger with no time bound and no org bound — twice,
-- once for the monthly series and once for the weekly one, in the same request.
-- Measured on the production branch (runs-service#206): 506 calls x 14.2s for the
-- monthly rollup plus 506 x 13.7s for the weekly one, ~3h55m of pure execution,
-- growing with the ledger whether or not traffic does.
--
-- Freezing the run's `started_at` onto the cost row lets the dated spend series be
-- read from a single indexed table with no join at all (same pattern as
-- organization_id in migration 0029, net_cost in 0028, and goal / brand_profile_id
-- / audience_id before them). The writer already holds the run at cost-write time —
-- this persists what it had instead of re-deriving it on every read (CLAUDE.md
-- "Read-side derivation of a value the WRITER already held").
--
-- EXPAND ONLY. The column is NULLABLE and NOT backfilled here (a full-table UPDATE
-- on the multi-million-row ledger would block boot — CLAUDE.md "Boot-window
-- hazards"). Backfill runs out-of-band via
-- scripts/backfill-cost-run-started-at.ts. The read swap that groups spend by this
-- column ships in a SEPARATE later deploy, only AFTER that backfill completes
-- (expand -> backfill -> swap), so a partially-populated column can never drop
-- rows out of the dated buckets and under-report spend.
--
-- Live Drizzle table names `runs` / `runs_costs` are auto-updatable passthrough
-- VIEWS over `runs_old` / `runs_costs_old` (migration 0021). Add the column to the
-- base table, then CREATE OR REPLACE VIEW to append it to the shim (append is
-- auto-updatable-safe; see CLAUDE.md "Add a column" + migration 0024).

ALTER TABLE "runs_costs_old" ADD COLUMN IF NOT EXISTS "run_started_at" timestamptz;--> statement-breakpoint

CREATE OR REPLACE VIEW "runs_costs" AS SELECT * FROM "runs_costs_old";--> statement-breakpoint

-- Partial covering index: serves the dated platform-spend SUM as an index-only
-- scan over ONLY the platform-projected rows (INCLUDE carries the summed amount),
-- no join, no heap. Built here non-concurrent + IF NOT EXISTS for fresh/test DBs;
-- on prod/staging it is built out-of-band CONCURRENTLY first so this statement
-- no-ops (migration 0027 / 0029 pattern — a non-concurrent boot-migrator build
-- would lock writes on the large ledger).
CREATE INDEX IF NOT EXISTS "idx_runs_costs_projected_started"
  ON "runs_costs_old" ("run_started_at")
  INCLUDE ("total_cost_in_usd_cents")
  WHERE "is_platform_projected";--> statement-breakpoint

-- Covering index for the de-joined run-count-per-day read: `(started_at, status)`
-- lets `GET /public/stats/runs` count runs per UTC day per status with an
-- index-only scan instead of a full heap seq scan of `runs`. Same out-of-band
-- CONCURRENT build discipline on prod/staging.
CREATE INDEX IF NOT EXISTS "idx_runs_started_status"
  ON "runs_old" ("started_at", "status");--> statement-breakpoint

-- Covering index for the per-brand cross-org cost aggregation
-- (`GET /v1/stats/public/costs?groupBy=brandId&featureSlugs=...`, 346 calls x 11.4s
-- in the same measurement). The scan is driven by `feature_slug` and needs only
-- `id` + `brand_ids`, so INCLUDE-ing both turns a full heap scan of `runs` into an
-- index-only scan of just the matching feature's rows.
CREATE INDEX IF NOT EXISTS "idx_runs_feature_brands"
  ON "runs_old" ("feature_slug")
  INCLUDE ("id", "brand_ids");--> statement-breakpoint

-- Re-teach the bronze->silver cost projection trigger to materialize the run's
-- started_at from the cost.added payload key `runStartedAt`. Pre-feature bronze
-- events (no key) project NULL — the out-of-band backfill fills those. Every other
-- column is unchanged from migration 0029; cost.materialized / cost.cancelled never
-- touch run_started_at (a cost's owning run never changes).
CREATE OR REPLACE FUNCTION project_cost_lifecycle_to_silver() RETURNS trigger AS $$
BEGIN
  IF NEW.cost_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.event_type = 'cost.added' THEN
    INSERT INTO runs_costs (
      id, run_id, cost_name, cost_source, quantity,
      unit_cost_in_usd_cents, total_cost_in_usd_cents,
      net_cost_in_usd_cents, usage_discount_pct, status,
      goal, brand_profile_id, audience_id, workflow_context,
      organization_id, run_started_at, idempotency_key, created_at
    ) VALUES (
      NEW.cost_id,
      NEW.run_id,
      NEW.payload->>'costName',
      NEW.payload->>'costSource',
      (NEW.payload->>'quantity')::numeric,
      (NEW.payload->>'unitCostInUsdCents')::numeric,
      (NEW.payload->>'totalCostInUsdCents')::numeric,
      COALESCE((NEW.payload->>'netCostInUsdCents')::numeric, (NEW.payload->>'totalCostInUsdCents')::numeric),
      (NEW.payload->>'usageDiscountPct')::numeric,
      COALESCE(NEW.payload->>'status', 'actual'),
      NEW.payload->>'goal',
      NEW.payload->>'brandProfileId',
      COALESCE(NEW.payload->>'audienceId', NEW.payload->>'customerProfileId'),
      NEW.payload->>'workflowContext',
      (NEW.payload->>'runOrganizationId')::uuid,
      (NEW.payload->>'runStartedAt')::timestamptz,
      NEW.payload->>'idempotencyKey',
      NEW.occurred_at
    )
    ON CONFLICT (id) DO NOTHING;
  ELSIF NEW.event_type = 'cost.materialized' THEN
    UPDATE runs_costs SET status = 'actual' WHERE id = NEW.cost_id;
  ELSIF NEW.event_type = 'cost.cancelled' THEN
    UPDATE runs_costs SET status = 'cancelled' WHERE id = NEW.cost_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
