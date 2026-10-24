-- LOSS-SHARE-STORED-1024: each occurrence's share of its loss pool (rule 4b), stored
-- by the ledger refresher with the day it belongs to, so GET /internal/outcome-occurrences
-- reads it by occurrence id. Live, the read re-ranked every produced occurrence of each
-- pool's day with one runs PK probe per row: 64k probes for 150 runs, 35 s at box load
-- ~50, a 500 on the 30 s statement timeout (2026-10-24).
--
-- cost_ledger_computed_days.loss_occurrences: the day stored these rows (false = stored
-- before this migration: the read stays live for that day, the refresher recomputes it
-- after every missing / stale day). Not part of a day's completeness: every other read
-- is unchanged.
--
-- BOOT-WINDOW SAFE: a new empty table, a defaulted column add (metadata only).

CREATE TABLE IF NOT EXISTS cost_loss_occurrence_days (
  day date NOT NULL,
  allocation_version integer NOT NULL,
  occurrence_id uuid NOT NULL,
  organization_id uuid,
  gross numeric NOT NULL,
  net numeric NOT NULL,
  vendor numeric NOT NULL,
  unpriced_gross numeric NOT NULL,
  PRIMARY KEY (allocation_version, occurrence_id, day)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cost_loss_occurrence_days_day ON cost_loss_occurrence_days (day, allocation_version);
--> statement-breakpoint
ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS loss_occurrences boolean NOT NULL DEFAULT false;
