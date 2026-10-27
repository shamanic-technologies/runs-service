-- RUNS-LIST-TIMEOUT-1027. campaign-service's gate check asks, before every campaign run,
-- GET /v1/runs?serviceName=campaign-service&taskName=<campaign id>&status=running&limit=200
-- (org-scoped). The only index with a matching prefix was idx_runs_org_service
-- (organization_id, service_name): for the owner org that is 175k campaign-service runs, each
-- heap-fetched to test task_name and status, 15-64 s for an EMPTY answer, past the read pool's
-- 60 s statement timeout -> 500, and campaign 8d3d1ade failed 224 runs in a row (2026-10-22..27).
--
-- (organization_id, service_name, task_name, status), every column a KEY (no INCLUDE, no
-- started_at): btree deduplication folds the many identical keys, so the index stays small on a
-- near-full disk, and an equality on all four reaches exactly the matching runs. Not a partial
-- `WHERE status = 'running'`: the status arrives as a bound parameter, which a cached generic
-- plan cannot match to a partial predicate.
--
-- BOOT-WINDOW SAFE: built out-of-band CONCURRENTLY on prod first, so this IF NOT EXISTS no-ops
-- there (0027 / 0029 / 0036 / 0039 / 0040 pattern); a fresh/test database builds it on an empty table.
CREATE INDEX IF NOT EXISTS idx_runs_org_service_task_status
  ON runs (organization_id, service_name, task_name, status);
