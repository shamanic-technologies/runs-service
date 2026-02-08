ALTER TABLE "runs" ADD COLUMN "app_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "brand_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "campaign_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_app" ON "runs" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_brand" ON "runs" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_campaign" ON "runs" USING btree ("campaign_id");