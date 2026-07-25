-- Denormalize the run's organization_id onto every cost row at write time.
--
-- Why: org-level platform-spend reads — billing authorize via
-- GET /internal/org-usage-total (48.7% of all DB time) and the org-spend read in
-- src/routes/runs.ts (22.2%) — must SUM an org's platform costs. The org lived
-- ONLY on `runs` while the money lives on `runs_costs`, so each read joined
-- runs (JOIN) runs_costs and, for large orgs, ran TWO full-table parallel
-- seq-scans + a disk-spilling hash join (~4s, both vCPUs). Those two reads were
-- 71% of DB time and the direct cause of prod compute pegging its 2 CU cap.
--
-- Freezing the org onto the cost row (same pattern as goal / brand_profile_id /
-- audience_id, already denormalized here, and net_cost in migration 0028) lets
-- the read SUM a single indexed table with no join. The writer already holds the
-- run's org at cost-write time — this persists it instead of re-deriving it on
-- every read (CLAUDE.md "read-side derivation of a value the WRITER already held").
--
-- EXPAND ONLY. The column is NULLABLE and NOT backfilled here (a full-table
-- UPDATE on the multi-million-row ledger would block boot — CLAUDE.md
-- "Boot-window hazards"). Backfill runs out-of-band via
-- scripts/backfill-cost-org.ts. The read swap to the denormalized column ships in
-- a SEPARATE later deploy, only AFTER that backfill completes
-- (expand -> backfill -> swap), so a partially-populated column can never
-- under-report org spend (which would let billing over-authorize).
--
-- Live Drizzle table names `runs` / `runs_costs` are auto-updatable passthrough
-- VIEWS over `runs_old` / `runs_costs_old` (migration 0021). Add the column to the
-- base table, then CREATE OR REPLACE VIEW to append it to the shim (append is
-- auto-updatable-safe; see CLAUDE.md "Add a column" + migration 0024).

ALTER TABLE "runs_costs_old" ADD COLUMN IF NOT EXISTS "organization_id" uuid;--> statement-breakpoint

CREATE OR REPLACE VIEW "runs_costs" AS SELECT * FROM "runs_costs_old";--> statement-breakpoint

-- Partial covering index: serves the org-spend SUM as an index scan over ONLY the
-- org's platform-projected rows (INCLUDE carries the summed amounts so it can be
-- index-only after VACUUM), no join, no full-table scan. Built here non-concurrent
-- + IF NOT EXISTS for fresh/test DBs; on prod/staging it is built out-of-band
-- CONCURRENTLY first so this statement no-ops (migration 0027 pattern — a
-- non-concurrent boot-migrator build would lock writes on the large ledger).
CREATE INDEX IF NOT EXISTS "idx_runs_costs_org_projected"
  ON "runs_costs_old" ("organization_id")
  INCLUDE ("total_cost_in_usd_cents", "net_cost_in_usd_cents")
  WHERE "is_platform_projected";--> statement-breakpoint

-- Re-teach the bronze->silver cost projection trigger to materialize the run's
-- organization_id from the cost.added payload key `runOrganizationId`. Pre-feature
-- bronze events (no key) project NULL — the out-of-band backfill fills those. Every
-- other column is unchanged from migration 0028; cost.materialized / cost.cancelled
-- never touch organization_id (a cost's org never changes).
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
      organization_id, idempotency_key, created_at
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
