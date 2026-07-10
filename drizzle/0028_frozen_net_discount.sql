-- Freeze the org usage discount on every cost row at write time.
--
-- Product decision: the org's usage-discount percentage (owned by
-- billing-service) is captured when the cost is written, so:
--   (a) downstream readers (billing balance, displayed stats) read the gross OR
--       the net amount with zero recomputation, and
--   (b) a later change to the org's discount is NON-RETROACTIVE — previously
--       written rows keep the net that was actually charged.
--
-- runs-service is the cost ledger, so the freeze lives here. Two nullable
-- columns are added to the `runs_costs_old` base table:
--   - net_cost_in_usd_cents : gross reduced by the frozen discount. NULL for
--     historical rows (predate the feature) → readers COALESCE to gross, which
--     is the correct semantic (no discount existed then, so net == gross).
--   - usage_discount_pct     : the frozen discount fraction in [0,1] (provenance).
--     NULL when no discount was applied.
--
-- Both columns are NULLABLE and NOT backfilled here: a full-table UPDATE on the
-- multi-million-row ledger would block boot (Railway ECONNREFUSED) — see
-- CLAUDE.md "Boot-window hazards". Reads COALESCE(net, total) so historical rows
-- return net == gross with zero regression.
--
-- Live Drizzle table names `runs` / `runs_costs` are auto-updatable passthrough
-- VIEWS over `runs_old` / `runs_costs_old` (migration 0021). Add the columns to
-- the base table, then CREATE OR REPLACE VIEW to append them to the shim
-- (append is auto-updatable-safe; see CLAUDE.md "Add a column" + migration 0024).

ALTER TABLE "runs_costs_old" ADD COLUMN IF NOT EXISTS "net_cost_in_usd_cents" numeric(16, 10);--> statement-breakpoint
ALTER TABLE "runs_costs_old" ADD COLUMN IF NOT EXISTS "usage_discount_pct" numeric(9, 8);--> statement-breakpoint

CREATE OR REPLACE VIEW "runs_costs" AS SELECT * FROM "runs_costs_old";--> statement-breakpoint

-- Re-teach the bronze->silver cost projection trigger to materialize the frozen
-- net + discount from the `cost.added` payload. COALESCE net → gross so a
-- pre-feature bronze event (no `netCostInUsdCents` key) still projects correctly
-- on replay (net == gross when no discount was frozen). The run projection
-- function is unchanged from migration 0025 and is not redefined here.

CREATE OR REPLACE FUNCTION project_cost_lifecycle_to_silver() RETURNS trigger AS $$
BEGIN
  -- Trigger requires NEW.cost_id for any state mutation. Direct bronze
  -- inserts with NULL cost_id (audit-only, no silver projection desired)
  -- are silently skipped — caller must populate cost_id when they want
  -- silver to materialize.
  IF NEW.cost_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.event_type = 'cost.added' THEN
    INSERT INTO runs_costs (
      id, run_id, cost_name, cost_source, quantity,
      unit_cost_in_usd_cents, total_cost_in_usd_cents,
      net_cost_in_usd_cents, usage_discount_pct, status,
      goal, brand_profile_id, audience_id, workflow_context,
      idempotency_key, created_at
    ) VALUES (
      NEW.cost_id,
      NEW.run_id,
      NEW.payload->>'costName',
      NEW.payload->>'costSource',
      (NEW.payload->>'quantity')::numeric,
      (NEW.payload->>'unitCostInUsdCents')::numeric,
      (NEW.payload->>'totalCostInUsdCents')::numeric,
      COALESCE((NEW.payload->>'netCostInUsdCents')::numeric, (NEW.payload->>'totalCostInUsdCents')::numeric),
      (NEW.payload->>'usageDiscountPct')::numeric,
      COALESCE(NEW.payload->>'status', 'actual'),
      NEW.payload->>'goal',
      NEW.payload->>'brandProfileId',
      COALESCE(NEW.payload->>'audienceId', NEW.payload->>'customerProfileId'),
      NEW.payload->>'workflowContext',
      NEW.payload->>'idempotencyKey',
      NEW.occurred_at
    )
    ON CONFLICT (id) DO NOTHING;
  ELSIF NEW.event_type = 'cost.materialized' THEN
    UPDATE runs_costs SET status = 'actual' WHERE id = NEW.cost_id;
  ELSIF NEW.event_type = 'cost.cancelled' THEN
    UPDATE runs_costs SET status = 'cancelled' WHERE id = NEW.cost_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
