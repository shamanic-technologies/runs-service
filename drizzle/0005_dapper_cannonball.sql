ALTER TABLE "runs_costs" ADD COLUMN "cost_bearer" text NOT NULL DEFAULT 'platform';--> statement-breakpoint
ALTER TABLE "runs_costs" ALTER COLUMN "cost_bearer" DROP DEFAULT;