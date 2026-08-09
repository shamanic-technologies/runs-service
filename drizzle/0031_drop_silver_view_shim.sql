-- Undo Phase 6 of the B/S/G substrate (migration 0021): drop the passthrough view
-- shims and give the canonical silver row tables back their plain names.
--
-- Why now: 0021 renamed the silver base tables to `runs_old` / `runs_costs_old`
-- and put auto-updatable views in front of them under the original names. That
-- suffix was a SUNSET SIGNAL for Phase 7 (drop the base tables once every read
-- came off the gold views). Phase 4 was reverted (`df9230e`) — the gold views
-- OOMed production and were dropped outright in migration 0026 — so Phase 7 is
-- unreachable and there is nothing left to sunset. The suffix is now permanent
-- naming that reads as an unfinished rename to anyone opening the schema.
--
-- Shape of the fix: the app, the routes' raw SQL, the Drizzle models, the tests
-- and BOTH projection trigger bodies all address these tables as `runs` /
-- `runs_costs` already — they were only ever pointed at the shim. Dropping the
-- shim and renaming the base table back means every one of those names keeps
-- resolving, to a BASE TABLE instead of a VIEW. No writer and no reader changes
-- behaviour; the silver projection triggers keep working because plpgsql resolves
-- `INSERT INTO runs_costs` at execution time and PG invalidates cached plans that
-- referenced the dropped view.
--
-- Everything attached to the base tables survives a rename untouched: the
-- generated columns (`is_platform_projected`, `is_platform_committed`), every
-- index from 0013/0017/0027/0029/0030, and the three foreign keys — none of whose
-- names carry the suffix (`runs_costs_run_id_runs_id_fk`, `runs_parent_run_id_runs_id_fk`,
-- `run_events_run_id_runs_id_fk`).
--
-- Boot-window safe: DROP VIEW + ALTER TABLE ... RENAME are catalog-only. They take
-- a brief ACCESS EXCLUSIVE lock and rewrite no heap, so this stays O(1) on a
-- multi-million-row ledger (unlike a backfill — CLAUDE.md "Boot-window hazards").
--
-- Idempotent: guarded so a replay, or a database that never went through 0021,
-- is a no-op.

DROP VIEW IF EXISTS "runs_costs";--> statement-breakpoint
DROP VIEW IF EXISTS "runs";--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'runs_old' AND table_type = 'BASE TABLE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'runs' AND table_type = 'BASE TABLE'
  ) THEN
    ALTER TABLE runs_old RENAME TO runs;
  END IF;
END $$;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'runs_costs_old' AND table_type = 'BASE TABLE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'runs_costs' AND table_type = 'BASE TABLE'
  ) THEN
    ALTER TABLE runs_costs_old RENAME TO runs_costs;
  END IF;
END $$;
