-- COST-ACCOUNTING-1023: a run is a PRODUCTION ORDER. It may state the outcome
-- occurrences it PRODUCED and CONSUMED (POST /v1/runs/:id/outcomes,
-- POST /v1/platform-runs/:id/outcomes); runs-service then answers what each
-- produced occurrence cost to make (GET /internal/outcome-occurrences) and
-- proves, per org and per UTC day, that the cost spread on occurrences + the
-- spend of runs that produced none = the ledger (cost_ledger_days), and how
-- much spend states its outputs (outcome_coverage_days). See CLAUDE.md
-- "Outcome occurrences — the production-cost ledger".
--
-- Bronze -> silver like every other lifecycle: the handler appends ONE
-- `outcomes.declared` event per call (only the items not already recorded), the
-- trigger projects each item into run_outcomes. App code never writes silver.
--
-- BOOT-WINDOW SAFE. Four empty tables, one function, one trigger. No scan.

CREATE TABLE IF NOT EXISTS outcome_declaration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  source_service text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ode_run_occurred ON outcome_declaration_events (run_id, occurred_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS run_outcomes (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('produced','consumed')),
  outcome_key text NOT NULL,
  subject_service text NOT NULL,
  subject_id text NOT NULL,
  quantity numeric(20,6) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  declared_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One occurrence per (run, direction, outcome, subject): a replay is a no-op.
-- Leading run_id also serves "does this run produce anything?" (the anchor probe).
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_outcomes_occurrence
  ON run_outcomes (run_id, direction, outcome_key, subject_service, subject_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_run_outcomes_subject
  ON run_outcomes (subject_service, subject_id, outcome_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_run_outcomes_key_declared
  ON run_outcomes (outcome_key, declared_at);
--> statement-breakpoint
-- The refresher's "which stored days did a late declaration make stale?" probe.
CREATE INDEX IF NOT EXISTS idx_run_outcomes_declared ON run_outcomes (declared_at);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_outcome_declaration_to_silver() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type = 'outcomes.declared' THEN
    INSERT INTO run_outcomes (id, run_id, direction, outcome_key, subject_service, subject_id, quantity, declared_at)
    SELECT x.id, NEW.run_id, x.direction, x.outcome_key, x.subject_service, x.subject_id,
           COALESCE(x.quantity, 1), NEW.occurred_at
    FROM jsonb_to_recordset(NEW.payload->'items')
      AS x(id uuid, direction text, outcome_key text, subject_service text, subject_id text, quantity numeric)
    ON CONFLICT (run_id, direction, outcome_key, subject_service, subject_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_project_outcome_declaration ON outcome_declaration_events;
--> statement-breakpoint
CREATE TRIGGER trg_project_outcome_declaration
  AFTER INSERT ON outcome_declaration_events
  FOR EACH ROW EXECUTE FUNCTION project_outcome_declaration_to_silver();
--> statement-breakpoint
-- Per (UTC day of the cost row, org) and allocation version: the ledger (every
-- actual + refunded cost row of the day), the part spread on produced
-- occurrences (summed from the per-occurrence shares) and the part of runs that
-- produced none, on billed gross, frozen net and vendor actual (+ the billed
-- gross the vendor catalogue cannot price), and the reuse gain. Unconstrained
-- numeric: exact sums.
CREATE TABLE IF NOT EXISTS cost_ledger_days (
  day date NOT NULL,
  allocation_version integer NOT NULL,
  organization_id uuid,
  ledger_gross numeric NOT NULL,
  ledger_net numeric NOT NULL,
  ledger_vendor numeric NOT NULL,
  ledger_unpriced_gross numeric NOT NULL,
  allocated_gross numeric NOT NULL,
  allocated_net numeric NOT NULL,
  allocated_vendor numeric NOT NULL,
  allocated_unpriced_gross numeric NOT NULL,
  none_gross numeric NOT NULL,
  none_net numeric NOT NULL,
  none_vendor numeric NOT NULL,
  none_unpriced_gross numeric NOT NULL,
  -- STANDARD COST ON REUSE (owner 2026-10-23): a consumption of an occurrence
  -- another consumption already used is charged the occurrence's production cost
  -- again, with no new spend: that charge is the reuse gain of the day, booked on
  -- the consuming run's org and the UTC day of the consumption.
  reuse_gross numeric NOT NULL DEFAULT 0,
  reuse_net numeric NOT NULL DEFAULT 0,
  reuse_vendor numeric NOT NULL DEFAULT 0,
  reuse_unpriced_gross numeric NOT NULL DEFAULT 0,
  reuse_count bigint NOT NULL DEFAULT 0,
  -- Consumptions whose occurrence no run declared producing (provenance unknown).
  unknown_provenance_count bigint NOT NULL DEFAULT 0,
  cost_rows bigint NOT NULL,
  occurrences bigint NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_ledger_days_key UNIQUE NULLS NOT DISTINCT (day, allocation_version, organization_id)
);
--> statement-breakpoint
-- Per (UTC day, service, task of the run that spent): spend and the part of it
-- spread on a produced occurrence (its run, or its nearest ancestor, states outputs).
CREATE TABLE IF NOT EXISTS outcome_coverage_days (
  day date NOT NULL,
  allocation_version integer NOT NULL,
  service_name text NOT NULL,
  task_name text NOT NULL,
  spend_gross numeric NOT NULL,
  covered_gross numeric NOT NULL,
  spend_net numeric NOT NULL,
  covered_net numeric NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outcome_coverage_days_key PRIMARY KEY (day, allocation_version, service_name, task_name)
);
--> statement-breakpoint
-- Which days the refresher has computed (a day with no spend has no row in the
-- two tables above, and must still read as computed, not missing).
CREATE TABLE IF NOT EXISTS cost_ledger_computed_days (
  day date NOT NULL,
  allocation_version integer NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_ledger_computed_days_key PRIMARY KEY (day, allocation_version)
);
