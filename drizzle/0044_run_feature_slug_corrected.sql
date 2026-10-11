-- run.feature_slug_corrected: a recorded fact about a run's feature slug that its
-- writer failed to state (instantly-service opened AI Instant Call parent runs
-- without one until v0.83.35; children inherit, so the whole subtree read $0 under
-- the campaign's feature). The correction is a BRONZE event (the audit trail:
-- who, why, when) projected here; it only fills a NULL slug, never overwrites one.
-- The rollups keyed on feature_slug follow by their existing UPDATE OF triggers.
-- Body = migration 0025's function + the new branch.
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
  ELSIF NEW.event_type = 'run.feature_slug_corrected' THEN
    UPDATE runs
       SET feature_slug = NEW.payload->>'featureSlug',
           updated_at = NEW.occurred_at
     WHERE id = NEW.run_id
       AND feature_slug IS NULL
       AND NULLIF(NEW.payload->>'featureSlug', '') IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
