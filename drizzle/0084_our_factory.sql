-- OUR-FACTORY-OUTCOMES-1027 (owner 2026-10-27: « be as close as possible to industrial cost-accounting best
-- practice »; process costing: the equivalent units of a process are the units THAT process completed). A lead
-- state another factory produced (the client's CRM, team or site, or reached before our first touch) carries none
-- of our cost: lead-service states WHOSE WIN each reach was, stored here as served.
--   lead_state_reaches.caused_by_outreach: true = ours, false = another factory, null = no proof (not ours).
--   lead_state_reaches.cause_reason: lead-service's reason (our_outreach, before_first_delivery, ...).
--   cost_ledger_computed_days.our_factory: the day was computed counting only our reaches (else recomputed).
--
-- BOOT-WINDOW SAFE: nullable / defaulted column adds (metadata only).

ALTER TABLE lead_state_reaches ADD COLUMN IF NOT EXISTS caused_by_outreach boolean;
--> statement-breakpoint
ALTER TABLE lead_state_reaches ADD COLUMN IF NOT EXISTS cause_reason text;
--> statement-breakpoint
ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS our_factory boolean NOT NULL DEFAULT false;
