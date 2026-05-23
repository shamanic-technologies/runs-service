-- Phase 1 of B/S/G substrate (γ migration plan).
-- Append-only domain-event tables for the run + cost lifecycles.
-- Doctrine: Young (domain events, not property sourcing) + Kleppmann (log = source of truth) +
-- Richardson (current-state cache projection on silver via trigger, deferred to Phase 2).
--
-- This migration is ADDITIVE ONLY. No FK to runs/runs_costs — bronze must survive even if a
-- silver row is later cascade-deleted. Cross-reference via run_id / cost_id columns.
-- No triggers, no dual-write, no consumer reads yet. Substrate land first; wiring follows.

CREATE TABLE IF NOT EXISTS "run_lifecycle_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid NOT NULL,
  "event_type" text NOT NULL,                   -- 'run.created' | 'run.completed' | 'run.failed'
  "payload" jsonb NOT NULL,                     -- delta + reason; never the full aggregate
  "source_service" text,                        -- caller API key owner / x-service-name
  "identity" jsonb,                             -- {orgId,userId,brandIds,campaignId,workflowSlug,featureSlug}
  "idempotency_key" text,
  "correlation_id" text,                        -- 2026 ES best practice (request tracing)
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_rle_run_occurred"
  ON "run_lifecycle_events" ("run_id", "occurred_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_rle_event_type"
  ON "run_lifecycle_events" ("event_type", "occurred_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_rle_idempotency"
  ON "run_lifecycle_events" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cost_lifecycle_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "cost_id" uuid,                               -- nullable until silver row settled
  "run_id" uuid NOT NULL,
  "event_type" text NOT NULL,                   -- 'cost.added' | 'cost.materialized' | 'cost.cancelled'
  "payload" jsonb NOT NULL,                     -- {costName, quantity, unitCost, total, status, source} OR {from, to}
  "identity" jsonb,
  "idempotency_key" text,
  "correlation_id" text,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_cle_run_occurred"
  ON "cost_lifecycle_events" ("run_id", "occurred_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_cle_cost_occurred"
  ON "cost_lifecycle_events" ("cost_id", "occurred_at") WHERE "cost_id" IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_cle_event_type"
  ON "cost_lifecycle_events" ("event_type", "occurred_at");
