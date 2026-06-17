-- Persist explicit persona/profile attribution on runs and cost rows.
--
-- The live Drizzle table names `runs` / `runs_costs` are passthrough views
-- over `runs_old` / `runs_costs_old` (migration 0021). Add nullable columns to
-- the base tables, refresh the views so callers can read/write them, and teach
-- the bronze→silver projection triggers to materialize the explicit tags.
--
-- No inference or fallback is introduced here: untagged activity remains NULL.

ALTER TABLE "runs_old" ADD COLUMN IF NOT EXISTS "goal" text;--> statement-breakpoint
ALTER TABLE "runs_old" ADD COLUMN IF NOT EXISTS "brand_profile_id" text;--> statement-breakpoint
ALTER TABLE "runs_old" ADD COLUMN IF NOT EXISTS "customer_profile_id" text;--> statement-breakpoint
ALTER TABLE "runs_old" ADD COLUMN IF NOT EXISTS "workflow_context" text;--> statement-breakpoint

ALTER TABLE "runs_costs_old" ADD COLUMN IF NOT EXISTS "goal" text;--> statement-breakpoint
ALTER TABLE "runs_costs_old" ADD COLUMN IF NOT EXISTS "brand_profile_id" text;--> statement-breakpoint
ALTER TABLE "runs_costs_old" ADD COLUMN IF NOT EXISTS "customer_profile_id" text;--> statement-breakpoint
ALTER TABLE "runs_costs_old" ADD COLUMN IF NOT EXISTS "workflow_context" text;--> statement-breakpoint

CREATE OR REPLACE VIEW "runs" AS SELECT * FROM "runs_old";--> statement-breakpoint
CREATE OR REPLACE VIEW "runs_costs" AS SELECT * FROM "runs_costs_old";--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_runs_goal_org" ON "runs_old" USING btree ("goal","organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_brand_profile" ON "runs_old" USING btree ("brand_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_customer_profile" ON "runs_old" USING btree ("customer_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_costs_goal" ON "runs_costs_old" USING btree ("goal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_costs_brand_profile" ON "runs_costs_old" USING btree ("brand_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_costs_customer_profile" ON "runs_costs_old" USING btree ("customer_profile_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION project_run_lifecycle_to_silver() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type = 'run.created' THEN
    INSERT INTO runs (
      id, parent_run_id, organization_id, user_id, brand_ids, campaign_id,
      workflow_slug, feature_slug, goal, brand_profile_id, customer_profile_id,
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
      NEW.payload->>'customerProfileId',
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
      goal, brand_profile_id, customer_profile_id, workflow_context,
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
      NEW.payload->>'customerProfileId',
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
