-- Org cascade teardown support.
--
-- `run.org_teardown` is the source-of-truth tombstone for a deleted org's
-- run-owned state. The HTTP endpoint deletes current silver projections after
-- writing this event. If bronze is replayed later, this trigger branch
-- neutralizes org identity so replayed rows do not count as active billable
-- org state again.

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
  ELSIF NEW.event_type = 'run.org_teardown' THEN
    UPDATE runs
       SET organization_id = NULL,
           user_id = NULL,
           brand_ids = NULL,
           campaign_id = NULL,
           workflow_slug = NULL,
           feature_slug = NULL,
           updated_at = NEW.occurred_at
     WHERE id = NEW.run_id
       AND organization_id = NULLIF(NEW.payload->>'organizationId', '')::uuid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
