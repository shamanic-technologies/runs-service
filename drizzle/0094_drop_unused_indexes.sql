-- BOX-DISK-1101. The box disk had ~24 days of runway (Postgres grows ~0.65 GB/day). These indexes
-- cost ~3.5 GB (3531 MB) and serve no read. Measured on prod 2026-11-02 (stats since the 2026-10-29 restart)
-- and checked against every query in src/, scripts/ and the SQL functions/triggers in drizzle/:
--   never scanned, no reader filters/joins/orders on their leading column(s) without another index:
--     runs.idx_runs_feature_brands (1175 MB), run_lifecycle_events.idx_rle_event_type (864 MB),
--     run_events.idx_run_events_service_created (512 MB, GET /v1/events?service= is org-scoped and
--     walks idx_run_events_created_at over a 30-day log), cost_lifecycle_events.idx_cle_run_occurred
--     (157 MB, no FK, no reader by run_id), runs.idx_runs_goal_org (100), runs.idx_runs_audience (86),
--     runs.idx_runs_brand_profile (79) (GET /v1/runs always filters on organization_id first; the stats
--     filters read COALESCE(rc.x, r.x), which no btree serves), runs_costs.idx_runs_costs_projected (47,
--     run_id lookups use idx_runs_costs_run_agg), runs_costs.idx_runs_costs_audience (32) / _goal (24) /
--     _brand_profile (24), run_lifecycle_events.idx_rle_idempotency (22, nothing reads it).
--   redundant, their columns are a leading prefix of a kept index on the same table:
--     runs.idx_runs_campaign (96) -> idx_runs_campaign_started; runs.idx_runs_feature_slug (93) ->
--     idx_runs_feature_org; runs.idx_runs_org_service (96) -> idx_runs_org_service_task_status;
--     runs_costs.idx_runs_costs_status (124) -> idx_runs_costs_run_agg (run_id, status, ...).
-- KEPT although never scanned: idx_runs_brand_ids (brand transfer + brand ledger `@>`/`&&`),
-- idx_run_campaign_entries_campaign_started (run-outcomes ?campaignId scope=entry, the table's only
-- campaign index), idx_runs_costs_org_no_campaign (org-no-campaign-total's partial-day slice).
--
-- BOOT-WINDOW SAFE. drizzle runs every pending migration in ONE transaction before listen(), so
-- CONCURRENTLY is not available. A DROP INDEX needs ACCESS EXCLUSIVE on its table; a long reader
-- left over from the previous container could hold it. Each DROP therefore waits at most 2 s per
-- try, retried until a 25 s budget (the deploy health window is 60 s) is spent. An index whose lock
-- never came is SKIPPED with a WARNING instead of failing the boot: a failed migration rolls the
-- deploy back and re-fails every 5-min tick (a runs-service outage each time), while a skipped index
-- only keeps its disk. A later migration re-running this DROP ... IF EXISTS removes it.
DO $$
DECLARE
  idx text;
  done boolean;
  prev_lock_timeout text := current_setting('lock_timeout');
  deadline timestamptz := clock_timestamp() + interval '25 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  FOREACH idx IN ARRAY ARRAY[
    'idx_rle_event_type', 'idx_rle_idempotency',
    'idx_cle_run_occurred',
    'idx_run_events_service_created',
    'idx_runs_costs_projected', 'idx_runs_costs_audience', 'idx_runs_costs_goal',
    'idx_runs_costs_brand_profile', 'idx_runs_costs_status',
    'idx_runs_feature_brands', 'idx_runs_goal_org', 'idx_runs_audience', 'idx_runs_brand_profile',
    'idx_runs_campaign', 'idx_runs_feature_slug', 'idx_runs_org_service'
  ] LOOP
    done := false;
    LOOP
      BEGIN
        EXECUTE format('DROP INDEX IF EXISTS %I', idx);
        done := true;
      EXCEPTION WHEN lock_not_available THEN
        NULL;
      END;
      EXIT WHEN done OR clock_timestamp() > deadline;
      PERFORM pg_sleep(0.5);
    END LOOP;
    IF NOT done THEN
      RAISE WARNING '[0094] % kept: its table stayed locked past the 25 s budget, drop it in a later migration', idx;
    END IF;
  END LOOP;
  PERFORM set_config('lock_timeout', prev_lock_timeout, true);
END $$;
