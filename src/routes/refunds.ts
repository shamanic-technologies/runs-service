// Staff-facing refund action over a set of cost rows.
//
// A refund is a fact about a COST ROW (`runs_costs.status = 'refunded'`), never
// about the run — a run's status describes what happened to the run, not who paid
// for it. So what staff get here is a run-scoped / filter-scoped ACTION over cost
// rows, with a mandatory preview: this writes money, and a filter that writes in
// one shot with no preview is not acceptable.
//
// preview and apply take the SAME filter and select the SAME set, so what the
// preview shows is exactly what apply writes. Both are restricted to rows that are
// CHARGED (`status = 'actual'`) and PLATFORM-billed (`cost_source = 'platform'`):
//   - a provisioned hold was never charged, so releasing it is the existing cancel
//   - a BYOK (`cost_source = 'org'`) row is paid straight to the provider by the
//     org and is not part of what the platform charges, so there is nothing to comp
// Rows already refunded do not match, which is what makes apply idempotent: running
// it twice refunds the second time zero rows and moves no amount twice.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { requireInternalAuth } from "../middleware/auth.js";
import { logCostLifecycle } from "../services/bronze.js";
import { RefundPreviewRequestSchema, RefundApplyRequestSchema } from "../schemas.js";
import type { RefundFilter } from "../schemas.js";

const router = Router();

// How many rows the preview lists. Totals ALWAYS cover the whole matched set —
// only the row listing is capped, and `costsTruncated` says so explicitly rather
// than silently returning a short list that reads as "this is everything".
const PREVIEW_LIST_LIMIT = 500;

// Upper bound on a single apply. A refund is a money write; an unbounded filter
// that turns out to match a whole org's ledger should make staff narrow the
// filter, not discover the blast radius afterwards. Fail loud.
const APPLY_MAX_COSTS = 5000;

type MatchedCostRow = {
  cost_id: string;
  run_id: string;
  cost_name: string;
  cost_source: string;
  total_cost_in_usd_cents: string;
  net_cost_in_usd_cents: string;
  created_at: Date;
  goal: string | null;
  brand_profile_id: string | null;
  audience_id: string | null;
  workflow_context: string | null;
  user_id: string | null;
  brand_ids: string[] | null;
  campaign_id: string | null;
  workflow_slug: string | null;
  feature_slug: string | null;
  service_name: string;
  task_name: string;
  started_at: Date;
};

/**
 * WHERE clause shared by preview and apply — the single definition of "which rows
 * this refund targets", so the two can never drift.
 *
 * `rootRunId` restricts to that run AND its descendants (staff refund a whole run's
 * costs without enumerating rows by hand); the recursive walk is anchored on
 * `id = $rootRunId` so Postgres only visits that subtree (indexed by idx_runs_parent).
 */
function buildRefundWhere(filter: RefundFilter) {
  const parts = [
    sql`r.organization_id = ${filter.orgId}`,
    sql`rc.status = 'actual'`,
    sql`rc.cost_source = 'platform'`,
  ];

  if (filter.rootRunId) {
    parts.push(sql`rc.run_id IN (
      WITH RECURSIVE subtree AS (
        SELECT id FROM runs WHERE id = ${filter.rootRunId}
        UNION ALL
        SELECT child.id FROM runs child JOIN subtree ON child.parent_run_id = subtree.id
      )
      SELECT id FROM subtree
    )`);
  }
  if (filter.costNamePrefix) {
    // Prefix match on the literal name — `like_escape` keeps a `%` or `_` inside a
    // cost name from widening the match.
    parts.push(sql`rc.cost_name LIKE ${filter.costNamePrefix.replace(/([%_\\])/g, "\\$1") + "%"}`);
  }
  if (filter.costName) parts.push(sql`rc.cost_name = ${filter.costName}`);
  if (filter.serviceName) parts.push(sql`r.service_name = ${filter.serviceName}`);
  if (filter.taskName) parts.push(sql`r.task_name = ${filter.taskName}`);
  if (filter.startedAfter) parts.push(sql`r.started_at >= ${filter.startedAfter}::timestamptz`);
  if (filter.startedBefore) parts.push(sql`r.started_at < ${filter.startedBefore}::timestamptz`);

  return parts.reduce((acc, part) => sql`${acc} AND ${part}`);
}

/**
 * Totals over the FULL matched set. All arithmetic stays in Postgres and the sums
 * come back as `::text` so `numeric(16,10)` survives byte-for-byte (CLAUDE.md
 * "Cost & billing precision" — never `Number(x)` on a cost value).
 */
async function matchedTotals(filter: RefundFilter) {
  const whereSql = buildRefundWhere(filter);
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS cost_count,
           COUNT(DISTINCT rc.run_id)::int AS run_count,
           COALESCE(SUM(rc.total_cost_in_usd_cents), 0)::text AS gross_total,
           COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)), 0)::text AS net_total
      FROM runs_costs rc
      JOIN runs r ON r.id = rc.run_id
     WHERE ${whereSql}
  `);
  const row = (result as any[])[0];
  return {
    costCount: Number(row.cost_count),
    runCount: Number(row.run_count),
    grossTotalInUsdCents: new Decimal(row.gross_total).toFixed(10),
    netTotalInUsdCents: new Decimal(row.net_total).toFixed(10),
  };
}

async function matchedRows(filter: RefundFilter, limit?: number): Promise<MatchedCostRow[]> {
  const whereSql = buildRefundWhere(filter);
  const limitSql = limit === undefined ? sql`` : sql`LIMIT ${limit}`;
  const result = await db.execute(sql`
    SELECT rc.id AS cost_id, rc.run_id, rc.cost_name, rc.cost_source,
           rc.total_cost_in_usd_cents,
           COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) AS net_cost_in_usd_cents,
           rc.created_at, rc.goal, rc.brand_profile_id, rc.audience_id, rc.workflow_context,
           r.user_id, r.brand_ids, r.campaign_id, r.workflow_slug, r.feature_slug,
           r.service_name, r.task_name, r.started_at
      FROM runs_costs rc
      JOIN runs r ON r.id = rc.run_id
     WHERE ${whereSql}
     ORDER BY rc.created_at ASC, rc.id ASC
     ${limitSql}
  `);
  return result as unknown as MatchedCostRow[];
}

// POST /internal/cost-refunds/preview — what WOULD be refunded, and for how much.
// Writes nothing.
router.post("/internal/cost-refunds/preview", requireInternalAuth, async (req, res) => {
  const parsed = RefundPreviewRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  try {
    const filter = parsed.data;
    const totals = await matchedTotals(filter);
    const rows = await matchedRows(filter, PREVIEW_LIST_LIMIT);

    res.json({
      orgId: filter.orgId,
      ...totals,
      costsTruncated: totals.costCount > rows.length,
      costsListLimit: PREVIEW_LIST_LIMIT,
      costs: rows.map((row) => ({
        id: row.cost_id,
        runId: row.run_id,
        costName: row.cost_name,
        serviceName: row.service_name,
        taskName: row.task_name,
        totalCostInUsdCents: new Decimal(row.total_cost_in_usd_cents).toFixed(10),
        netCostInUsdCents: new Decimal(row.net_cost_in_usd_cents).toFixed(10),
        runStartedAt: new Date(row.started_at).toISOString(),
        createdAt: new Date(row.created_at).toISOString(),
      })),
    });
  } catch (err) {
    console.error("[runs-service] Error in POST /internal/cost-refunds/preview:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /internal/cost-refunds/apply — refund exactly the previewed set.
router.post("/internal/cost-refunds/apply", requireInternalAuth, async (req, res) => {
  const parsed = RefundApplyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  try {
    const { reason, refundedBy, ...filter } = parsed.data;
    const totals = await matchedTotals(filter);

    if (totals.costCount > APPLY_MAX_COSTS) {
      res.status(422).json({
        error: `Refund matches ${totals.costCount} cost rows, above the ${APPLY_MAX_COSTS}-row cap for one apply. Narrow the filter (cost name, service/task, date window) and re-preview.`,
      });
      return;
    }

    // Zero matches is a legitimate no-op — a re-applied refund lands here, since
    // already-refunded rows no longer match `status = 'actual'`.
    if (totals.costCount === 0) {
      res.json({ orgId: filter.orgId, refundedCostCount: 0, ...totals });
      return;
    }

    const rows = await matchedRows(filter);

    // Bronze first, silver by projection trigger, all in ONE transaction: if any
    // row fails, none of them flips (CLAUDE.md bronze doctrine — fail loud, no
    // partial money writes).
    await db.transaction(async (tx) => {
      for (const row of rows) {
        await logCostLifecycle(tx, {
          runId: row.run_id,
          costId: row.cost_id,
          eventType: "cost.refunded",
          payload: {
            from: "actual",
            to: "refunded",
            reason,
            refundedBy,
            // What the refund is worth, frozen into the audit alongside the motive
            // so the event is readable without re-joining silver.
            totalCostInUsdCents: row.total_cost_in_usd_cents,
            netCostInUsdCents: row.net_cost_in_usd_cents,
            costName: row.cost_name,
          },
          identity: {
            orgId: filter.orgId,
            userId: row.user_id,
            brandIds: row.brand_ids,
            campaignId: row.campaign_id,
            workflowSlug: row.workflow_slug,
            featureSlug: row.feature_slug,
            goal: row.goal,
            brandProfileId: row.brand_profile_id,
            audienceId: row.audience_id,
            workflowContext: row.workflow_context,
          },
        });
      }
    });

    console.log(
      `[runs-service] cost-refunds/apply: org=${filter.orgId} costs=${totals.costCount} gross=${totals.grossTotalInUsdCents} net=${totals.netTotalInUsdCents} by=${refundedBy}`
    );

    res.json({ orgId: filter.orgId, refundedCostCount: totals.costCount, ...totals });
  } catch (err) {
    console.error("[runs-service] Error in POST /internal/cost-refunds/apply:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
