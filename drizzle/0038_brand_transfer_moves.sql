-- Ledger of what POST /internal/transfer-brand moved (one row per committed chunk).
--
-- A brand transfer moves HISTORY, not MONEY: the agency already paid for the
-- spend it moves to the client's new org, so billing-service must keep both
-- orgs' balances unchanged. It does that by offsetting exactly what this service
-- moved, which it cannot measure itself (brand-service fans the transfer out to
-- every service in parallel, so an org-total before/after read races the move).
--
-- Each row is written in the SAME transaction as the chunk of runs it describes,
-- so the ledger can never disagree with the move: a crash after a commit keeps
-- both, a rollback keeps neither. A re-run that moves nothing writes nothing,
-- which makes the SUM per (source org, source brand, target org) cumulative and
-- idempotent. Amounts are frozen at the move, never recomputed.
--
-- projected_* = platform actual + provisioned rows whose denormalized org moved
--               (what GET /internal/org-usage-total counts).
-- actual_*    = platform committed rows of runs settled (completed/failed) at the
--               move (what org_actual_totals / GET /internal/org-actual-total counts).

CREATE TABLE IF NOT EXISTS "brand_transfer_moves" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_org_id" uuid NOT NULL,
  "source_brand_id" text NOT NULL,
  "target_org_id" uuid NOT NULL,
  "target_brand_id" text,
  "runs_moved" integer NOT NULL,
  "costs_moved" integer NOT NULL,
  "events_moved" integer NOT NULL,
  "projected_gross_cents" numeric NOT NULL,
  "projected_net_cents" numeric NOT NULL,
  "actual_gross_cents" numeric NOT NULL,
  "actual_net_cents" numeric NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_brand_transfer_moves_key"
  ON "brand_transfer_moves" ("source_org_id", "source_brand_id", "target_org_id");
