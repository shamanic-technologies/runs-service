// Late declaration of spend that REALLY happened, that the platform decided never
// to charge, and that was never declared at the time (CLAUDE.md "Incurred,
// never-charged costs").
//
// The only other way to put such a cost in the ledger is POST it `actual` then
// refund it, which charges the org between the two calls (balance, auto top-up,
// pacing all read `actual`). Here the row is BORN `refunded` — the state a refund
// leaves a row in — so it sits in no charge predicate at any instant
// (`is_platform_projected` / `is_platform_committed` are atomic literals that do
// not name `refunded`), while every incurred read (the refunded columns, every
// rollup) counts it. Its `created_at` is the stated `incurredAt` (migration 0048),
// so created_at-keyed reads place it on the day it happened; run-dated reads use the
// run's started_at like any cost.
//
// preview and apply run the SAME classification (`classify`), so the dry run shows
// exactly what apply writes, priced the same way.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { requireInternalAuth } from "../middleware/auth.js";
import { costLifecycleEvents } from "../db/schema.js";
import { newCostId } from "../services/bronze.js";
import { resolveMultipleUnitCosts, CostNotFoundError, UpstreamError } from "../services/cost-resolver.js";
import { resolveUsageDiscount, netFromGross, UsageDiscountError } from "../services/usage-discount.js";
import { IncurredCostsPreviewRequestSchema, IncurredCostsApplyRequestSchema } from "../schemas.js";

const router = Router();

type Item = {
  runId: string;
  costName: string;
  quantity: number;
  incurredAt: string;
  idempotencyKey: string;
};

type RunRow = {
  id: string;
  organization_id: string | null;
  user_id: string | null;
  brand_ids: string[] | null;
  campaign_id: string | null;
  workflow_slug: string | null;
  feature_slug: string | null;
  goal: string | null;
  brand_profile_id: string | null;
  audience_id: string | null;
  workflow_context: string | null;
  started_at: Date | string;
};

type ExistingRow = {
  id: string;
  run_id: string;
  idempotency_key: string;
  cost_name: string;
  status: string;
  total_cost_in_usd_cents: string;
  net_cost_in_usd_cents: string;
  created_at: Date | string;
};

type Result = {
  runId: string;
  idempotencyKey: string;
  costName: string;
  outcome: "to_record" | "recorded" | "already_recorded" | "invalid";
  costId: string | null;
  status: string | null;
  incurredAt: string | null;
  totalCostInUsdCents: string | null;
  netCostInUsdCents: string | null;
  error: string | null;
};

type Planned = {
  index: number;
  item: Item;
  run: RunRow;
  unitCost: string;
  quantity: string;
  total: string;
  net: string;
  discountPct: string | null;
  incurredAtIso: string;
};

const iso = (d: Date | string) => new Date(d).toISOString();
const keyOf = (runId: string, key: string) => `${runId}\u0000${key}`;

async function loadRuns(runIds: string[]): Promise<Map<string, RunRow>> {
  const rows = (await db.execute(sql`
    SELECT id, organization_id, user_id, brand_ids, campaign_id, workflow_slug, feature_slug,
           goal, brand_profile_id, audience_id, workflow_context, started_at
      FROM runs
     WHERE id = ANY(string_to_array(${runIds.join(",")}, ',')::uuid[])
  `)) as unknown as RunRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

// Served by the per-run idempotency unique index (run_id, idempotency_key).
// Keys travel as JSON: a caller key may hold commas, quotes or braces.
async function loadExisting(items: Item[]): Promise<Map<string, ExistingRow>> {
  const rows = (await db.execute(sql`
    SELECT rc.id, rc.run_id, rc.idempotency_key, rc.cost_name, rc.status,
           rc.total_cost_in_usd_cents::text AS total_cost_in_usd_cents,
           COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)::text AS net_cost_in_usd_cents,
           rc.created_at
      FROM jsonb_to_recordset(${JSON.stringify(items.map((i) => ({ run_id: i.runId, idem: i.idempotencyKey })))}::jsonb)
           AS k(run_id uuid, idem text)
      JOIN runs_costs rc ON rc.run_id = k.run_id AND rc.idempotency_key = k.idem
  `)) as unknown as ExistingRow[];
  return new Map(rows.map((r) => [keyOf(r.run_id, r.idempotency_key), r]));
}

/**
 * The single definition of what preview shows and apply writes. Throws
 * CostNotFoundError / UpstreamError / UsageDiscountError (mapped by the caller).
 */
async function classify(items: Item[], now: Date) {
  const runIds = [...new Set(items.map((i) => i.runId))];
  const [runsById, existing] = await Promise.all([loadRuns(runIds), loadExisting(items)]);

  // Catalogue price of each name as resolved today — the same resolution a live
  // cost write uses (costs-service platform price).
  const prices = await resolveMultipleUnitCosts(items.map((i) => i.costName), {});

  // Org usage discount, frozen at write like any cost row (cached 60 s per org).
  const discounts = new Map<string, Decimal>();
  for (const run of runsById.values()) {
    const org = run.organization_id;
    if (org && !discounts.has(org)) discounts.set(org, await resolveUsageDiscount(org));
  }

  const results: Result[] = [];
  const planned: Planned[] = [];
  const seen = new Set<string>();

  items.forEach((item, index) => {
    const k = keyOf(item.runId, item.idempotencyKey);
    const base = { runId: item.runId, idempotencyKey: item.idempotencyKey, costName: item.costName };
    const invalid = (error: string): Result => ({
      ...base, outcome: "invalid", costId: null, status: null, incurredAt: item.incurredAt,
      totalCostInUsdCents: null, netCostInUsdCents: null, error,
    });

    if (seen.has(k)) {
      results.push(invalid("duplicate (runId, idempotencyKey) in this request"));
      return;
    }
    seen.add(k);

    const prior = existing.get(k);
    if (prior) {
      results.push({
        ...base,
        costName: prior.cost_name,
        outcome: "already_recorded",
        costId: prior.id,
        status: prior.status,
        incurredAt: iso(prior.created_at),
        totalCostInUsdCents: new Decimal(prior.total_cost_in_usd_cents).toFixed(10),
        netCostInUsdCents: new Decimal(prior.net_cost_in_usd_cents).toFixed(10),
        error: null,
      });
      return;
    }

    const run = runsById.get(item.runId);
    if (!run) {
      results.push(invalid("run not found"));
      return;
    }
    const incurredAt = new Date(item.incurredAt);
    if (incurredAt.getTime() > now.getTime()) {
      results.push(invalid("incurredAt is in the future"));
      return;
    }
    if (incurredAt.getTime() < new Date(run.started_at).getTime()) {
      results.push(invalid(`incurredAt is before the run started (${iso(run.started_at)})`));
      return;
    }

    const unitCost = prices.get(item.costName)!;
    const quantity = new Decimal(item.quantity).toFixed(6);
    const total = new Decimal(quantity).times(unitCost).toFixed(10);
    const pct = (run.organization_id && discounts.get(run.organization_id)) || new Decimal(0);
    const net = netFromGross(total, pct);
    planned.push({
      index, item, run, unitCost, quantity, total, net,
      discountPct: pct.gt(0) ? pct.toFixed(8) : null,
      incurredAtIso: incurredAt.toISOString(),
    });
    results.push({
      ...base, outcome: "to_record", costId: null, status: "refunded", incurredAt: incurredAt.toISOString(),
      totalCostInUsdCents: total, netCostInUsdCents: net, error: null,
    });
  });

  const sum = (vals: Array<string | null>) =>
    vals.reduce((acc, v) => acc.plus(v ?? "0"), new Decimal(0)).toFixed(10);
  const already = results.filter((r) => r.outcome === "already_recorded");
  const totals = {
    itemCount: items.length,
    toRecordCount: planned.length,
    alreadyRecordedCount: already.length,
    invalidCount: results.filter((r) => r.outcome === "invalid").length,
    totalCostInUsdCents: sum(planned.map((p) => p.total)),
    netTotalCostInUsdCents: sum(planned.map((p) => p.net)),
    alreadyRecordedTotalCostInUsdCents: sum(already.map((r) => r.totalCostInUsdCents)),
    unitPrices: Object.fromEntries(prices),
  };
  return { results, planned, totals };
}

function sendError(res: any, err: unknown, route: string) {
  if (err instanceof CostNotFoundError) {
    res.status(422).json({ error: `Unknown cost: ${err.costName}` });
    return;
  }
  if (err instanceof UpstreamError) {
    res.status(502).json({ error: `costs-service unavailable: ${err.message}` });
    return;
  }
  if (err instanceof UsageDiscountError) {
    res.status(502).json({ error: `usage-discount unresolvable: ${err.message}` });
    return;
  }
  console.error(`[runs-service] Error in POST ${route}:`, err);
  res.status(500).json({ error: "Internal server error" });
}

// POST /internal/incurred-costs/preview — dry run. Writes nothing.
router.post("/internal/incurred-costs/preview", requireInternalAuth, async (req, res) => {
  const parsed = IncurredCostsPreviewRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const { results, totals } = await classify(parsed.data.items, new Date());
    res.json({ ...totals, items: results });
  } catch (err) {
    sendError(res, err, "/internal/incurred-costs/preview");
  }
});

// POST /internal/incurred-costs/apply — record exactly what the preview shows.
router.post("/internal/incurred-costs/apply", requireInternalAuth, async (req, res) => {
  const parsed = IncurredCostsApplyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const { items, reason, authorizedBy } = parsed.data;

  try {
    let attempt = 0;
    for (;;) {
      const { results, planned, totals } = await classify(items, new Date());
      if (totals.invalidCount > 0) {
        res.status(422).json({ ...totals, items: results });
        return;
      }

      const costIds = planned.map(() => newCostId());
      try {
        if (planned.length > 0) {
          // Bronze first; the projection trigger writes silver (status 'refunded',
          // created_at = incurredAt) in the SAME statement. One statement, one
          // transaction: all items or none.
          await db.transaction(async (tx) => {
            await tx.insert(costLifecycleEvents).values(
              planned.map((p, i) => ({
                runId: p.item.runId,
                costId: costIds[i],
                eventType: "cost.added",
                payload: {
                  costId: costIds[i],
                  costName: p.item.costName,
                  costSource: "platform",
                  quantity: p.quantity,
                  unitCostInUsdCents: p.unitCost,
                  totalCostInUsdCents: p.total,
                  netCostInUsdCents: p.net,
                  usageDiscountPct: p.discountPct,
                  status: "refunded",
                  incurredAt: p.incurredAtIso,
                  origin: "incurred_uncharged",
                  reason,
                  authorizedBy,
                  runOrganizationId: p.run.organization_id,
                  runStartedAt: iso(p.run.started_at),
                  goal: p.run.goal,
                  brandProfileId: p.run.brand_profile_id,
                  audienceId: p.run.audience_id,
                  workflowContext: p.run.workflow_context,
                  idempotencyKey: p.item.idempotencyKey,
                },
                identity: {
                  orgId: p.run.organization_id,
                  userId: p.run.user_id,
                  brandIds: p.run.brand_ids,
                  campaignId: p.run.campaign_id,
                  workflowSlug: p.run.workflow_slug,
                  featureSlug: p.run.feature_slug,
                  goal: p.run.goal,
                  brandProfileId: p.run.brand_profile_id,
                  audienceId: p.run.audience_id,
                  workflowContext: p.run.workflow_context,
                },
                idempotencyKey: p.item.idempotencyKey,
              })),
            );
          });
        }
      } catch (err: any) {
        // A concurrent apply wrote one of these keys first (per-run unique index):
        // nothing of ours committed; re-classify so it reads already_recorded.
        if ((err?.code === "23505" || err?.cause?.code === "23505") && attempt < 3) {
          attempt++;
          continue;
        }
        throw err;
      }

      planned.forEach((p, i) => {
        results[p.index] = {
          ...results[p.index],
          outcome: "recorded",
          costId: costIds[i],
          status: "refunded",
          incurredAt: p.incurredAtIso,
        };
      });

      console.log(
        `[runs-service] incurred-costs/apply: recorded=${planned.length} already=${totals.alreadyRecordedCount} gross=${totals.totalCostInUsdCents} net=${totals.netTotalCostInUsdCents} by=${authorizedBy}`,
      );
      res.json({ ...totals, recordedCount: planned.length, items: results });
      return;
    }
  } catch (err) {
    sendError(res, err, "/internal/incurred-costs/apply");
  }
});

export default router;
