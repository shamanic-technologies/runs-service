-- Retire the customer_profile / persona attribution vocabulary in favor of
-- "audience" (a human-service org-scoped saved filter-set, audience.id UUID).
--
-- The column was added one release ago (migration 0024, PR #152) and carries
-- ZERO tagged rows in prod, so this is a pure metadata rename — no data
-- migration, forward-only, no backfill.
--
-- Live Drizzle table names `runs` / `runs_costs` are auto-updatable passthrough
-- VIEWS over the `runs_old` / `runs_costs_old` base tables (migration 0021).
-- A base-column rename does NOT propagate to a `SELECT *` view's output column
-- (verified on PG 17), so we rename the column on BOTH the base table and the
-- view. `ALTER TABLE <view> RENAME COLUMN` is metadata-only and does NOT drop
-- the view, so the dependent gold views (v_runs_with_descendants,
-- v_run_cost_rollup, v_org_platform_spend) that SELECT FROM these shims are
-- left completely untouched — no recreation, no CASCADE, cost-rollup read path
-- unaffected.
--
-- Write-through the renamed view column still works (the projection triggers
-- below INSERT INTO runs / runs_costs), confirmed on the auto-updatable view.

-- Base tables.
ALTER TABLE "runs_old" RENAME COLUMN "customer_profile_id" TO "audience_id";--> statement-breakpoint
ALTER TABLE "runs_costs_old" RENAME COLUMN "customer_profile_id" TO "audience_id";--> statement-breakpoint

-- Passthrough view shims (metadata-only rename of the output column).
ALTER TABLE "runs" RENAME COLUMN "customer_profile_id" TO "audience_id";--> statement-breakpoint
ALTER TABLE "runs_costs" RENAME COLUMN "customer_profile_id" TO "audience_id";--> statement-breakpoint

-- Indexes.
ALTER INDEX "idx_runs_customer_profile" RENAME TO "idx_runs_audience";--> statement-breakpoint
ALTER INDEX "idx_runs_costs_customer_profile" RENAME TO "idx_runs_costs_audience";--> statement-breakpoint

-- Re-teach the bronze->silver projection triggers to materialize the new
-- audience_id column from the new payload key. COALESCE falls back to the
-- legacy `customerProfileId` payload key so any pre-existing bronze event still
-- projects correctly on replay (forward-only: new events carry `audienceId`).

CREATE OR REPLACE FUNCTION project_run_lifecycle_to_silver() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type = 'run.created' THEN
    INSERT INTO runs (
      id, parent_run_id, organization_id, user_id, brand_ids, campaign_id,
      workflow_slug, feature_slug, goal, brand_profile_id, audience_id,
      workflow_context, service_name, task_name, status,
      idempotency_key, started_at, created_at, updated_at
    ) VALUES (
      NEW.run_id,
      NULLIF(NEW.payload->>'parentRunId', '')::uuid,
      NULLIF(NEW.payload->>'organizationId', '')::uuid,
      NULLIF(NEW.payload->>'userId', '')::uuid,
      CASE
        WHEN NEW.payload->'brandIds' IS NULL OR jsonb_typeof(NEW.payload->'brandIds') = 'null' THEN NULL
        ELSE ARRAY(SELECT jsonb_array_elements_text(NEW.payload->'brandIds'))
      END,
      NEW.payload->>'campaignId',
      NEW.payload->>'workflowSlug',
      NEW.payload->>'featureSlug',
      NEW.payload->>'goal',
      NEW.payload->>'brandProfileId',
      COALESCE(NEW.payload->>'audienceId', NEW.payload->>'customerProfileId'),
      NEW.payload->>'workflowContext',
      NEW.payload->>'serviceName',
      NEW.payload->>'taskName',
      'running',
      NEW.payload->>'idempotencyKey',
      NEW.occurred_at,
      NEW.occurred_at,
      NEW.occurred_at
    )
    ON CONFLICT (id) DO NOTHING;
  ELSIF NEW.event_type IN ('run.completed', 'run.failed') THEN
    UPDATE runs
       SET status = CASE NEW.event_type WHEN 'run.completed' THEN 'completed' ELSE 'failed' END,
           completed_at = NEW.occurred_at,
           updated_at = NEW.occurred_at
     WHERE id = NEW.run_id;
  ELSIF NEW.event_type = 'run.org_deleted' THEN
    DELETE FROM runs WHERE id = NEW.run_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION project_cost_lifecycle_to_silver() RETURNS trigger AS $$
BEGIN
  -- Trigger requires NEW.cost_id for any state mutation. Direct bronze
  -- inserts with NULL cost_id (audit-only, no silver projection desired)
  -- are silently skipped — caller must populate cost_id when they want
  -- silver to materialize.
  IF NEW.cost_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.event_type = 'cost.added' THEN
    INSERT INTO runs_costs (
      id, run_id, cost_name, cost_source, quantity,
      unit_cost_in_usd_cents, total_cost_in_usd_cents, status,
      goal, brand_profile_id, audience_id, workflow_context,
      idempotency_key, created_at
    ) VALUES (
      NEW.cost_id,
      NEW.run_id,
      NEW.payload->>'costName',
      NEW.payload->>'costSource',
      (NEW.payload->>'quantity')::numeric,
      (NEW.payload->>'unitCostInUsdCents')::numeric,
      (NEW.payload->>'totalCostInUsdCents')::numeric,
      COALESCE(NEW.payload->>'status', 'actual'),
      NEW.payload->>'goal',
      NEW.payload->>'brandProfileId',
      COALESCE(NEW.payload->>'audienceId', NEW.payload->>'customerProfileId'),
      NEW.payload->>'workflowContext',
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
