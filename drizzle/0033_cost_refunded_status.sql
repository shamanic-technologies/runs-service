-- Fourth cost status: `refunded` — spend that really happened and that the
-- platform has decided NOT to charge the customer for.
--
-- The three existing statuses cannot express this. `actual` keeps charging;
-- `cancelled` says the spend never happened, which is a lie about the ledger.
-- So a comped cost had no honest representation at all, and the only lever was a
-- billing credit grant — which misstates both sides.
--
-- ACCOUNTING vs PERFORMANCE, the line this migration draws:
--   * Accounting ("what does this customer owe / what were they charged") stops
--     counting it. That falls out of the existing predicate doctrine for free:
--     `is_platform_projected` / `is_platform_committed` are atomic status
--     literals (`IN ('actual','provisioned')` / `= 'actual'`), never the negation
--     `!= 'cancelled'`, precisely so a fourth status defaults to NOT counted.
--     Both generated columns therefore need NO change here — a refunded row
--     drops out of `/internal/org-usage-total` (billing's spendable balance) and
--     out of `/internal/runs-expected-totals` the moment its status flips, with
--     no credit written anywhere.
--   * Performance ("what did this workflow cost to produce an outcome") keeps
--     counting it, via the dedicated `refunded_cost` / `net_refunded_cost`
--     aggregation columns added in src/services/cost-aggregator.ts. Real spend =
--     actual + refunded. Refunded is never folded back into the displayed total.
--
-- The RUN's status is deliberately untouched: a refund is a fact about a cost
-- row, not about what happened to the run.
--
-- No column, no backfill, no index. Nothing is refunded yet, so every existing
-- number in this service stays byte-identical after this migration: the only
-- change is that the projection trigger now understands one more domain event.

-- Teach the bronze->silver cost projection trigger the `cost.refunded` event.
-- Every other branch is unchanged from migration 0030.
--
-- The `AND status = 'actual'` guard is the state machine, enforced at the
-- projection: a refund is reachable ONLY from a charged row. Replaying the same
-- bronze event (or projecting one for a row already refunded) updates zero rows
-- — idempotent by construction, so no amount can move twice. A provisioned or
-- cancelled row is never flipped by a replayed refund event either; the HTTP
-- layer refuses those transitions up front with a 409.
--
-- Refund provenance (reason + actor) lives ONLY in the append-only bronze
-- payload of the `cost.refunded` event. It is not projected onto silver: the
-- audit trail is where "why and by whom" belongs, and duplicating it into the
-- projection cache would create a second source of truth for it.
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
      NEW.occurred_at
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
