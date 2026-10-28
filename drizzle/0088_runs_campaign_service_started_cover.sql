-- BOX-DB-LOAD-1027-RUNS. 0087's (campaign_id, service_name, started_at DESC, id DESC) serves the newest
-- runs of a campaign's service (3.5 ms instead of 2.9 s for status=completed), but campaign-service's
-- gate check and scheduler also ask for status=running, which matches almost nothing: walking the index
-- meant a heap fetch per campaign-service run of the campaign to read its status (11.4k for campaign
-- a2b35c84), so the planner kept the BitmapAnd with the org's 176k service runs: 6 s, 29 calls per 5 min
-- (2026-10-28). The same key INCLUDING status and organization_id filters on the index tuple itself
-- (index-only), so every status reads exactly its page.
--
-- BOOT-WINDOW SAFE: built CONCURRENTLY and the 0087 index dropped CONCURRENTLY out-of-band on prod first,
-- so both statements no-op there; a fresh/test database runs them on an empty table.
DROP INDEX IF EXISTS idx_runs_campaign_service_started;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_runs_campaign_service_started_cover
  ON runs (campaign_id, service_name, started_at DESC, id DESC) INCLUDE (status, organization_id);
