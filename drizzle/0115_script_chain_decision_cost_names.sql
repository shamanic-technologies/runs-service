-- SERVED-MODEL-1116-RUNS: which priced items (cost names) each script decision billed, so features-service can tell
-- which LLM actually made its Units (a fallback that served instead of the script's stated LLM is named, never the
-- intended one). cost_names = names billed on the decision's own work (its subtree minus the script decisions opened
-- under it, ACTUAL rows, from run_subtree_cost_items 0092); source_cost_names = the cost_names of the OTHER script
-- decisions whose standing Units this decision's runs consumed (one hop: the writing behind a send).
-- outcome_chain_builds.cost_names = that build wrote both arrays (the opt-in read refuses until one has).
-- Tiny tables only: boot-window safe.
ALTER TABLE script_chain_decisions ADD COLUMN IF NOT EXISTS cost_names text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE script_chain_decisions ADD COLUMN IF NOT EXISTS source_cost_names text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE outcome_chain_builds ADD COLUMN IF NOT EXISTS cost_names boolean NOT NULL DEFAULT false;
