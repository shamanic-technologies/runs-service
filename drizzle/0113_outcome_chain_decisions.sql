-- SCRIPT-VALUE-RATING-1113-RUNS follow-up (features-service/brussels): (1) what each script decision cost, beside its
-- runs in script_chain_reach (incurred = actual + provisioned, billed gross and frozen net, the decision run's
-- subtree minus the subtrees of the script decisions nested under its own runs); (2) every decision's row key kept
-- per decision (script_chain_decisions), so a reported Unit resolves to exactly the group its run sits in.
-- New / tiny tables only: boot-window safe.
ALTER TABLE script_chain_reach ADD COLUMN IF NOT EXISTS cost_in_usd_cents numeric NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE script_chain_reach ADD COLUMN IF NOT EXISTS net_cost_in_usd_cents numeric NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS script_chain_decisions (
  decision_run_id uuid PRIMARY KEY,
  script_slug text NOT NULL,
  day date NOT NULL,
  brand_ids text[] NOT NULL,
  produced_outcomes text[] NOT NULL,
  reached_outcomes text[] NOT NULL,
  cost_in_usd_cents numeric NOT NULL,
  net_cost_in_usd_cents numeric NOT NULL,
  updated_at timestamptz NOT NULL
);
