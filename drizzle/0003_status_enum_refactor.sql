ALTER TABLE "runs_costs" ADD COLUMN "status" text DEFAULT 'actual' NOT NULL;--> statement-breakpoint
UPDATE "runs_costs" SET "status" = CASE WHEN "provisioned" = true THEN 'provisioned' ELSE 'actual' END;--> statement-breakpoint
ALTER TABLE "runs_costs" DROP COLUMN "provisioned";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_runs_costs_provisioned";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_costs_status" ON "runs_costs" USING btree ("run_id","status");
