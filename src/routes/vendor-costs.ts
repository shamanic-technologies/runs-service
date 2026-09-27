import { Router } from "express";
import { sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { requireInternalAuth } from "../middleware/auth.js";
import { resolveWorkflowDynastySlugs, type IdentityHeaders } from "../services/dynasty-resolver.js";
import { parseCampaignIds } from "../services/campaign-ids.js";
import { VendorCostCatalogError, fetchVendorCostCatalog, type VendorCostVersion } from "../services/vendor-costs.js";
import { PUBLIC_COST_SOURCES, buildPublicFilterSql, costSourceJoinSql, parseCsv } from "./stats.js";

const router = Router();

const INTERVALS = new Set(["day", "week", "month"]);

/**
 * The version table as a Postgres relation of MATCH WINDOWS: a cost row is priced
 * by the latest version of its cost name whose billed unit price equals the one
 * the row froze and which was being served when the row was written. Windows are per
 * (name, billed price) — a price re-used by a later version (a markup change that
 * lands on the same billed figure with a different vendor cost) opens a new
 * window, so each row matches at most ONE version and no cost is counted twice.
 */
function versionWindowsSql(versions: VendorCostVersion[]) {
  const rows = versions
    .filter((v) => v.billedUnitCostInUsdCents !== null)
    .map((v) => ({
      cost_name: v.costName,
      billed: v.billedUnitCostInUsdCents,
      vendor: v.vendorUnitCostInUsdCents,
      served_from: v.servedFrom,
    }));
  return sql`
    SELECT x.cost_name, x.billed, x.vendor, x.served_from AS valid_from,
           LEAD(x.served_from) OVER (PARTITION BY x.cost_name, x.billed ORDER BY x.served_from) AS valid_to
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      AS x(cost_name text, billed numeric, vendor numeric, served_from timestamptz)
  `;
}

const STATUSES = {
  total: sql`status IN ('actual','provisioned')`,
  actual: sql`status = 'actual'`,
  provisioned: sql`status = 'provisioned'`,
  refunded: sql`status = 'refunded'`,
} as const;

function sumsSql() {
  return sql.join(
    (Object.keys(STATUSES) as Array<keyof typeof STATUSES>).map((k) => {
      const pred = STATUSES[k];
      return sql`
        COALESCE(SUM(CASE WHEN ${pred} THEN billed_total ELSE 0 END), 0)::text AS ${sql.raw(`billed_${k}`)},
        COALESCE(SUM(CASE WHEN ${pred} AND priced THEN vendor_total ELSE 0 END), 0)::text AS ${sql.raw(`vendor_${k}`)},
        COALESCE(SUM(CASE WHEN ${pred} AND NOT priced THEN billed_total ELSE 0 END), 0)::text AS ${sql.raw(`unpriced_${k}`)}`;
    }),
    sql`,`,
  );
}

const fixed = (v: unknown) => new Decimal(v as string).toFixed(10);

/**
 * GET /internal/stats/costs/timeseries/vendor — the dated spend of
 * GET /v1/stats/public/costs/timeseries (same filters, same row set, same
 * buckets) on the VENDOR-COST basis: what the same rows cost us from the vendor,
 * before our markup, as costs-service states it per price version.
 *
 * Service-auth only. The public twin is untouched and never carries a vendor
 * figure: the vendor cost reveals our margin.
 */
router.get("/internal/stats/costs/timeseries/vendor", requireInternalAuth, async (req, res) => {
  try {
    const {
      interval: intervalParam,
      tz: tzParam,
      orgId,
      brandId,
      campaignId,
      campaignIds: campaignIdsParam,
      groupBy,
      featureSlug,
      featureSlugs: featureSlugsParam,
      workflowDynastySlug,
      taskName,
      startedAfter,
      startedBefore,
      costSource,
    } = req.query as Record<string, string | undefined>;

    const interval = intervalParam ?? "day";
    if (!INTERVALS.has(interval)) {
      res.status(400).json({ error: `Invalid interval value. Allowed: ${Array.from(INTERVALS).join(", ")}` });
      return;
    }
    if (costSource && !(PUBLIC_COST_SOURCES as readonly string[]).includes(costSource)) {
      res.status(400).json({ error: `Invalid costSource value. Allowed: ${PUBLIC_COST_SOURCES.join(", ")}` });
      return;
    }
    if (groupBy !== undefined && groupBy !== "campaignId") {
      res.status(400).json({ error: "Invalid groupBy value. Allowed: campaignId" });
      return;
    }
    const groupByCampaign = groupBy === "campaignId";
    const parsedCampaignIds = parseCampaignIds(campaignIdsParam);
    if (parsedCampaignIds.error) {
      res.status(400).json({ error: parsedCampaignIds.error });
      return;
    }
    const timezone = tzParam ?? "UTC";

    let workflowSlugs: string[] | undefined;
    if (workflowDynastySlug) {
      const identity: IdentityHeaders = {
        orgId: req.headers["x-org-id"] as string,
        userId: req.headers["x-user-id"] as string,
        runId: req.headers["x-run-id"] as string,
      };
      const resolved = await resolveWorkflowDynastySlugs(workflowDynastySlug, identity);
      if (resolved.length === 0) {
        res.json({ interval, timezone, buckets: [] });
        return;
      }
      workflowSlugs = resolved;
    }

    const filterSql = buildPublicFilterSql({
      orgId,
      brandId,
      campaignId,
      campaignIds: parsedCampaignIds.ids,
      featureSlug,
      featureSlugs: parseCsv(featureSlugsParam),
      workflowSlugs,
      taskName,
      startedAfter,
      startedBefore,
    });
    const whereSql = filterSql ? sql`WHERE ${filterSql}` : sql``;
    const bucketExpr = sql`DATE_TRUNC(${interval}, r.started_at AT TIME ZONE ${timezone})`;
    const groupCols = groupByCampaign ? sql`1, 2` : sql`1`;

    const versions = await fetchVendorCostCatalog();

    const rows = (await db.execute(sql`
      -- Both CTEs are MATERIALIZED on purpose. Inlined, the planner walks runs in a
      -- nested loop and rebuilds the version windows (sort + LEAD over the whole
      -- catalogue) or a hash of them once PER RUN: 19s on a brand's cold-email
      -- dynasty in prod (2026-09-27) against 0.8s for the public twin. Materialized,
      -- the runs x costs scan happens once and the catalogue joins by one hash.
      WITH v AS MATERIALIZED (${versionWindowsSql(versions)}),
      base AS MATERIALIZED (
        SELECT
          to_char(${bucketExpr}, 'YYYY-MM-DD') AS period,
          ${groupByCampaign ? sql`r.campaign_id,` : sql``}
          r.id AS run_id,
          rc.status,
          rc.cost_name,
          rc.unit_cost_in_usd_cents,
          rc.created_at,
          rc.quantity,
          rc.total_cost_in_usd_cents
        FROM runs r
        LEFT JOIN runs_costs rc ON rc.run_id = r.id ${costSourceJoinSql(costSource)}
        ${whereSql}
      ),
      costed AS (
        SELECT
          b.period,
          ${groupByCampaign ? sql`b.campaign_id,` : sql``}
          b.run_id,
          b.status,
          b.cost_name,
          b.total_cost_in_usd_cents AS billed_total,
          b.quantity * v.vendor AS vendor_total,
          (v.vendor IS NOT NULL) AS priced
        FROM base b
        LEFT JOIN v
          ON v.cost_name = b.cost_name
         AND v.billed = b.unit_cost_in_usd_cents
         AND b.created_at >= v.valid_from
         AND (v.valid_to IS NULL OR b.created_at < v.valid_to)
      )
      SELECT
        period,
        ${groupByCampaign ? sql`campaign_id,` : sql``}
        ${sumsSql()},
        COALESCE(
          array_agg(DISTINCT cost_name ORDER BY cost_name)
            FILTER (WHERE status IN ('actual','provisioned') AND NOT priced),
          '{}'
        ) AS unpriced_cost_names,
        COUNT(DISTINCT run_id) AS run_count
      FROM costed
      GROUP BY ${groupCols}
      ORDER BY ${groupCols}
    `)) as any[];

    const buckets = rows.map((row) => ({
      period: row.period as string,
      ...(groupByCampaign ? { campaignId: (row.campaign_id as string | null) ?? null } : {}),
      totalCostInUsdCents: fixed(row.billed_total),
      actualCostInUsdCents: fixed(row.billed_actual),
      provisionedCostInUsdCents: fixed(row.billed_provisioned),
      refundedCostInUsdCents: fixed(row.billed_refunded),
      vendorTotalCostInUsdCents: fixed(row.vendor_total),
      vendorActualCostInUsdCents: fixed(row.vendor_actual),
      vendorProvisionedCostInUsdCents: fixed(row.vendor_provisioned),
      vendorRefundedCostInUsdCents: fixed(row.vendor_refunded),
      unpricedTotalCostInUsdCents: fixed(row.unpriced_total),
      unpricedActualCostInUsdCents: fixed(row.unpriced_actual),
      unpricedProvisionedCostInUsdCents: fixed(row.unpriced_provisioned),
      unpricedRefundedCostInUsdCents: fixed(row.unpriced_refunded),
      unpricedCostNames: row.unpriced_cost_names as string[],
      runCount: Number(row.run_count),
    }));

    res.json({ interval, timezone, buckets });
  } catch (err) {
    console.error("[Runs Service] Error in GET /internal/stats/costs/timeseries/vendor:", err);
    if (err instanceof VendorCostCatalogError) {
      res.status(502).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
