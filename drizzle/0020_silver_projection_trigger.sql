-- Phase 5 of B/S/G substrate (γ migration plan).
-- Trigger functions project silver state from bronze domain events.
-- After this migration, the app writes ONLY to bronze; silver becomes a
-- derived projection. Bronze = source of truth; silver = read-optimized cache.
--
-- Doctrine: trigger fires AFTER INSERT ON the bronze table. Each domain event
-- type maps to one silver mutation. `run.created` / `cost.added` create rows.
-- `run.completed` / `run.failed` / `cost.materialized` / `cost.cancelled`
-- update the existing silver row. ON CONFLICT DO NOTHING on creates makes
-- the trigger idempotent under replay.

CREATE OR REPLACE FUNCTION project_run_lifecycle_to_silver() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type = 'run.created' THEN
    INSERT INTO runs (
      id, parent_run_id, organization_id, user_id, brand_ids, campaign_id,
      workflow_slug, feature_slug, service_name, task_name, status,
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
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_project_run_lifecycle ON run_lifecycle_events;--> statement-breakpoint
CREATE TRIGGER trg_project_run_lifecycle
AFTER INSERT ON run_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION project_run_lifecycle_to_silver();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_project_cost_lifecycle ON cost_lifecycle_events;--> statement-breakpoint
CREATE TRIGGER trg_project_cost_lifecycle
AFTER INSERT ON cost_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION project_cost_lifecycle_to_silver();
