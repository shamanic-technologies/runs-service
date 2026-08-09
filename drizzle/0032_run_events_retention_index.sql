-- Serving index for the leaf-telemetry retention sweep.
--
-- `run_events` is the raw trace/telemetry log (a LEAF bronze table — it projects
-- to nothing and is read directly). It is the largest relation in this database:
-- 2.56M rows / 4.9 GB on production after 6.0M rows older than 30 days were
-- deleted BY HAND from outside the repo, and it re-accumulates ~2.6M rows a month.
-- Retention is now enforced in-service (`src/services/run-events-retention.ts`,
-- 30 days) instead of by an unversioned host cron.
--
-- The sweep selects expired ids by `created_at` and deletes them in chunks. The
-- three existing indexes are all prefixed by another column
-- (`run_id`/`campaign_id`/`service`), so none can range-scan `created_at` — without
-- this index every chunk seq-scans the whole 4.9 GB table. This is the
-- access-pattern index the leaf-log doctrine calls for (CLAUDE.md: serve a raw-row
-- log's reads with a btree on its access key, never a rollup).
--
-- The LIFECYCLE logs (`run_lifecycle_events`, `cost_lifecycle_events`) are the
-- source silver is projected from and are NEVER purged — they get no such index
-- and no sweep.
--
-- Built here non-concurrent + IF NOT EXISTS for fresh/test databases; on
-- prod/staging it is built out-of-band CONCURRENTLY first so this statement
-- no-ops (migration 0027 / 0029 / 0030 pattern — a non-concurrent boot-migrator
-- build would lock writes on a large table for the whole build).

CREATE INDEX IF NOT EXISTS "idx_run_events_created_at"
  ON "run_events" ("created_at");
