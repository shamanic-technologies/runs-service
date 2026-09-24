-- Serving index for GET /v1/runs?campaignIds=<a,b,c>&limit=N.
--
-- A campaign as the customer knows it is often many stored campaign rows
-- (campaign-service keeps every superseded row; one real campaign has 47). A
-- consumer asking "which runs happened for this campaign" used to call once per
-- row. The list filter answers the whole family in one request by walking each
-- member's newest runs on this index (LATERAL, at most limit+offset rows per
-- member) and keeping the global newest N.
--
-- Without it there is no good plan: `campaign_id = ANY(...) ORDER BY started_at
-- DESC LIMIT N` either top-N-sorts every run of the family (58k runs, 1.7s on the
-- 47-row campaign) or walks idx_runs_started_status backwards until N matches
-- turn up (4.1s for a family whose runs are three months old).
--
-- Built here non-concurrent + IF NOT EXISTS for fresh/test databases; on
-- prod it was built out-of-band CONCURRENTLY first (21.5s) so this statement
-- no-ops (migration 0027 / 0029 / 0030 / 0032 pattern).

CREATE INDEX IF NOT EXISTS "idx_runs_campaign_started"
  ON "runs" ("campaign_id", "started_at" DESC);
