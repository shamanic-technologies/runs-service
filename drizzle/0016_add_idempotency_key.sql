-- Drop unused billing_transaction_id column (dead since 0015 rename, no client writes).
ALTER TABLE "runs_costs" DROP COLUMN IF EXISTS "billing_transaction_id";--> statement-breakpoint

-- Generic idempotency key on silver writes. Callers self-namespace to avoid global collisions on runs.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "runs_costs" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint

-- Partial unique index — global across all runs. Caller responsible for namespacing.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_runs_idempotency_key" ON "runs" USING btree ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint

-- Partial unique index — per-run for cost items. Two runs may share the same per-item key.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_runs_costs_idempotency_key" ON "runs_costs" USING btree ("run_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;
