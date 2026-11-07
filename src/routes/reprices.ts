// Staff re-price of already-written CHARGED cost rows (NEWSLETTER-COST-1107).
//
// A row written at a WRONG price (costs-service's refresh froze
// `postmark-email-send` at 1.1923620000 cents for three weeks) is re-priced to a
// stated unit price. Sibling of the refund action (`refunds.ts`): preview and
// apply share ONE where-clause, so what the preview shows is exactly what apply
// writes, and apply goes through bronze (`cost.repriced`, old + new amounts,
// reason, actor) projected by the silver trigger (migration 0102). Every rollup
// trigger fires on UPDATE of total/net, so the stats follow the new amounts.
//
// The set is bounded on purpose: ONE org, ONE cost name, the OLD unit price
// (exact), status 'actual', cost_source 'platform'. A re-priced row no longer
// carries the old price, so a re-apply matches nothing and no amount moves twice.
// Apply re-prices at most REPRICE_APPLY_MAX_COSTS rows per call (oldest first);
// a larger set is applied in successive calls until `remainingCostCount` is 0.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { requireInternalAuth } from "../middleware/auth.js";
import {
  RepricePreviewRequestSchema,
  RepriceApplyRequestSchema,
  REPRICE_APPLY_MAX_COSTS,
  REPRICE_PREVIEW_LIST_LIMIT,
} from "../schemas.js";
import type { RepriceFilter } from "../schemas.js";

const router = Router();

const fixed = (v: string | null) => new Decimal(v ?? 0).toFixed(10);

/** The single definition of "which rows this re-price targets". */
function repriceWhere(f: RepriceFilter) {
  const parts = [
    sql`r.organization_id = ${f.orgId}`,
    sql`rc.cost_name = ${f.costName}`,
    sql`rc.status = 'actual'`,
    sql`rc.cost_source = 'platform'`,
    sql`rc.unit_cost_in_usd_cents = ${f.fromUnitCostInUsdCents}::numeric`,
  ];
  if (f.createdAfter) parts.push(sql`rc.created_at >= ${f.createdAfter}::timestamptz`);
  if (f.createdBefore) parts.push(sql`rc.created_at < ${f.createdBefore}::timestamptz`);
  if (f.serviceName) parts.push(sql`r.service_name = ${f.serviceName}`);
  if (f.taskName) parts.push(sql`r.task_name = ${f.taskName}`);
  return parts.reduce((acc, p) => sql`${acc} AND ${p}`);
}

/**
 * The matched rows with their NEW amounts, computed in Postgres (numeric, never a
 * JS float): gross = round(quantity x new unit, 10), net = round(gross x (1 -
 * frozen usage discount), 10), a NULL net (pre-0028 row) stays NULL.
 */
function matchedSql(f: RepriceFilter, limit?: number, lock = false) {
  return sql`
    SELECT rc.id AS cost_id, rc.run_id, rc.cost_name, rc.quantity::text AS quantity,
           rc.unit_cost_in_usd_cents::text AS unit_before,
           ${f.toUnitCostInUsdCents}::numeric(16,10)::text AS unit_after,
           rc.total_cost_in_usd_cents::text AS total_before,
           round(rc.quantity * ${f.toUnitCostInUsdCents}::numeric, 10)::numeric(16,10)::text AS total_after,
           rc.net_cost_in_usd_cents::text AS net_before_raw,
           COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)::text AS net_before,
           CASE WHEN rc.net_cost_in_usd_cents IS NULL THEN NULL
                ELSE round(round(rc.quantity * ${f.toUnitCostInUsdCents}::numeric, 10)
                           * (1 - COALESCE(rc.usage_discount_pct, 0)), 10)::numeric(16,10)::text END AS net_after_raw,
           rc.usage_discount_pct::text AS usage_discount_pct,
           rc.created_at, rc.goal, rc.brand_profile_id, rc.audience_id, rc.workflow_context,
           r.user_id, r.brand_ids, r.campaign_id, r.workflow_slug, r.feature_slug,
           r.service_name, r.task_name
      FROM runs_costs rc
      JOIN runs r ON r.id = rc.run_id
     WHERE ${repriceWhere(f)}
     ORDER BY rc.created_at ASC, rc.id ASC
     ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}
     ${lock ? sql`FOR UPDATE OF rc` : sql``}
  `;
}

/** Totals over a matched set (the FULL set for preview, the batch for apply). */
function totalsSql(inner: ReturnType<typeof matchedSql>) {
  return sql`
    SELECT COUNT(*)::int AS cost_count,
           COUNT(DISTINCT m.run_id)::int AS run_count,
           COALESCE(SUM(m.quantity::numeric), 0)::text AS quantity_total,
           COALESCE(SUM(m.total_before::numeric), 0)::text AS gross_before,
           COALESCE(SUM(m.total_after::numeric), 0)::text AS gross_after,
           COALESCE(SUM(m.net_before::numeric), 0)::text AS net_before,
           COALESCE(SUM(COALESCE(m.net_after_raw, m.total_after)::numeric), 0)::text AS net_after
      FROM (${inner}) m
  `;
}

function shapeTotals(row: any) {
  return {
    costCount: Number(row.cost_count),
    runCount: Number(row.run_count),
    quantityTotal: new Decimal(row.quantity_total).toFixed(6),
    grossBeforeInUsdCents: fixed(row.gross_before),
    grossAfterInUsdCents: fixed(row.gross_after),
    netBeforeInUsdCents: fixed(row.net_before),
    netAfterInUsdCents: fixed(row.net_after),
  };
}

function sameUnitPrice(f: RepriceFilter) {
  return new Decimal(f.fromUnitCostInUsdCents).eq(new Decimal(f.toUnitCostInUsdCents));
}

// POST /internal/cost-reprices/preview — what apply WOULD write. Writes nothing.
router.post("/internal/cost-reprices/preview", requireInternalAuth, async (req, res) => {
  const parsed = RepricePreviewRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const f = parsed.data;
  if (sameUnitPrice(f)) {
    res.status(400).json({ error: "toUnitCostInUsdCents must differ from fromUnitCostInUsdCents" });
    return;
  }
  try {
    const [t] = (await db.execute(totalsSql(matchedSql(f)))) as any[];
    const rows = (await db.execute(matchedSql(f, REPRICE_PREVIEW_LIST_LIMIT))) as any[];
    const totals = shapeTotals(t);
    res.json({
      orgId: f.orgId,
      ...totals,
      costsTruncated: totals.costCount > rows.length,
      costsListLimit: REPRICE_PREVIEW_LIST_LIMIT,
      costs: rows.map((r) => ({
        id: r.cost_id,
        runId: r.run_id,
        costName: r.cost_name,
        serviceName: r.service_name,
        taskName: r.task_name,
        quantity: r.quantity,
        unitCostBeforeInUsdCents: fixed(r.unit_before),
        unitCostAfterInUsdCents: fixed(r.unit_after),
        totalCostBeforeInUsdCents: fixed(r.total_before),
        totalCostAfterInUsdCents: fixed(r.total_after),
        netCostBeforeInUsdCents: fixed(r.net_before),
        netCostAfterInUsdCents: fixed(r.net_after_raw ?? r.total_after),
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  } catch (err) {
    console.error("[runs-service] Error in POST /internal/cost-reprices/preview:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /internal/cost-reprices/apply — re-price the previewed set, oldest first.
router.post("/internal/cost-reprices/apply", requireInternalAuth, async (req, res) => {
  const parsed = RepriceApplyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const { reason, repricedBy, maxCosts, ...f } = parsed.data;
  if (sameUnitPrice(f)) {
    res.status(400).json({ error: "toUnitCostInUsdCents must differ from fromUnitCostInUsdCents" });
    return;
  }
  const limit = maxCosts ?? REPRICE_APPLY_MAX_COSTS;
  try {
    // ONE transaction: lock the batch, freeze its before/after totals, then one
    // bronze event per row (INSERT ... SELECT, the projection trigger moves silver).
    // Any failure rolls the whole batch back: no partial money write.
    const result = await db.transaction(async (tx) => {
      const [t] = (await tx.execute(sql`
        WITH b AS MATERIALIZED (${matchedSql(f, limit, true)}),
        ins AS (
          INSERT INTO cost_lifecycle_events (run_id, cost_id, event_type, payload, identity)
          SELECT b.run_id, b.cost_id, 'cost.repriced',
                 jsonb_build_object(
                   'costName', b.cost_name,
                   'quantity', b.quantity,
                   'fromUnitCostInUsdCents', b.unit_before,
                   'newUnitCostInUsdCents', b.unit_after,
                   'fromTotalCostInUsdCents', b.total_before,
                   'newTotalCostInUsdCents', b.total_after,
                   'fromNetCostInUsdCents', b.net_before_raw,
                   'newNetCostInUsdCents', b.net_after_raw,
                   'usageDiscountPct', b.usage_discount_pct,
                   'reason', ${reason}::text,
                   'repricedBy', ${repricedBy}::text
                 ),
                 jsonb_build_object(
                   'orgId', ${f.orgId}::text,
                   'userId', b.user_id,
                   'brandIds', to_jsonb(b.brand_ids),
                   'campaignId', b.campaign_id,
                   'workflowSlug', b.workflow_slug,
                   'featureSlug', b.feature_slug,
                   'goal', b.goal,
                   'brandProfileId', b.brand_profile_id,
                   'audienceId', b.audience_id,
                   'workflowContext', b.workflow_context
                 )
            FROM b
           ORDER BY b.created_at, b.cost_id
          RETURNING 1
        )
        SELECT COUNT(*)::int AS cost_count,
               COUNT(DISTINCT run_id)::int AS run_count,
               COALESCE(SUM(quantity::numeric), 0)::text AS quantity_total,
               COALESCE(SUM(total_before::numeric), 0)::text AS gross_before,
               COALESCE(SUM(total_after::numeric), 0)::text AS gross_after,
               COALESCE(SUM(net_before::numeric), 0)::text AS net_before,
               COALESCE(SUM(COALESCE(net_after_raw, total_after)::numeric), 0)::text AS net_after,
               (SELECT COUNT(*) FROM ins)::int AS events_written
          FROM b
      `)) as any[];
      if (Number(t.events_written) !== Number(t.cost_count)) {
        throw new Error(`reprice wrote ${t.events_written} events for ${t.cost_count} rows`);
      }
      return { totals: shapeTotals(t) };
    });
    // Counted AFTER commit: inside the transaction it held the org's rollup-row locks
    // (org_actual_totals is one row per org) for the ~20-40 s of the scan, blocking
    // that org's live cost writes (prod 2026-11-07).
    const [left] = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM runs_costs rc JOIN runs r ON r.id = rc.run_id WHERE ${repriceWhere(f)}
    `)) as any[];
    const remaining = Number(left.n);

    console.log(
      `[runs-service] cost-reprices/apply: org=${f.orgId} cost=${f.costName} ${f.fromUnitCostInUsdCents}->${f.toUnitCostInUsdCents} rows=${result.totals.costCount} gross ${result.totals.grossBeforeInUsdCents}->${result.totals.grossAfterInUsdCents} remaining=${remaining} by=${repricedBy}`
    );
    res.json({
      orgId: f.orgId,
      repricedCostCount: result.totals.costCount,
      remainingCostCount: remaining,
      ...result.totals,
    });
  } catch (err) {
    console.error("[runs-service] Error in POST /internal/cost-reprices/apply:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
