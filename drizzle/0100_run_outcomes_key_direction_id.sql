-- SOCIAL-OUTCOMES-1107. GET /internal/outcome-occurrences?orgId&outcomeKey&direction pages ORDER BY id.
-- With no index carrying (outcome_key, direction) in id order, the planner walked run_outcomes_pkey
-- and filtered every row: features-service's newsletter page asks newsletter_email_sent CONSUMED for
-- the owner org, which matches NOTHING, so the walk read all 1.2M rows (1 s quiet, past the 30 s
-- stats timeout at box load 30-40 -> 500, 2026-11-07). This index reads exactly the key's rows in
-- id order (0.09 s for the same read).
--
-- BOOT-WINDOW SAFE: built out-of-band CONCURRENTLY on prod first (2026-11-07, 71 MB), so this
-- IF NOT EXISTS no-ops there; a fresh/test database builds it on an empty table.
CREATE INDEX IF NOT EXISTS idx_run_outcomes_key_direction_id
  ON run_outcomes (outcome_key, direction, id);
