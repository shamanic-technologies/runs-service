-- SEND-RUN-LATENCY-1111-COST: a cost write takes no shared rollup row lock.
--
-- One cost row fired ~20 AFTER triggers that upsert SHARED rollup rows: the org's lifetime totals
-- (org_projected_totals, org_actual_totals: one row per org), per org x day/hour groups, the fleet
-- day (stats_rollup_platform_cost_day), the feature x workflow group, and every ancestor's subtree
-- row (postmark: 1,245 sends of a day under 14 parent runs). An upsert holds its row until COMMIT,
-- so every cost write of an org (fleet-wide, for the day row) queued behind the previous writer's
-- remaining triggers and commit flush, and behind any multi-statement writer: prod cost write p99
-- 2.18 s, max 216 s (2026-10-28..11-11).
--
-- Rule (same family as 0109, run opens):
--   * DECISIONS stay in the write, taken under a PER-RUN lock (pg_advisory_xact_lock(52052, run), the
--     0052 audience key): which run-count group a row joins or leaves (0049/0052/0053/0096/0099
--     "other row of the run" checks) and whether a cost counts in org_actual_totals / the actual part
--     of org_no_campaign_days (the run's status). They read only that run and its cost rows, so a
--     per-run lock serializes every writer that can change them: the cost triggers take it first
--     (a_cost_rollups_lock_run), every run update / delete takes it first (a_runs_rollups_lock_run,
--     BEFORE), whichever session it is. The shared-row lock that did this job before
--     (org_actual_totals_lock, the key row upserted before the read) is no longer needed for it.
--   * EFFECTS are the 22 leaf helpers (X_add...): pure upserts adding their arguments (sums, min/max
--     widening, stale flag set). When the session sets `runs.defer_cost_rollups = on` (the service's
--     write pool does) a helper call is APPENDED to cost_rollup_deltas (insert only, conflicts with
--     nobody) instead; drain_cost_rollup_deltas() (in-process, ~1 s) applies the queued calls with the
--     original helper (now X_apply) and deletes them in the same transaction: nothing lost, nothing
--     twice. Additions commute with every synchronous write (run moves and deletes read the run's LIVE
--     cost rows, queued ones included, and the queued call carries the keys the row had when written),
--     so every rollup ends exactly where the synchronous triggers would have put it.
--   * Billing never reads a figure missing a committed cost: org-usage-total, org-actual-total and
--     org-no-campaign-total read row + the org's queued calls in ONE statement (the drain moves a call
--     from the queue to the row atomically). Every other rollup read lags the write by a tick or two.
--   * A run delete or re-parent applies the queue first (inside its own transaction, after its run
--     lock): the subtree triggers skip runs with no item row and delete the run's own rollup rows,
--     which a call still queued would otherwise re-create or miss.
-- Sessions that do not set it (scripts, tests, the kill switch COST_ROLLUP_DEFER=off) keep the
-- synchronous path byte for byte (wrapper -> X_apply, same arguments).

CREATE TABLE IF NOT EXISTS cost_rollup_deltas (
  id         bigserial PRIMARY KEY,
  fn         text NOT NULL,
  -- Set for the three billing totals only (org_projected_totals_add, org_actual_totals_add,
  -- org_no_campaign_days_add): their readers add the org's queued calls.
  org        uuid,
  day        date,
  a          jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
) WITH (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 5000, autovacuum_vacuum_cost_delay = 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cost_rollup_deltas_org ON cost_rollup_deltas (org, fn) WHERE org IS NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cost_rollups_deferred() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('runs.defer_cost_rollups', true), '') = 'on'
$$;
--> statement-breakpoint

-- jsonb array (or null) -> text[], order kept; '[]' -> '{}' (an empty brand set is its own group).
CREATE OR REPLACE FUNCTION cost_rollup_text_array(p jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NULL OR jsonb_typeof(p) = 'null' THEN NULL
    ELSE ARRAY(SELECT e FROM jsonb_array_elements_text(p) WITH ORDINALITY AS t(e, i) ORDER BY i) END
$$;
--> statement-breakpoint

ALTER FUNCTION org_projected_totals_add(uuid, bigint, numeric, numeric) RENAME TO org_projected_totals_add_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION org_projected_totals_add(p_org uuid, p_n bigint, p_gross numeric, p_net numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('org_projected_totals_add', p_org, NULL, jsonb_build_array(p_org, p_n, p_gross, p_net));
  ELSE
    PERFORM org_projected_totals_add_apply(p_org, p_n, p_gross, p_net);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION org_actual_totals_add(uuid, numeric, numeric) RENAME TO org_actual_totals_add_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION org_actual_totals_add(p_org uuid, p_gross numeric, p_net numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('org_actual_totals_add', p_org, NULL, jsonb_build_array(p_org, p_gross, p_net));
  ELSE
    PERFORM org_actual_totals_add_apply(p_org, p_gross, p_net);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION org_no_campaign_days_add(uuid, date, numeric, numeric, numeric, numeric) RENAME TO org_no_campaign_days_add_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION org_no_campaign_days_add(p_org uuid, p_day date, p_pg numeric, p_pn numeric, p_ag numeric, p_an numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('org_no_campaign_days_add', p_org, p_day, jsonb_build_array(p_org, p_day, p_pg, p_pn, p_ag, p_an));
  ELSE
    PERFORM org_no_campaign_days_add_apply(p_org, p_day, p_pg, p_pn, p_ag, p_an);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION run_subtree_cost_add(uuid[], bigint, numeric, numeric, numeric, numeric) RENAME TO run_subtree_cost_add_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION run_subtree_cost_add(p_chain uuid[], p_n bigint, p_ga numeric, p_gp numeric, p_na numeric, p_np numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('run_subtree_cost_add', NULL, NULL, jsonb_build_array(p_chain, p_n, p_ga, p_gp, p_na, p_np));
  ELSE
    PERFORM run_subtree_cost_add_apply(p_chain, p_n, p_ga, p_gp, p_na, p_np);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION run_subtree_cost_items_add(uuid[], text, numeric, timestamptz, bigint, numeric, numeric) RENAME TO run_subtree_cost_items_add_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION run_subtree_cost_items_add(p_chain uuid[], p_name text, p_unit numeric, p_hour timestamptz, p_n bigint, p_qty numeric, p_gross numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('run_subtree_cost_items_add', NULL, NULL, jsonb_build_array(p_chain, p_name, p_unit, p_hour, p_n, p_qty, p_gross));
  ELSE
    PERFORM run_subtree_cost_items_add_apply(p_chain, p_name, p_unit, p_hour, p_n, p_qty, p_gross);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_add_cost(text, text, text, text, bigint, numeric, numeric) RENAME TO stats_rollup_add_cost_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_add_cost(p_feature text, p_workflow text, p_source text, p_status text, p_count bigint, p_gross numeric, p_net numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_add_cost', NULL, NULL, jsonb_build_array(p_feature, p_workflow, p_source, p_status, p_count, p_gross, p_net));
  ELSE
    PERFORM stats_rollup_add_cost_apply(p_feature, p_workflow, p_source, p_status, p_count, p_gross, p_net);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_audience_add_cost(text, timestamptz, uuid, text[], text, text, text, text, bigint, numeric, numeric) RENAME TO stats_rollup_audience_add_cost_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_audience_add_cost(p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text, p_audience text, p_status text, p_count bigint, p_gross numeric, p_net numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_audience_add_cost', NULL, NULL, jsonb_build_array(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, p_audience, p_status, p_count, p_gross, p_net));
  ELSE
    PERFORM stats_rollup_audience_add_cost_apply(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, p_audience, p_status, p_count, p_gross, p_net);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_audience_add_runs(text, timestamptz, uuid, text[], text, text, text, bigint) RENAME TO stats_rollup_audience_add_runs_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_audience_add_runs(p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text, p_audience text, p_delta bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_audience_add_runs', NULL, NULL, jsonb_build_array(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, p_audience, p_delta));
  ELSE
    PERFORM stats_rollup_audience_add_runs_apply(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, p_audience, p_delta);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_campaign_add_cost(text, timestamptz, uuid, text[], text, text, text, text, bigint, numeric, numeric) RENAME TO stats_rollup_campaign_add_cost_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_campaign_add_cost(p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text, p_source text, p_status text, p_count bigint, p_gross numeric, p_net numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_campaign_add_cost', NULL, NULL, jsonb_build_array(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, p_source, p_status, p_count, p_gross, p_net));
  ELSE
    PERFORM stats_rollup_campaign_add_cost_apply(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, p_source, p_status, p_count, p_gross, p_net);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_campaign_cost_items_add(text, timestamptz, uuid, text[], text, text, text, text, text, numeric, timestamp, bigint, numeric, numeric, timestamptz, timestamptz) RENAME TO stats_rollup_campaign_cost_items_add_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_campaign_cost_items_add(p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text, p_source text, p_status text, p_cost_name text, p_unit numeric, p_cost_hour timestamp, p_n bigint, p_quantity numeric, p_gross numeric, p_min timestamptz, p_max timestamptz) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_campaign_cost_items_add', NULL, NULL, jsonb_build_array(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, p_source, p_status, p_cost_name, p_unit, p_cost_hour, p_n, p_quantity, p_gross, p_min, p_max));
  ELSE
    PERFORM stats_rollup_campaign_cost_items_add_apply(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, p_source, p_status, p_cost_name, p_unit, p_cost_hour, p_n, p_quantity, p_gross, p_min, p_max);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_cna_add(text, timestamptz, uuid, text[], text, text, text, text, bigint, text, bigint, numeric, numeric, numeric) RENAME TO stats_rollup_cna_add_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_cna_add(p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text, p_cost_name text, p_audience text, p_runs bigint, p_status text, p_count bigint, p_gross numeric, p_net numeric, p_quantity numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_cna_add', NULL, NULL, jsonb_build_array(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, p_cost_name, p_audience, p_runs, p_status, p_count, p_gross, p_net, p_quantity));
  ELSE
    PERFORM stats_rollup_cna_add_apply(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, p_cost_name, p_audience, p_runs, p_status, p_count, p_gross, p_net, p_quantity);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_consumption_add(uuid, text[], date, text, text, text, bigint, numeric, numeric, numeric) RENAME TO stats_rollup_consumption_add_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_consumption_add(p_org uuid, p_brands text[], p_day date, p_name text, p_source text, p_status text, p_count bigint, p_qty numeric, p_gross numeric, p_net numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_consumption_add', NULL, NULL, jsonb_build_array(p_org, p_brands, p_day, p_name, p_source, p_status, p_count, p_qty, p_gross, p_net));
  ELSE
    PERFORM stats_rollup_consumption_add_apply(p_org, p_brands, p_day, p_name, p_source, p_status, p_count, p_qty, p_gross, p_net);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_cost_day_add(uuid, text, numeric, text, text, timestamptz, bigint, numeric, numeric, numeric) RENAME TO stats_rollup_cost_day_add_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_cost_day_add(p_org uuid, p_name text, p_unit numeric, p_status text, p_source text, p_created timestamptz, p_sign bigint, p_qty numeric, p_gross numeric, p_net numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_cost_day_add', NULL, NULL, jsonb_build_array(p_org, p_name, p_unit, p_status, p_source, p_created, p_sign, p_qty, p_gross, p_net));
  ELSE
    PERFORM stats_rollup_cost_day_add_apply(p_org, p_name, p_unit, p_status, p_source, p_created, p_sign, p_qty, p_gross, p_net);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_cost_name_add(text, timestamptz, uuid, text[], text, text, text, bigint, text, bigint, numeric, numeric, numeric) RENAME TO stats_rollup_cost_name_add_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_cost_name_add(p_campaign text, p_started timestamptz, p_org uuid, p_brands text[], p_feature text, p_workflow text, p_cost_name text, p_runs bigint, p_status text, p_count bigint, p_gross numeric, p_net numeric, p_quantity numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_cost_name_add', NULL, NULL, jsonb_build_array(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, p_cost_name, p_runs, p_status, p_count, p_gross, p_net, p_quantity));
  ELSE
    PERFORM stats_rollup_cost_name_add_apply(p_campaign, p_started, p_org, p_brands, p_feature, p_workflow, p_cost_name, p_runs, p_status, p_count, p_gross, p_net, p_quantity);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_no_campaign_day_add(uuid, boolean, timestamptz, text, boolean, uuid, bigint, numeric, numeric) RENAME TO stats_rollup_no_campaign_day_add_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_no_campaign_day_add(p_org uuid, p_projected boolean, p_created timestamptz, p_name text, p_has boolean, p_origin uuid, p_sign bigint, p_gross numeric, p_net numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_no_campaign_day_add', NULL, NULL, jsonb_build_array(p_org, p_projected, p_created, p_name, p_has, p_origin, p_sign, p_gross, p_net));
  ELSE
    PERFORM stats_rollup_no_campaign_day_add_apply(p_org, p_projected, p_created, p_name, p_has, p_origin, p_sign, p_gross, p_net);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_org_hour_add_cost(uuid, text[], text, timestamptz, text, numeric, numeric) RENAME TO stats_rollup_org_hour_add_cost_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_org_hour_add_cost(p_org uuid, p_brands text[], p_campaign text, p_started timestamptz, p_status text, p_gross numeric, p_net numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_org_hour_add_cost', NULL, NULL, jsonb_build_array(p_org, p_brands, p_campaign, p_started, p_status, p_gross, p_net));
  ELSE
    PERFORM stats_rollup_org_hour_add_cost_apply(p_org, p_brands, p_campaign, p_started, p_status, p_gross, p_net);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_org_task_add_cost(uuid, text, text, text, timestamptz, text, bigint, numeric, numeric) RENAME TO stats_rollup_org_task_add_cost_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_org_task_add_cost(p_org uuid, p_service text, p_task text, p_campaign text, p_started timestamptz, p_status text, p_count bigint, p_gross numeric, p_net numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_org_task_add_cost', NULL, NULL, jsonb_build_array(p_org, p_service, p_task, p_campaign, p_started, p_status, p_count, p_gross, p_net));
  ELSE
    PERFORM stats_rollup_org_task_add_cost_apply(p_org, p_service, p_task, p_campaign, p_started, p_status, p_count, p_gross, p_net);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_platform_cost_day_add(timestamptz, bigint, numeric) RENAME TO stats_rollup_platform_cost_day_add_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_platform_cost_day_add(p_run_started timestamptz, p_n bigint, p_gross numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_platform_cost_day_add', NULL, NULL, jsonb_build_array(p_run_started, p_n, p_gross));
  ELSE
    PERFORM stats_rollup_platform_cost_day_add_apply(p_run_started, p_n, p_gross);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_root_cost_add(uuid, bigint, numeric) RENAME TO stats_rollup_root_cost_add_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_root_cost_add(p_root uuid, p_n bigint, p_gross numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_root_cost_add', NULL, NULL, jsonb_build_array(p_root, p_n, p_gross));
  ELSE
    PERFORM stats_rollup_root_cost_add_apply(p_root, p_n, p_gross);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_task_day_add_cost(uuid, text, text, text, text, text[], timestamptz, text, bigint, numeric, numeric) RENAME TO stats_rollup_task_day_add_cost_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_task_day_add_cost(p_org uuid, p_campaign text, p_feature text, p_service text, p_task text, p_brands text[], p_started timestamptz, p_status text, p_count bigint, p_gross numeric, p_net numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_task_day_add_cost', NULL, NULL, jsonb_build_array(p_org, p_campaign, p_feature, p_service, p_task, p_brands, p_started, p_status, p_count, p_gross, p_net));
  ELSE
    PERFORM stats_rollup_task_day_add_cost_apply(p_org, p_campaign, p_feature, p_service, p_task, p_brands, p_started, p_status, p_count, p_gross, p_net);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_task_day_add_runs(uuid, text, text, text, text, text[], timestamptz, bigint, bigint) RENAME TO stats_rollup_task_day_add_runs_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_task_day_add_runs(p_org uuid, p_campaign text, p_feature text, p_service text, p_task text, p_brands text[], p_started timestamptz, p_delta bigint, p_committed bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_task_day_add_runs', NULL, NULL, jsonb_build_array(p_org, p_campaign, p_feature, p_service, p_task, p_brands, p_started, p_delta, p_committed));
  ELSE
    PERFORM stats_rollup_task_day_add_runs_apply(p_org, p_campaign, p_feature, p_service, p_task, p_brands, p_started, p_delta, p_committed);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION stats_rollup_task_units_add(timestamptz, uuid, text, text, text, text, text, bigint, bigint, numeric, numeric, numeric) RENAME TO stats_rollup_task_units_add_apply;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_task_units_add(p_started timestamptz, p_org uuid, p_service text, p_task text, p_parent_service text, p_cost_name text, p_cost_source text, p_runs bigint, p_n bigint, p_quantity numeric, p_gross numeric, p_net numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    INSERT INTO cost_rollup_deltas (fn, org, day, a) VALUES ('stats_rollup_task_units_add', NULL, NULL, jsonb_build_array(p_started, p_org, p_service, p_task, p_parent_service, p_cost_name, p_cost_source, p_runs, p_n, p_quantity, p_gross, p_net));
  ELSE
    PERFORM stats_rollup_task_units_add_apply(p_started, p_org, p_service, p_task, p_parent_service, p_cost_name, p_cost_source, p_runs, p_n, p_quantity, p_gross, p_net);
  END IF;
END;
$$;
--> statement-breakpoint

-- The org row lock stays for synchronous sessions; a deferring session does not touch the org's
-- shared row (its decision is serialized by the per-run lock, its effect is queued).
CREATE OR REPLACE FUNCTION org_actual_totals_lock(p_org uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cost_rollups_deferred() THEN
    RETURN;
  END IF;
  INSERT INTO org_actual_totals (organization_id, total_cost_in_usd_cents, net_cost_in_usd_cents)
  VALUES (p_org, 0, 0)
  ON CONFLICT (organization_id) DO NOTHING;
  PERFORM 1 FROM org_actual_totals WHERE organization_id = p_org FOR UPDATE;
END;
$$;
--> statement-breakpoint

-- Apply queued helper calls, oldest first, at most p_limit (NULL = all).
--  - One drain at a time (advisory lock); deletes what it applies in the same transaction.
--  - Runs the helpers synchronously whatever the session (runs.defer_cost_rollups off for the
--    transaction, restored after: a flush inside a writer's transaction keeps the writer's mode).
--  - p_yield: lock_timeout 800 ms, under the 1 s deadlock_timeout, so the in-process drain gives up
--    first in a cycle with a synchronous writer (its calls wait for the next tick). A flush inside a
--    writer (run delete / re-parent, rebuild) passes false.
CREATE OR REPLACE FUNCTION drain_cost_rollup_deltas(p_limit integer, p_yield boolean DEFAULT true) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  n integer := 0;
  v_prev text := current_setting('runs.defer_cost_rollups', true);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cost_rollup_deltas_drain'));
  IF p_yield THEN
    PERFORM set_config('lock_timeout', '800ms', true);
  END IF;
  PERFORM set_config('runs.defer_cost_rollups', 'off', true);
  FOR r IN
    DELETE FROM cost_rollup_deltas
    WHERE id IN (SELECT id FROM cost_rollup_deltas ORDER BY id LIMIT p_limit)
    RETURNING fn, a
  LOOP
    n := n + 1;
    CASE r.fn
      WHEN 'org_projected_totals_add' THEN
        PERFORM org_projected_totals_add_apply((r.a->>0)::uuid, (r.a->>1)::bigint, (r.a->>2)::numeric, (r.a->>3)::numeric);
      WHEN 'org_actual_totals_add' THEN
        PERFORM org_actual_totals_lock((r.a->>0)::uuid);
        PERFORM org_actual_totals_add_apply((r.a->>0)::uuid, (r.a->>1)::numeric, (r.a->>2)::numeric);
      WHEN 'org_no_campaign_days_add' THEN
        PERFORM org_no_campaign_days_add_apply((r.a->>0)::uuid, (r.a->>1)::date, (r.a->>2)::numeric, (r.a->>3)::numeric, (r.a->>4)::numeric, (r.a->>5)::numeric);
      WHEN 'run_subtree_cost_add' THEN
        PERFORM run_subtree_cost_add_apply(cost_rollup_text_array(r.a->0)::uuid[], (r.a->>1)::bigint, (r.a->>2)::numeric, (r.a->>3)::numeric, (r.a->>4)::numeric, (r.a->>5)::numeric);
      WHEN 'run_subtree_cost_items_add' THEN
        PERFORM run_subtree_cost_items_add_apply(cost_rollup_text_array(r.a->0)::uuid[], (r.a->>1)::text, (r.a->>2)::numeric, (r.a->>3)::timestamptz, (r.a->>4)::bigint, (r.a->>5)::numeric, (r.a->>6)::numeric);
      WHEN 'stats_rollup_add_cost' THEN
        PERFORM stats_rollup_add_cost_apply((r.a->>0)::text, (r.a->>1)::text, (r.a->>2)::text, (r.a->>3)::text, (r.a->>4)::bigint, (r.a->>5)::numeric, (r.a->>6)::numeric);
      WHEN 'stats_rollup_audience_add_cost' THEN
        PERFORM stats_rollup_audience_add_cost_apply((r.a->>0)::text, (r.a->>1)::timestamptz, (r.a->>2)::uuid, cost_rollup_text_array(r.a->3), (r.a->>4)::text, (r.a->>5)::text, (r.a->>6)::text, (r.a->>7)::text, (r.a->>8)::bigint, (r.a->>9)::numeric, (r.a->>10)::numeric);
      WHEN 'stats_rollup_audience_add_runs' THEN
        PERFORM stats_rollup_audience_add_runs_apply((r.a->>0)::text, (r.a->>1)::timestamptz, (r.a->>2)::uuid, cost_rollup_text_array(r.a->3), (r.a->>4)::text, (r.a->>5)::text, (r.a->>6)::text, (r.a->>7)::bigint);
      WHEN 'stats_rollup_campaign_add_cost' THEN
        PERFORM stats_rollup_campaign_add_cost_apply((r.a->>0)::text, (r.a->>1)::timestamptz, (r.a->>2)::uuid, cost_rollup_text_array(r.a->3), (r.a->>4)::text, (r.a->>5)::text, (r.a->>6)::text, (r.a->>7)::text, (r.a->>8)::bigint, (r.a->>9)::numeric, (r.a->>10)::numeric);
      WHEN 'stats_rollup_campaign_cost_items_add' THEN
        PERFORM stats_rollup_campaign_cost_items_add_apply((r.a->>0)::text, (r.a->>1)::timestamptz, (r.a->>2)::uuid, cost_rollup_text_array(r.a->3), (r.a->>4)::text, (r.a->>5)::text, (r.a->>6)::text, (r.a->>7)::text, (r.a->>8)::text, (r.a->>9)::numeric, (r.a->>10)::timestamp, (r.a->>11)::bigint, (r.a->>12)::numeric, (r.a->>13)::numeric, (r.a->>14)::timestamptz, (r.a->>15)::timestamptz);
      WHEN 'stats_rollup_cna_add' THEN
        PERFORM stats_rollup_cna_add_apply((r.a->>0)::text, (r.a->>1)::timestamptz, (r.a->>2)::uuid, cost_rollup_text_array(r.a->3), (r.a->>4)::text, (r.a->>5)::text, (r.a->>6)::text, (r.a->>7)::text, (r.a->>8)::bigint, (r.a->>9)::text, (r.a->>10)::bigint, (r.a->>11)::numeric, (r.a->>12)::numeric, (r.a->>13)::numeric);
      WHEN 'stats_rollup_consumption_add' THEN
        PERFORM stats_rollup_consumption_add_apply((r.a->>0)::uuid, cost_rollup_text_array(r.a->1), (r.a->>2)::date, (r.a->>3)::text, (r.a->>4)::text, (r.a->>5)::text, (r.a->>6)::bigint, (r.a->>7)::numeric, (r.a->>8)::numeric, (r.a->>9)::numeric);
      WHEN 'stats_rollup_cost_day_add' THEN
        PERFORM stats_rollup_cost_day_add_apply((r.a->>0)::uuid, (r.a->>1)::text, (r.a->>2)::numeric, (r.a->>3)::text, (r.a->>4)::text, (r.a->>5)::timestamptz, (r.a->>6)::bigint, (r.a->>7)::numeric, (r.a->>8)::numeric, (r.a->>9)::numeric);
      WHEN 'stats_rollup_cost_name_add' THEN
        PERFORM stats_rollup_cost_name_add_apply((r.a->>0)::text, (r.a->>1)::timestamptz, (r.a->>2)::uuid, cost_rollup_text_array(r.a->3), (r.a->>4)::text, (r.a->>5)::text, (r.a->>6)::text, (r.a->>7)::bigint, (r.a->>8)::text, (r.a->>9)::bigint, (r.a->>10)::numeric, (r.a->>11)::numeric, (r.a->>12)::numeric);
      WHEN 'stats_rollup_no_campaign_day_add' THEN
        PERFORM stats_rollup_no_campaign_day_add_apply((r.a->>0)::uuid, (r.a->>1)::boolean, (r.a->>2)::timestamptz, (r.a->>3)::text, (r.a->>4)::boolean, (r.a->>5)::uuid, (r.a->>6)::bigint, (r.a->>7)::numeric, (r.a->>8)::numeric);
      WHEN 'stats_rollup_org_hour_add_cost' THEN
        PERFORM stats_rollup_org_hour_add_cost_apply((r.a->>0)::uuid, cost_rollup_text_array(r.a->1), (r.a->>2)::text, (r.a->>3)::timestamptz, (r.a->>4)::text, (r.a->>5)::numeric, (r.a->>6)::numeric);
      WHEN 'stats_rollup_org_task_add_cost' THEN
        PERFORM stats_rollup_org_task_add_cost_apply((r.a->>0)::uuid, (r.a->>1)::text, (r.a->>2)::text, (r.a->>3)::text, (r.a->>4)::timestamptz, (r.a->>5)::text, (r.a->>6)::bigint, (r.a->>7)::numeric, (r.a->>8)::numeric);
      WHEN 'stats_rollup_platform_cost_day_add' THEN
        PERFORM stats_rollup_platform_cost_day_add_apply((r.a->>0)::timestamptz, (r.a->>1)::bigint, (r.a->>2)::numeric);
      WHEN 'stats_rollup_root_cost_add' THEN
        PERFORM stats_rollup_root_cost_add_apply((r.a->>0)::uuid, (r.a->>1)::bigint, (r.a->>2)::numeric);
      WHEN 'stats_rollup_task_day_add_cost' THEN
        PERFORM stats_rollup_task_day_add_cost_apply((r.a->>0)::uuid, (r.a->>1)::text, (r.a->>2)::text, (r.a->>3)::text, (r.a->>4)::text, cost_rollup_text_array(r.a->5), (r.a->>6)::timestamptz, (r.a->>7)::text, (r.a->>8)::bigint, (r.a->>9)::numeric, (r.a->>10)::numeric);
      WHEN 'stats_rollup_task_day_add_runs' THEN
        PERFORM stats_rollup_task_day_add_runs_apply((r.a->>0)::uuid, (r.a->>1)::text, (r.a->>2)::text, (r.a->>3)::text, (r.a->>4)::text, cost_rollup_text_array(r.a->5), (r.a->>6)::timestamptz, (r.a->>7)::bigint, (r.a->>8)::bigint);
      WHEN 'stats_rollup_task_units_add' THEN
        PERFORM stats_rollup_task_units_add_apply((r.a->>0)::timestamptz, (r.a->>1)::uuid, (r.a->>2)::text, (r.a->>3)::text, (r.a->>4)::text, (r.a->>5)::text, (r.a->>6)::text, (r.a->>7)::bigint, (r.a->>8)::bigint, (r.a->>9)::numeric, (r.a->>10)::numeric, (r.a->>11)::numeric);
    END CASE;
  END LOOP;
  PERFORM set_config('runs.defer_cost_rollups', coalesce(v_prev, ''), true);
  RETURN n;
END;
$$;
--> statement-breakpoint

-- Per-run lock first, for every cost write (fires after the FK check, before every rollup trigger:
-- AFTER triggers fire in name order, 'RI_...' < 'a_...' < 'org_...' / 'run_...' / 'stats_...').
CREATE OR REPLACE FUNCTION cost_rollups_lock_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.run_id IS DISTINCT FROM OLD.run_id THEN
    PERFORM pg_advisory_xact_lock(52052, hashtext(LEAST(OLD.run_id, NEW.run_id)::text));
    PERFORM pg_advisory_xact_lock(52052, hashtext(GREATEST(OLD.run_id, NEW.run_id)::text));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM pg_advisory_xact_lock(52052, hashtext(OLD.run_id::text));
  ELSE
    PERFORM pg_advisory_xact_lock(52052, hashtext(NEW.run_id::text));
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS a_cost_rollups_lock_run ON runs_costs;
--> statement-breakpoint
CREATE TRIGGER a_cost_rollups_lock_run AFTER INSERT OR UPDATE OR DELETE ON runs_costs
  FOR EACH ROW EXECUTE FUNCTION cost_rollups_lock_run();
--> statement-breakpoint

-- Per-run lock first for every run update / delete (BEFORE: ahead of the BEFORE DELETE rollup moves
-- and of every AFTER UPDATE one), then a delete or re-parent applies the queued calls.
CREATE OR REPLACE FUNCTION runs_rollups_lock_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(52052, hashtext(OLD.id::text));
  IF (TG_OP = 'DELETE' OR NEW.parent_run_id IS DISTINCT FROM OLD.parent_run_id)
     AND EXISTS (SELECT 1 FROM cost_rollup_deltas) THEN
    PERFORM drain_cost_rollup_deltas(NULL, false);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS a_runs_rollups_lock_run ON runs;
--> statement-breakpoint
CREATE TRIGGER a_runs_rollups_lock_run BEFORE UPDATE OR DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION runs_rollups_lock_run();
