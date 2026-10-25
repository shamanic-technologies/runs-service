-- LEDGER-RESIDUAL-1025: the reconciliation names who OWES an undeclared spend.
-- outcome_cost_days 'none' rows named only the SPENDING run's service, so a
-- chat-service call made for crm-service's people.build read as chat-service's
-- gap ($15.45 of "chat-service" undeclared spend was other services' roots,
-- 2026-10-25). owner_service_name = the service of the run the spending run's
-- walk ENDED on (its top run, or the mark / anchor it stopped on).
-- cost_ledger_computed_days.owner_service = the day carries it (else recomputed).
-- idx_outcome_cost_days_kind_day: the reconciliation's per-kind reads.
--
-- BOOT-WINDOW SAFE: nullable / defaulted columns; one index on a ~300k-row table.

ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS owner_service_name text;
--> statement-breakpoint
ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS owner_service boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_outcome_cost_days_kind_day ON outcome_cost_days (allocation_version, kind, day);
