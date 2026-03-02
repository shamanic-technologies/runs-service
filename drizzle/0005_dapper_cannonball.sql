ALTER TABLE "runs_costs" ADD COLUMN "cost_source" text NOT NULL DEFAULT 'platform';--> statement-breakpoint
ALTER TABLE "runs_costs" ALTER COLUMN "cost_source" DROP DEFAULT;