-- SERVED-MODEL-1116-NESTED-RUNS: a script ASKED by another script (workflow-service opens the asked script's run
-- under the asking script's run, stating its own slug) is its OWN decision. runs.script_slug keeps the OUTERMOST
-- script (the ledger's whole-chain dimension, unchanged); runs.decision_script_slug = the innermost script stated
-- (the run's own, else its parent's), read by every decision reader as COALESCE(decision_script_slug, script_slug).
--   run.created: payload decisionScriptSlug.
--   run.decision_script_stated: bronze fact re-stating recorded history (POST /internal/runs/script-statements).
--
-- BOOT-WINDOW SAFE: the column add and the index are pre-run out-of-band on prod (ADD COLUMN, then CREATE INDEX
-- CONCURRENTLY), so both no-op here; each still takes a lock on runs, so each RETRIES on lock_not_available inside
-- the migration (0111's single 10 s lock_timeout crash-looped the boot 4 times). No row is rewritten.
DO $$
DECLARE tries int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'runs' AND column_name = 'decision_script_slug') THEN RETURN; END IF;
  LOOP
    BEGIN
      PERFORM set_config('lock_timeout', '2s', true);
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS decision_script_slug text;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF tries >= 60 THEN RAISE; END IF;
      PERFORM pg_sleep(0.5);
    END;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE tries int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_runs_decision_script_cover' AND relkind = 'i') THEN RETURN; END IF;
  LOOP
    BEGIN
      PERFORM set_config('lock_timeout', '2s', true);
      CREATE INDEX IF NOT EXISTS idx_runs_decision_script_cover
        ON runs (script_slug) INCLUDE (id, parent_run_id, started_at, brand_ids, decision_script_slug)
        WHERE script_slug IS NOT NULL;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF tries >= 60 THEN RAISE; END IF;
      PERFORM pg_sleep(0.5);
    END;
  END LOOP;
END $$;
--> statement-breakpoint
-- Body = migration 0111's function + decision_script_slug on run.created + the run.decision_script_stated branch.
CREATE OR REPLACE FUNCTION project_run_lifecycle_to_silver() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type = 'run.created' THEN
    INSERT INTO runs (
      id, parent_run_id, organization_id, user_id, brand_ids, campaign_id,
      workflow_slug, feature_slug, goal, brand_profile_id, audience_id,
      workflow_context, script_slug, decision_script_slug, service_name, task_name, status,
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
      NULLIF(NEW.payload->>'decisionScriptSlug', ''),
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
  ELSIF NEW.event_type = 'run.decision_script_stated' THEN
    UPDATE runs
       SET decision_script_slug = NEW.payload->>'decisionScriptSlug',
           updated_at = NEW.occurred_at
     WHERE id = NEW.run_id
       AND NULLIF(NEW.payload->>'decisionScriptSlug', '') IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
