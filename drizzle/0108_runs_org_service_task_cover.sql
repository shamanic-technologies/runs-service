-- DASH-SPEED-1110. GET /internal/runs/subtree-costs (features-service's Offer > Sourcing) reads every
-- lead-serve run of a brand: org + service + task + brand. idx_runs_org_service_task_status finds them,
-- but each matching run was then a heap fetch for brand_ids and the served columns: Doc Dinners (brand
-- 75d7e3e8, 112,718 runs) spent 115 s of a 145 s read on those heap pages and 500'd at the 280 s budget.
-- INCLUDE the read's columns: the roots come off the index alone.
--
-- BOOT-WINDOW SAFE: built out-of-band CONCURRENTLY on prod first, so this IF NOT EXISTS no-ops there
-- (0085 pattern); a fresh/test database builds it on an empty table.
CREATE INDEX IF NOT EXISTS idx_runs_org_service_task_cover
  ON runs (organization_id, service_name, task_name)
  INCLUDE (brand_ids, id, parent_run_id, audience_id, campaign_id, started_at);
