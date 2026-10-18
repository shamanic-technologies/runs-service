-- A cost that really happened but was never charged, recorded at the date it
-- happened (POST /internal/incurred-costs/apply, see CLAUDE.md "Incurred,
-- never-charged costs").
--
-- The cost row's `created_at` is the instant the spend happened. Until now it was
-- always the bronze event's `occurred_at` (= when we recorded it), which is the
-- same instant for a live write. A late declaration of past spend carries that
-- instant in the `cost.added` payload as `incurredAt`; the projection uses it, so
-- every created_at-keyed read (cost-day rollup, `since` windows, margin reads)
-- places the spend on the day it happened. Bronze keeps `occurred_at` = when it
-- was recorded: the audit never lies about when we wrote it.
--
-- No payload written before this migration carries `incurredAt`, so every
-- existing (and replayed) event projects exactly as before. Function body only:
-- no column, no index, no data rewrite.
--
-- Every other branch is unchanged from migration 0033.
CREATE OR REPLACE FUNCTION project_cost_lifecycle_to_silver() RETURNS trigger AS $$
BEGIN
  IF NEW.cost_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.event_type = 'cost.added' THEN
    INSERT INTO runs_costs (
      id, run_id, cost_name, cost_source, quantity,
      unit_cost_in_usd_cents, total_cost_in_usd_cents,
      net_cost_in_usd_cents, usage_discount_pct, status,
      goal, brand_profile_id, audience_id, workflow_context,
      organization_id, run_started_at, idempotency_key, created_at
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
      (NEW.payload->>'runOrganizationId')::uuid,
      (NEW.payload->>'runStartedAt')::timestamptz,
      NEW.payload->>'idempotencyKey',
      COALESCE((NEW.payload->>'incurredAt')::timestamptz, NEW.occurred_at)
    )
    ON CONFLICT (id) DO NOTHING;
  ELSIF NEW.event_type = 'cost.materialized' THEN
    UPDATE runs_costs SET status = 'actual' WHERE id = NEW.cost_id;
  ELSIF NEW.event_type = 'cost.cancelled' THEN
    UPDATE runs_costs SET status = 'cancelled' WHERE id = NEW.cost_id;
  ELSIF NEW.event_type = 'cost.refunded' THEN
    UPDATE runs_costs SET status = 'refunded' WHERE id = NEW.cost_id AND status = 'actual';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
