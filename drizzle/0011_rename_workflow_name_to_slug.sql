ALTER TABLE "runs" RENAME COLUMN "workflow_name" TO "workflow_slug";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_runs_workflow_name";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_workflow_slug" ON "runs" USING btree ("workflow_slug");
