-- LEDGER-SIGNUP-UNITS-1110: a stale past day's Units (count rows) are brought current by the refresher before its
-- full recompute; `units_at` = the instant its count rows were last read (the full recompute sets it to computed_at).
-- The ledger read cache keys a day on computed_at AND units_at.
--
-- BOOT-WINDOW SAFE: a nullable column add (metadata only).
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS units_at timestamptz;
