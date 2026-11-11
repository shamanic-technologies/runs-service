-- SEND-RUN-LATENCY-1111: a new run's rollup +1s leave the write transaction.
--
-- Opening a run fired six AFTER INSERT triggers that upsert SHARED rollup rows (per org x day,
-- per org x hour, the fleet-wide day x status counter, the per feature x workflow counter). A row
-- upsert holds that row until COMMIT, so every run open of the same org (and every open + status
-- change fleet-wide, on the day counter) queued behind the previous writer's remaining triggers and
-- commit flush. On the loaded box that queue reached minutes (postmark run opens max 182 s, prod
-- lock-wait log 2026-11-11: waits on stats_rollup_audience_runs / stats_rollup_org_hour rows).
--
-- When the session sets `runs.defer_run_rollups = on` (the service's write pool does), those +1s
-- (and the day x status counter's moves on a status change) are APPENDED to run_rollup_deltas
-- instead: an insert into an append-only table conflicts with nobody. drain_run_rollup_deltas()
-- (in-process worker, ~1 s) folds them into the same rollup rows, aggregated per key, one drain at a
-- time (advisory lock). Every delta is +1 / -1 added to a sum and min/max widened: they commute with
-- every synchronous trigger (moves, deletes, cost writes), so the rollups end exactly where they
-- would have, no write is lost (the queue is a table, drained in the transaction that deletes it).
-- Sessions that do not set it (scripts, tests, the kill switch) keep the synchronous path unchanged.

CREATE TABLE IF NOT EXISTS run_rollup_deltas (
  id              bigserial PRIMARY KEY,
  -- 'run' = a new run (+1 in every run-count rollup); 'run_day' = a day x status counter move.
  kind            text NOT NULL,
  delta           bigint NOT NULL,
  started_at      timestamptz NOT NULL,
  status          text NOT NULL,
  organization_id uuid,
  brand_ids       text[],
  campaign_id     text,
  feature_slug    text,
  workflow_slug   text,
  audience_id     text,
  service_name    text,
  task_name       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION run_rollups_deferred() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('runs.defer_run_rollups', true), '') = 'on'
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION run_rollup_deltas_enqueue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF run_rollups_deferred() THEN
    INSERT INTO run_rollup_deltas (kind, delta, started_at, status, organization_id, brand_ids, campaign_id,
      feature_slug, workflow_slug, audience_id, service_name, task_name)
    VALUES ('run', 1, NEW.started_at, NEW.status, NEW.organization_id, NEW.brand_ids, NEW.campaign_id,
      NEW.feature_slug, NEW.workflow_slug, NEW.audience_id, NEW.service_name, NEW.task_name);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS run_rollup_deltas_enqueue ON runs;
--> statement-breakpoint
CREATE TRIGGER run_rollup_deltas_enqueue AFTER INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION run_rollup_deltas_enqueue();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.stats_rollup_run_day_on_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at THEN
    RETURN NULL;
  END IF;
  IF run_rollups_deferred() THEN
    -- A new run's +1 rides its 'run' delta (run_rollup_deltas_enqueue); a move is queued here.
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      INSERT INTO run_rollup_deltas (kind, delta, started_at, status) VALUES ('run_day', -1, OLD.started_at, OLD.status);
    END IF;
    IF TG_OP = 'UPDATE' THEN
      INSERT INTO run_rollup_deltas (kind, delta, started_at, status) VALUES ('run_day', 1, NEW.started_at, NEW.status);
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM stats_rollup_run_day_add(OLD.started_at, OLD.status, -1);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM stats_rollup_run_day_add(NEW.started_at, NEW.status, 1);
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.stats_rollup_on_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A new run's +1 waits in run_rollup_deltas when this session defers (SEND-RUN-LATENCY-1111).
    IF NOT run_rollups_deferred() THEN
      PERFORM stats_rollup_add_runs(NEW.feature_slug, NEW.workflow_slug, 1);
    END IF;
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
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.stats_rollup_campaign_on_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A new run's +1 waits in run_rollup_deltas when this session defers (SEND-RUN-LATENCY-1111).
    IF NOT run_rollups_deferred() THEN
      PERFORM stats_rollup_campaign_add_runs(NEW.campaign_id, NEW.started_at, NEW.organization_id, NEW.brand_ids, NEW.feature_slug, NEW.workflow_slug, 1);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.brand_ids IS DISTINCT FROM OLD.brand_ids
       OR NEW.feature_slug IS DISTINCT FROM OLD.feature_slug
       OR NEW.workflow_slug IS DISTINCT FROM OLD.workflow_slug THEN
      PERFORM stats_rollup_campaign_add_runs(OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids, OLD.feature_slug, OLD.workflow_slug, -1);
      PERFORM stats_rollup_campaign_add_runs(NEW.campaign_id, NEW.started_at, NEW.organization_id, NEW.brand_ids, NEW.feature_slug, NEW.workflow_slug, 1);
      PERFORM stats_rollup_campaign_move_run_costs(NEW.id, OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids, OLD.feature_slug, OLD.workflow_slug, -1);
      PERFORM stats_rollup_campaign_move_run_costs(NEW.id, NEW.campaign_id, NEW.started_at, NEW.organization_id, NEW.brand_ids, NEW.feature_slug, NEW.workflow_slug, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: remove the run's cost rows while the run is still visible
    -- (their own cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_campaign_add_runs(OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids, OLD.feature_slug, OLD.workflow_slug, -1);
    PERFORM stats_rollup_campaign_move_run_costs(OLD.id, OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids, OLD.feature_slug, OLD.workflow_slug, -1);
    RETURN OLD;
  END IF;
END;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.stats_rollup_org_hour_on_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A new run's +1 waits in run_rollup_deltas when this session defers (SEND-RUN-LATENCY-1111).
    IF NOT run_rollups_deferred() THEN
      PERFORM stats_rollup_org_hour_add_runs(NEW.organization_id, NEW.brand_ids, NEW.campaign_id, NEW.started_at, 1);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.brand_ids IS DISTINCT FROM OLD.brand_ids
       OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      PERFORM stats_rollup_org_hour_add_runs(OLD.organization_id, OLD.brand_ids, OLD.campaign_id, OLD.started_at, -1);
      PERFORM stats_rollup_org_hour_add_runs(NEW.organization_id, NEW.brand_ids, NEW.campaign_id, NEW.started_at, 1);
      PERFORM stats_rollup_org_hour_move_run_costs(NEW.id, OLD.organization_id, OLD.brand_ids, OLD.campaign_id, OLD.started_at, -1);
      PERFORM stats_rollup_org_hour_move_run_costs(NEW.id, NEW.organization_id, NEW.brand_ids, NEW.campaign_id, NEW.started_at, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: the run is still visible, so its cost rows can be removed here
    -- (their own cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_org_hour_add_runs(OLD.organization_id, OLD.brand_ids, OLD.campaign_id, OLD.started_at, -1);
    PERFORM stats_rollup_org_hour_move_run_costs(OLD.id, OLD.organization_id, OLD.brand_ids, OLD.campaign_id, OLD.started_at, -1);
    RETURN OLD;
  END IF;
END;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.stats_rollup_org_task_on_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A new run's +1 waits in run_rollup_deltas when this session defers (SEND-RUN-LATENCY-1111).
    IF NOT run_rollups_deferred() THEN
      PERFORM stats_rollup_org_task_add_runs(NEW.organization_id, NEW.service_name, NEW.task_name, NEW.campaign_id, NEW.started_at, 1);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.service_name IS DISTINCT FROM OLD.service_name
       OR NEW.task_name IS DISTINCT FROM OLD.task_name
       OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      PERFORM stats_rollup_org_task_add_runs(OLD.organization_id, OLD.service_name, OLD.task_name, OLD.campaign_id, OLD.started_at, -1);
      PERFORM stats_rollup_org_task_add_runs(NEW.organization_id, NEW.service_name, NEW.task_name, NEW.campaign_id, NEW.started_at, 1);
      PERFORM stats_rollup_org_task_move_run_costs(NEW.id, OLD.organization_id, OLD.service_name, OLD.task_name, OLD.campaign_id, OLD.started_at, -1);
      PERFORM stats_rollup_org_task_move_run_costs(NEW.id, NEW.organization_id, NEW.service_name, NEW.task_name, NEW.campaign_id, NEW.started_at, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: the run is still visible, so its cost rows can be removed here
    -- (their own cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_org_task_add_runs(OLD.organization_id, OLD.service_name, OLD.task_name, OLD.campaign_id, OLD.started_at, -1);
    PERFORM stats_rollup_org_task_move_run_costs(OLD.id, OLD.organization_id, OLD.service_name, OLD.task_name, OLD.campaign_id, OLD.started_at, -1);
    RETURN OLD;
  END IF;
END;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.stats_rollup_audience_on_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A new run's +1 waits in run_rollup_deltas when this session defers (SEND-RUN-LATENCY-1111).
    IF NOT run_rollups_deferred() THEN
      -- A new run has no cost row yet (FK): S = { its audience }.
      PERFORM stats_rollup_audience_add_runs(NEW.campaign_id, NEW.started_at, NEW.organization_id, NEW.brand_ids,
        NEW.feature_slug, NEW.workflow_slug, NEW.audience_id, 1);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.brand_ids IS DISTINCT FROM OLD.brand_ids
       OR NEW.feature_slug IS DISTINCT FROM OLD.feature_slug
       OR NEW.workflow_slug IS DISTINCT FROM OLD.workflow_slug
       OR NEW.audience_id IS DISTINCT FROM OLD.audience_id THEN
      PERFORM stats_rollup_audience_lock_run(NEW.id);
      PERFORM stats_rollup_audience_move_run(NEW.id, OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids,
        OLD.feature_slug, OLD.workflow_slug, OLD.audience_id, -1);
      PERFORM stats_rollup_audience_move_run(NEW.id, NEW.campaign_id, NEW.started_at, NEW.organization_id, NEW.brand_ids,
        NEW.feature_slug, NEW.workflow_slug, NEW.audience_id, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: the run and its cost rows are still visible (their own
    -- cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_audience_lock_run(OLD.id);
    PERFORM stats_rollup_audience_move_run(OLD.id, OLD.campaign_id, OLD.started_at, OLD.organization_id, OLD.brand_ids,
      OLD.feature_slug, OLD.workflow_slug, OLD.audience_id, -1);
    RETURN OLD;
  END IF;
END;
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.stats_rollup_task_day_on_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A new run's +1 waits in run_rollup_deltas when this session defers (SEND-RUN-LATENCY-1111).
    IF NOT run_rollups_deferred() THEN
      PERFORM stats_rollup_task_day_add_runs(NEW.organization_id, NEW.campaign_id, NEW.feature_slug, NEW.service_name,
        NEW.task_name, NEW.brand_ids, NEW.started_at, 1, 0);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.feature_slug IS DISTINCT FROM OLD.feature_slug
       OR NEW.service_name IS DISTINCT FROM OLD.service_name
       OR NEW.task_name IS DISTINCT FROM OLD.task_name
       OR NEW.brand_ids IS DISTINCT FROM OLD.brand_ids
       OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      PERFORM stats_rollup_task_day_move_run(NEW.id, OLD.organization_id, OLD.campaign_id, OLD.feature_slug,
        OLD.service_name, OLD.task_name, OLD.brand_ids, OLD.started_at, -1);
      PERFORM stats_rollup_task_day_move_run(NEW.id, NEW.organization_id, NEW.campaign_id, NEW.feature_slug,
        NEW.service_name, NEW.task_name, NEW.brand_ids, NEW.started_at, 1);
    END IF;
    RETURN NEW;
  ELSE
    -- BEFORE DELETE: the run is still visible, so its cost rows are removed here
    -- (their own cascaded DELETE trigger can no longer resolve the run).
    PERFORM stats_rollup_task_day_move_run(OLD.id, OLD.organization_id, OLD.campaign_id, OLD.feature_slug,
      OLD.service_name, OLD.task_name, OLD.brand_ids, OLD.started_at, -1);
    RETURN OLD;
  END IF;
END;
$function$;

--> statement-breakpoint

-- Fold queued deltas into the rollups, oldest first, at most p_limit (NULL = all).
--  - One drain at a time (advisory lock): a rebuild drains under its table lock and must not race an
--    in-flight batch (stats-rollup.ts).
--  - The deltas it applies are deleted in the same transaction: a failed drain leaves them queued.
--  - Tables in the order every synchronous writer locks them (run triggers fire audience, campaign,
--    org_hour, org_task, run_day, feature x workflow, task_day; cost triggers org_hour, org_task,
--    task_day), rows in key order, so a drain never waits in a cycle with a one-row-per-table writer.
--  - lock_timeout 800 ms, under the 1 s deadlock_timeout: should a multi-run batch writer still close
--    a cycle, the drain gives up first (its deltas wait for the next tick) and the writer goes on.
-- Same upserts as the *_add_runs functions' positive branch, aggregated per key (sum, min, max).
CREATE OR REPLACE FUNCTION drain_run_rollup_deltas(p_limit integer) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('run_rollup_deltas_drain'));
  PERFORM set_config('lock_timeout', '800ms', true);
  IF to_regclass('pg_temp.run_rollup_deltas_batch') IS NULL THEN
    CREATE TEMP TABLE run_rollup_deltas_batch (LIKE run_rollup_deltas) ON COMMIT DELETE ROWS;
  END IF;
  DELETE FROM run_rollup_deltas_batch;
  WITH picked AS (
    DELETE FROM run_rollup_deltas
    WHERE id IN (SELECT id FROM run_rollup_deltas ORDER BY id LIMIT p_limit)
    RETURNING *
  )
  INSERT INTO run_rollup_deltas_batch SELECT * FROM picked;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO stats_rollup_audience_runs (
    campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, audience_id,
    run_count, min_started_at, max_started_at, minmax_stale)
  SELECT campaign_id, (started_at AT TIME ZONE 'UTC')::date, organization_id, brand_ids, feature_slug, workflow_slug, audience_id,
    sum(delta), min(started_at), max(started_at), false
  FROM run_rollup_deltas_batch WHERE kind = 'run' GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY 1, 2, 3, 4, 5, 6, 7
  ON CONFLICT ON CONSTRAINT stats_rollup_audience_runs_key DO UPDATE SET
    run_count      = stats_rollup_audience_runs.run_count + EXCLUDED.run_count,
    min_started_at = LEAST(stats_rollup_audience_runs.min_started_at, EXCLUDED.min_started_at),
    max_started_at = GREATEST(stats_rollup_audience_runs.max_started_at, EXCLUDED.max_started_at);

  INSERT INTO stats_rollup_campaign_runs (
    campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug,
    run_count, min_started_at, max_started_at, minmax_stale)
  SELECT campaign_id, (started_at AT TIME ZONE 'UTC')::date, organization_id, brand_ids, feature_slug, workflow_slug,
    sum(delta), min(started_at), max(started_at), false
  FROM run_rollup_deltas_batch WHERE kind = 'run' GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 2, 3, 4, 5, 6
  ON CONFLICT ON CONSTRAINT stats_rollup_campaign_runs_key DO UPDATE SET
    run_count      = stats_rollup_campaign_runs.run_count + EXCLUDED.run_count,
    min_started_at = LEAST(stats_rollup_campaign_runs.min_started_at, EXCLUDED.min_started_at),
    max_started_at = GREATEST(stats_rollup_campaign_runs.max_started_at, EXCLUDED.max_started_at);

  INSERT INTO stats_rollup_org_hour (organization_id, brand_ids, campaign_id, hour, run_count, min_started_at, max_started_at)
  SELECT organization_id, brand_ids, campaign_id, date_trunc('hour', started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
    sum(delta), min(started_at), max(started_at)
  FROM run_rollup_deltas_batch WHERE kind = 'run' GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4
  ON CONFLICT ON CONSTRAINT stats_rollup_org_hour_key DO UPDATE SET
    run_count      = stats_rollup_org_hour.run_count + EXCLUDED.run_count,
    min_started_at = LEAST(stats_rollup_org_hour.min_started_at, EXCLUDED.min_started_at),
    max_started_at = GREATEST(stats_rollup_org_hour.max_started_at, EXCLUDED.max_started_at);

  INSERT INTO stats_rollup_org_task (organization_id, service_name, task_name, campaign_id, day, run_count, min_started_at, max_started_at)
  SELECT organization_id, service_name, task_name, campaign_id, (started_at AT TIME ZONE 'UTC')::date,
    sum(delta), min(started_at), max(started_at)
  FROM run_rollup_deltas_batch WHERE kind = 'run' GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5
  ON CONFLICT ON CONSTRAINT stats_rollup_org_task_key DO UPDATE SET
    run_count      = stats_rollup_org_task.run_count + EXCLUDED.run_count,
    min_started_at = LEAST(stats_rollup_org_task.min_started_at, EXCLUDED.min_started_at),
    max_started_at = GREATEST(stats_rollup_org_task.max_started_at, EXCLUDED.max_started_at);

  INSERT INTO stats_rollup_run_day (day, status, run_count)
  SELECT (started_at AT TIME ZONE 'UTC')::date, status, sum(delta)
  FROM run_rollup_deltas_batch GROUP BY 1, 2 ORDER BY 1, 2
  ON CONFLICT ON CONSTRAINT stats_rollup_run_day_key DO UPDATE SET
    run_count = stats_rollup_run_day.run_count + EXCLUDED.run_count;

  INSERT INTO stats_rollup_runs (feature_slug, workflow_slug, run_count)
  SELECT feature_slug, workflow_slug, sum(delta)
  FROM run_rollup_deltas_batch WHERE kind = 'run' GROUP BY 1, 2 ORDER BY 1, 2
  ON CONFLICT ON CONSTRAINT stats_rollup_runs_key
  DO UPDATE SET run_count = stats_rollup_runs.run_count + EXCLUDED.run_count;

  INSERT INTO stats_rollup_task_day (organization_id, campaign_id, feature_slug, service_name, task_name, day, brand_ids,
    run_count, committed_run_count, min_started_at, max_started_at)
  SELECT organization_id, campaign_id, feature_slug, service_name, task_name, (started_at AT TIME ZONE 'UTC')::date, brand_ids,
    sum(delta), 0, min(started_at), max(started_at)
  FROM run_rollup_deltas_batch WHERE kind = 'run' GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY 1, 2, 3, 4, 5, 6, 7
  ON CONFLICT ON CONSTRAINT stats_rollup_task_day_key DO UPDATE SET
    run_count      = stats_rollup_task_day.run_count + EXCLUDED.run_count,
    min_started_at = LEAST(stats_rollup_task_day.min_started_at, EXCLUDED.min_started_at),
    max_started_at = GREATEST(stats_rollup_task_day.max_started_at, EXCLUDED.max_started_at);

  DELETE FROM run_rollup_deltas_batch;
  RETURN n;
END;
$$;
