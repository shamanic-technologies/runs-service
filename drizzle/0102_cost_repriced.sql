-- A charged cost row re-priced after the fact (POST /internal/cost-reprices/apply,
-- see CLAUDE.md "Re-priced costs").
--
-- First caller (NEWSLETTER-COST-1107): costs-service's daily price refresh was
-- broken 2026-10-17 -> 11-07, so `postmark-email-send` stayed frozen at
-- 1.1923620000 cents and our OWN org's newsletter sends were written ~7x above
-- what Postmark charged. The owner decided to re-price those rows (our org only).
--
-- `cost.repriced` carries the old AND the new unit/total/net in its payload (the
-- append-only history keeps the old price). The projection moves the three money
-- columns of ONE row, and only while that row still carries the OLD unit price and
-- is still `actual`: a replayed event, or one racing another reprice, moves
-- nothing. Every rollup trigger already fires on UPDATE OF total/net (and unit),
-- so the org/brand/campaign/cost-name/consumption rollups follow the new amounts.
--
-- Function body only: no column, no index, no data rewrite. Every other branch is
-- unchanged from migration 0048.
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
  ELSIF NEW.event_type = 'cost.repriced' THEN
    UPDATE runs_costs
       SET unit_cost_in_usd_cents = (NEW.payload->>'newUnitCostInUsdCents')::numeric,
           total_cost_in_usd_cents = (NEW.payload->>'newTotalCostInUsdCents')::numeric,
           net_cost_in_usd_cents = (NEW.payload->>'newNetCostInUsdCents')::numeric
     WHERE id = NEW.cost_id
       AND status = 'actual'
       AND unit_cost_in_usd_cents = (NEW.payload->>'fromUnitCostInUsdCents')::numeric;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
