-- LEDGER-OTHER-FACTORY-1107 (owner 2026-11-07: « ON VEUT LE TOTAL ET LES STATS PAR OUTCOME ... INDEPENDAMMENT
-- DES SOURCES »): a per-outcome figure is the scope's TOTAL Units, every source. A lead STATE reached by another
-- factory (the client's CRM, team or site, before our first touch: lead_state_reaches.caused_by_outreach false) or
-- with no proof of ours (null) is stored as its own kind, `produced_elsewhere`, one Unit per lead x brand x state on
-- its reach day, under `factory` ('another_factory' | 'no_proof'). It carries none of our cost and is in no unit
-- cost (IAS 2: our cost per outcome divides our own Units, `produced_count`), served in its own block.
--   cost_ledger_computed_days.other_factories: the day was computed with those rows (else recomputed).
--
-- BOOT-WINDOW SAFE: nullable / defaulted column adds (metadata only); the kind CHECK is re-added NOT VALID
-- (no scan of the stored rows, every one of which already satisfies it).

-- Each ALTER takes a brief ACCESS EXCLUSIVE lock: a refresher tick writing a day holds the table, so the wait is
-- bounded (a busy tick fails the boot, the deploy rolls back and the next one retries).
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS factory text;
--> statement-breakpoint
ALTER TABLE outcome_cost_days DROP CONSTRAINT IF EXISTS outcome_cost_days_kind_check;
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD CONSTRAINT outcome_cost_days_kind_check
  CHECK (kind IN ('produced_count','produced_cost','consumed','none','abnormal','parallel_cost','parallel_none','produced_elsewhere')) NOT VALID;
--> statement-breakpoint
ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS other_factories boolean NOT NULL DEFAULT false;
