-- OCC-READ-ANCHOR-SPEND-1025: each anchor's spend (rules 1-3: its own cost rows and
-- those of the descendants it carries) per (UTC cost day, cost org), stored by the
-- ledger refresher with the day it belongs to, so GET /internal/outcome-occurrences
-- prices an occurrence from stored rows instead of walking its run's whole subtree.
-- Live, the read walked every descendant with ~4 index probes each: a newsletter
-- run with 18,250 children (transactional-email-service mailing-list-release-newsletter,
-- 310ccff7) took > 30 s on the box's cold cache, so ANY read whose consumption
-- resolved to one of its 5,951 message_sent answered 500 on the statement timeout
-- (2026-10-25, instantly-service reply-judging run 2b19f41f).
--
-- cost_ledger_computed_days.anchor_spend: the day stored these rows (false = stored
-- before this migration: an anchor whose span touches that day stays live until the
-- refresher recomputes it, after every missing / stale day). Not part of a day's
-- completeness: every other read is unchanged.
--
-- BOOT-WINDOW SAFE: a new empty table, a defaulted column add (metadata only).

CREATE TABLE IF NOT EXISTS cost_anchor_spend_days (
  day date NOT NULL,
  allocation_version integer NOT NULL,
  anchor_id uuid NOT NULL,
  organization_id uuid,
  gross numeric NOT NULL,
  net numeric NOT NULL,
  vendor numeric NOT NULL,
  unpriced_gross numeric NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cost_anchor_spend_days_anchor ON cost_anchor_spend_days (anchor_id, allocation_version, day);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cost_anchor_spend_days_day ON cost_anchor_spend_days (day, allocation_version);
--> statement-breakpoint
ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS anchor_spend boolean NOT NULL DEFAULT false;
