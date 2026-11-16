-- ONE-WRITER-N-MODELS-1116-RUNS: which script ASKED each script decision. asked_by_script_slug = the script slug
-- (`<outcome>/<dynasty>/v<version>`) of the script decision holding the PARENT run of this decision's root run; NULL =
-- nobody's script asked it (a campaign's own decision, or a parent run that works for no script).
-- outcome_chain_builds.asked_by = that build wrote it (the include=costNames read names the asker only once one has).
-- Tiny tables only: boot-window safe.
ALTER TABLE script_chain_decisions ADD COLUMN IF NOT EXISTS asked_by_script_slug text;
--> statement-breakpoint
ALTER TABLE outcome_chain_builds ADD COLUMN IF NOT EXISTS asked_by boolean NOT NULL DEFAULT false;
