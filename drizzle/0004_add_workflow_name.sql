ALTER TABLE "runs" ADD COLUMN "workflow_name" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_workflow_name" ON "runs" USING btree ("workflow_name");
