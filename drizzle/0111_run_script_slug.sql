-- MON-SCRIPT-PRICES-2-1111: every run carries the SCRIPT it works for (`<outcome>/<dynasty>/v<version>`, the
-- name workflow-service gives a stored script's run), so the ledger measures each script apart, never one pool.
--   runs.script_slug: stated by the writer that opens a script run (POST /v1/runs `scriptSlug`); a child run
--     inherits its parent's, and the OUTERMOST script of a chain wins (a script nested in another is part of
--     the outer one's production). Filled on recorded history by bronze `run.script_stated` (NULL only).
--   outcome_cost_days.script_slug / source_script_slug: the dimension, beside workflow_slug / source_workflow_slug.
--   cost_ledger_computed_days.script_slugs: the day was computed with those columns. Days before the first
--     Engine run (2026-11-05) hold no script run that is not inside a workflow: computed identically, flagged
--     true here; later days read as missing for a script read until the refresher recomputes them.
--
-- BOOT-WINDOW SAFE: nullable / defaulted column adds (metadata only) + a function body replace; the flag
-- UPDATE touches the few hundred computed-day rows.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN IF NOT EXISTS script_slug text;
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS script_slug text;
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS source_script_slug text;
--> statement-breakpoint
ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS script_slugs boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE cost_ledger_computed_days SET script_slugs = true WHERE day < DATE '2026-11-05';
--> statement-breakpoint
-- Body = migration 0044's function + script_slug on run.created + the run.script_stated branch.
CREATE OR REPLACE FUNCTION project_run_lifecycle_to_silver() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type = 'run.created' THEN
    INSERT INTO runs (
      id, parent_run_id, organization_id, user_id, brand_ids, campaign_id,
      workflow_slug, feature_slug, goal, brand_profile_id, audience_id,
      workflow_context, script_slug, service_name, task_name, status,
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
      NULLIF(NEW.payload->>'scriptSlug', ''),
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
  ELSIF NEW.event_type = 'run.script_stated' THEN
    UPDATE runs
       SET script_slug = NEW.payload->>'scriptSlug',
           updated_at = NEW.occurred_at
     WHERE id = NEW.run_id
       AND script_slug IS NULL
       AND NULLIF(NEW.payload->>'scriptSlug', '') IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
