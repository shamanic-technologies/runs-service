-- FACTORY-P4-PAGES: the brand ledger read (GET /internal/brands/:brandId/ledger) filters the stored days by
-- `brand_ids @> ARRAY[brand]`; with no index it scanned every allocation version's rows (493k, 17-38 s on the
-- loaded box, past the stats pool's 30 s timeout, 2026-10-29). A GIN on brand_ids serves the containment.
--
-- BOOT-WINDOW SAFE: built CONCURRENTLY out-of-band on prod first, so this no-ops there.
CREATE INDEX IF NOT EXISTS idx_outcome_cost_days_brand_ids ON outcome_cost_days USING gin (brand_ids);
