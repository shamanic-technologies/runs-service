-- Cost writes timed out (15 s) behind stats reads on 2026-10-03. Two database
-- halves of the fix; the third (a separate analytics connection pool) is in
-- src/db/index.ts.
--
-- 1. Covering index for the org-scoped brand reads of GET /v1/stats/costs
--    (`WHERE organization_id = $1 AND $2 = ANY(brand_ids) AND feature_slug IN (...)`,
--    grouped by campaign / workflow / audience). Before, each read bitmap-scanned
--    the org's whole feature history in the heap (335k runs, 53k heap blocks for
--    the busiest brand): 5-9 s per call with ~20 in flight. Index-only: 1.0 s.
--    Built here non-concurrent + IF NOT EXISTS for fresh/test databases; on prod
--    it was built out-of-band CONCURRENTLY first (45 s, 905 MB) so this no-ops
--    (migration 0027 / 0029 / 0030 / 0032 / 0036 pattern).
CREATE INDEX IF NOT EXISTS "idx_runs_org_feature_cover"
  ON "runs" ("organization_id", "feature_slug")
  INCLUDE ("started_at", "campaign_id", "workflow_slug", "brand_ids", "audience_id", "id");
--> statement-breakpoint

-- 2. Keep the visibility map fresh. Every stats read here leans on index-only
--    scans, which degrade to heap fetches once autovacuum falls behind. At the
--    default 20 % scale factor `runs` (4.6M rows) waits for ~930k dead rows: it had
--    not been vacuumed for six days and held 540k dead rows, and the per-day run
--    count fell back to a 7.4 s seq scan (3.4 s index-only after a manual VACUUM).
--    2 % = a vacuum every ~90k changed or inserted rows. Storage-parameter change:
--    SHARE UPDATE EXCLUSIVE lock, blocks no read or write, O(1).
ALTER TABLE "runs" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);
--> statement-breakpoint
ALTER TABLE "runs_costs" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);
