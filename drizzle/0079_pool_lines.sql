-- LEDGER-RESIDUAL-1025: a PRODUCTION LINE is an (org, pool key) that has produced
-- at least one occurrence. Spend of a run that kept nothing, on a line that has
-- produced on or before that day but has no unit that day, is unpooled LOSS (a
-- known line idling), never "undeclared" (which stays for spend no line ever
-- produced from: a producer that has not declared). crm-service's registry Jev
-- that identified no new lead (120 leads of 2,133 judged threads) read
-- undeclared on every zero-unit org-day (2026-10-25).
--
-- pool_lines: first produced declaration per (unit run's org, pool key), kept by
-- a trigger on run_outcomes; history filled once by the refresher in the
-- background (27 s, never at boot), stamped in stats_rollups ('pool_lines').
-- outcome_cost_days.loss_line: the 'none' row's spend sits on such a line that day.
--
-- BOOT-WINDOW SAFE: an empty table, a trigger, nullable / defaulted columns.

CREATE TABLE IF NOT EXISTS pool_lines (
  organization_id uuid,
  pool_key text NOT NULL,
  first_declared_at timestamptz NOT NULL,
  CONSTRAINT pool_lines_key UNIQUE NULLS NOT DISTINCT (organization_id, pool_key)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pool_lines_on_produced() RETURNS trigger AS $$
BEGIN
  IF NEW.direction = 'produced' THEN
    INSERT INTO pool_lines (organization_id, pool_key, first_declared_at)
    SELECT r.organization_id, COALESCE('workflow:' || r.workflow_slug, 'task:' || r.service_name || '/' || r.task_name), NEW.declared_at
    FROM runs r WHERE r.id = NEW.run_id
    ON CONFLICT ON CONSTRAINT pool_lines_key DO UPDATE SET first_declared_at = LEAST(pool_lines.first_declared_at, EXCLUDED.first_declared_at)
    WHERE EXCLUDED.first_declared_at < pool_lines.first_declared_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_pool_lines_on_produced ON run_outcomes;
--> statement-breakpoint
CREATE TRIGGER trg_pool_lines_on_produced AFTER INSERT OR UPDATE OF declared_at ON run_outcomes
FOR EACH ROW EXECUTE FUNCTION pool_lines_on_produced();
--> statement-breakpoint
ALTER TABLE outcome_cost_days ADD COLUMN IF NOT EXISTS loss_line boolean;
--> statement-breakpoint
ALTER TABLE cost_ledger_computed_days ADD COLUMN IF NOT EXISTS loss_lines boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- A database with no produced occurrence yet (fresh, tests) has nothing to fill: stamp it now.
INSERT INTO stats_rollups (name, ready_at)
SELECT 'pool_lines', now() WHERE NOT EXISTS (SELECT 1 FROM run_outcomes WHERE direction = 'produced')
ON CONFLICT (name) DO NOTHING;
