-- BOX-DB-LOAD-1027-RUNS. Two campaign reads filter on (campaign, service) and want the newest runs:
--   - GET /v1/runs?campaignIds=<family>&serviceName=campaign-service&limit=51 (features-service observedPicks):
--     the per-member LATERAL walked idx_runs_campaign_started and filtered service_name row by row (a
--     campaign's runs are 1/3 campaign-service, 1/3 workflow, 1/3 lead-service): 3.7 s per call.
--   - GET /v1/runs?campaignId=X&serviceName=campaign-service&status=completed&limit=N (campaign-service's
--     gate check): BitmapAnd of idx_runs_campaign + idx_runs_org_service (173k runs of the owner org), then
--     a heap fetch of every match and a top-N sort: 2.9 s for campaign a2b35c84 (9.9k matches) to keep 51.
-- Together ~75 s of DB time every 5 min on 2026-10-27. With (campaign_id, service_name, started_at DESC,
-- id DESC) both read exactly the page, newest first, and stop.
--
-- BOOT-WINDOW SAFE: built out-of-band CONCURRENTLY on prod first, so this IF NOT EXISTS no-ops there
-- (0027 / 0029 / 0036 / 0039 / 0040 / 0085 pattern); a fresh/test database builds it on an empty table.
CREATE INDEX IF NOT EXISTS idx_runs_campaign_service_started
  ON runs (campaign_id, service_name, started_at DESC, id DESC);
