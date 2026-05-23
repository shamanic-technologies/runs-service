-- Phase 6 of B/S/G substrate (γ migration plan).
-- Rename silver tables to *_old; create auto-updatable views with the original
-- names that pass through to the renamed tables.
--
-- Why view shim (not naked rename):
--   - Drizzle schema target stays `runs` / `runs_costs` — no code change.
--   - ~17 raw-SQL references in routes + ~9 in tests keep working as-is.
--   - Trigger function bodies (Phase 5) keep `INSERT INTO runs` / `UPDATE runs_costs`
--     SQL; auto-updatable views forward to the base table including ON CONFLICT.
--   - `\d+` in psql shows `runs` as VIEW (deprecated wrapper) and `runs_old` as
--     the live BASE TABLE — visible sunset signal as the user wanted.
--   - Gold views v_runs_with_descendants / v_run_cost_rollup / v_org_platform_spend
--     reference `runs` and `runs_costs` by OID, which PG auto-follows across renames.
--     They keep working with no change.
--
-- Idempotent: replays are safe (DO IF EXISTS / CREATE OR REPLACE).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'runs' AND table_type = 'BASE TABLE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'runs_old' AND table_type = 'BASE TABLE'
  ) THEN
    ALTER TABLE runs RENAME TO runs_old;
  END IF;
END $$;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'runs_costs' AND table_type = 'BASE TABLE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'runs_costs_old' AND table_type = 'BASE TABLE'
  ) THEN
    ALTER TABLE runs_costs RENAME TO runs_costs_old;
  END IF;
END $$;--> statement-breakpoint

-- Auto-updatable passthrough view. PG forwards INSERT/UPDATE/DELETE
-- (including ON CONFLICT) to runs_old because the view references exactly one
-- table with no aggregates, joins, DISTINCT, GROUP BY, or LIMIT.
CREATE OR REPLACE VIEW runs AS SELECT * FROM runs_old;--> statement-breakpoint
CREATE OR REPLACE VIEW runs_costs AS SELECT * FROM runs_costs_old;
