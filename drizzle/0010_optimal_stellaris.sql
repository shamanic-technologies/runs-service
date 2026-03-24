ALTER TABLE "runs" ADD COLUMN "feature_slug" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_feature_slug" ON "runs" USING btree ("feature_slug");