import { Router } from "express";
import { sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { requireInternalAuth } from "../middleware/auth.js";
import {
  buildSlugToDynastyMap,
  fetchAllWorkflowDynasties,
  resolveWorkflowDynastySlugs,
  type IdentityHeaders,
} from "../services/dynasty-resolver.js";
import { parseCampaignIds } from "../services/campaign-ids.js";
import { VendorCostCatalogError, fetchVendorCostCatalog, type VendorCostVersion } from "../services/vendor-costs.js";
import { PUBLIC_COST_SOURCES, buildPublicFilterSql, costSourceJoinSql, parseCsv } from "./stats.js";
import { listRunsPage } from "./runs.js";

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /internal/runs/vendor — the run list of GET /v1/runs (same query
 * parameters, same runs, same order, same page) with each run's OWN cost also
 * stated on the VENDOR-COST basis: what that run's own cost rows cost us from
 * the vendor, before our markup, priced exactly as the vendor timeseries above.
 *
 * The org is the `orgId` query parameter, not `x-org-id`: a staff caller reads
 * any org. The billed `own*` fields are GET /v1/runs' own, byte-for-byte.
 *
 * Service-auth only — the vendor cost reveals the margin.
 */
router.get("/internal/runs/vendor", requireInternalAuth, async (req, res) => {
  try {
    const orgId = req.query.orgId;
    if (typeof orgId !== "string" || !UUID_RE.test(orgId)) {
      res.status(400).json({ error: "orgId query parameter is required and must be a valid UUID" });
      return;
    }

    const page = await listRunsPage(req.query as Record<string, unknown>, orgId);
    if ("error" in page) {
      res.status(400).json({ error: page.error });
      return;
    }
    const { rows: result, limit, offset } = page;

    const versions = await fetchVendorCostCatalog();
    const vendorByRun = new Map<string, any>();
    if (result.length > 0) {
      const ids = result.map((r) => r.id);
      const rows = (await db.execute(sql`
        WITH v AS MATERIALIZED (${versionWindowsSql(versions)}),
        costed AS (
          SELECT
            rc.run_id,
            rc.status,
            rc.cost_name,
            rc.total_cost_in_usd_cents AS billed_total,
            rc.quantity * v.vendor AS vendor_total,
            (v.vendor IS NOT NULL) AS priced
          FROM runs_costs rc
          LEFT JOIN v
            ON v.cost_name = rc.cost_name
           AND v.billed = rc.unit_cost_in_usd_cents
           AND rc.created_at >= v.valid_from
           AND (v.valid_to IS NULL OR rc.created_at < v.valid_to)
          WHERE rc.run_id = ANY(string_to_array(${ids.join(",")}, ',')::uuid[])
        )
        SELECT
          run_id,
          ${sumsSql()},
          COALESCE(
            array_agg(DISTINCT cost_name ORDER BY cost_name)
              FILTER (WHERE status IN ('actual','provisioned') AND NOT priced),
            '{}'
          ) AS unpriced_cost_names
        FROM costed
        GROUP BY run_id
      `)) as any[];
      for (const row of rows) vendorByRun.set(row.run_id as string, row);
    }

    // A run with no own cost rows has no row here; its billed own cost is 0 too.
    const zero = "0";
    const formattedRuns = result.map((r) => {
      const v = vendorByRun.get(r.id);
      return {
        ...r,
        ownCostInUsdCents: fixed(r.ownCostInUsdCents),
        ownActualCostInUsdCents: fixed(r.ownActualCostInUsdCents),
        ownProvisionedCostInUsdCents: fixed(r.ownProvisionedCostInUsdCents),
        vendorOwnCostInUsdCents: fixed(v?.vendor_total ?? zero),
        vendorOwnActualCostInUsdCents: fixed(v?.vendor_actual ?? zero),
        vendorOwnProvisionedCostInUsdCents: fixed(v?.vendor_provisioned ?? zero),
        unpricedOwnCostInUsdCents: fixed(v?.unpriced_total ?? zero),
        unpricedOwnActualCostInUsdCents: fixed(v?.unpriced_actual ?? zero),
        unpricedOwnProvisionedCostInUsdCents: fixed(v?.unpriced_provisioned ?? zero),
        unpricedCostNames: (v?.unpriced_cost_names as string[] | undefined) ?? [],
      };
    });

    res.json({ runs: formattedRuns, ...(limit !== undefined && { limit }), offset });
  } catch (err) {
    console.error("[Runs Service] Error in GET /internal/runs/vendor:", err);
    if (err instanceof VendorCostCatalogError) {
      res.status(502).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Grouped (undated) twin ---

/**
 * groupBy keys of GET /internal/stats/costs/vendor, with the SAME SQL expression
 * GET /v1/stats/costs groups on — so a group here is the same group there.
 * `audienceId` is the cost-row attribution with the run's as fallback, exactly
 * as the billed read resolves it.
 */
const VENDOR_GROUP_BY_COLUMNS: Record<string, string> = {
  brandId: "unnest(r.brand_ids)",
  workflowSlug: "r.workflow_slug",
  campaignId: "r.campaign_id",
  featureSlug: "r.feature_slug",
  audienceId: "COALESCE(rc.audience_id, r.audience_id)",
  serviceName: "r.service_name",
  taskName: "r.task_name",
  costName: "rc.cost_name",
};
const VENDOR_GROUP_BY_KEYS = [...Object.keys(VENDOR_GROUP_BY_COLUMNS), "workflowDynastySlug"];

const MONEY_FIELDS = [
  "totalCostInUsdCents",
  "actualCostInUsdCents",
  "provisionedCostInUsdCents",
  "refundedCostInUsdCents",
  "vendorTotalCostInUsdCents",
  "vendorActualCostInUsdCents",
  "vendorProvisionedCostInUsdCents",
  "vendorRefundedCostInUsdCents",
  "unpricedTotalCostInUsdCents",
  "unpricedActualCostInUsdCents",
  "unpricedProvisionedCostInUsdCents",
  "unpricedRefundedCostInUsdCents",
] as const;

type VendorGroup = { dimensions: Record<string, string | null> } & Record<(typeof MONEY_FIELDS)[number], string> & {
  unpricedCostNames: string[];
};

/**
 * Merge versioned-slug groups into their dynasty, keeping every OTHER dimension
 * (same rule as the billed read's regroupByDynasty: the merge key is the full
 * tuple of other dimensions + the dynasty, never the dynasty alone).
 */
function regroupVendorByDynasty(groups: VendorGroup[], slugToDynasty: Map<string, string>): VendorGroup[] {
  const merged = new Map<string, VendorGroup>();
  for (const g of groups) {
    const raw = g.dimensions.workflowSlug ?? "";
    const dynasty = slugToDynasty.get(raw) ?? raw;
    const others: Record<string, string | null> = {};
    for (const k of Object.keys(g.dimensions).sort()) if (k !== "workflowSlug") others[k] = g.dimensions[k];
    const key = JSON.stringify([others, dynasty]);
    const existing = merged.get(key);
    if (!existing) {
      const dimensions = { ...g.dimensions };
      delete dimensions.workflowSlug;
      dimensions.workflowDynastySlug = dynasty;
      merged.set(key, { ...g, dimensions, unpricedCostNames: [...g.unpricedCostNames] });
      continue;
    }
    for (const f of MONEY_FIELDS) existing[f] = new Decimal(existing[f]).plus(g[f]).toFixed(10);
    existing.unpricedCostNames = [...new Set([...existing.unpricedCostNames, ...g.unpricedCostNames])].sort();
  }
  return [...merged.values()].sort((a, b) => new Decimal(b.totalCostInUsdCents).cmp(a.totalCostInUsdCents));
}

/**
 * GET /internal/stats/costs/vendor — the UNDATED grouped cost aggregation
 * (GET /v1/stats/costs, GET /v1/stats/public/costs) on the VENDOR-COST basis:
 * per group, what the committed cost rows cost us from the vendor before our
 * markup, and SEPARATELY the billed amount of rows whose vendor cost is unknown.
 *
 * Same pricing rule, same status handling and same response vocabulary as
 * GET /internal/stats/costs/timeseries/vendor. `orgId` absent = the whole fleet.
 *
 * Service-auth only — the vendor cost reveals our margin.
 */
router.get("/internal/stats/costs/vendor", requireInternalAuth, async (req, res) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    if (!q.groupBy) {
      res.status(400).json({ error: "groupBy is required" });
      return;
    }
    const groupByKeys = [...new Set(q.groupBy.split(",").map((s) => s.trim()).filter(Boolean))];
    const invalid = groupByKeys.filter((k) => !VENDOR_GROUP_BY_KEYS.includes(k));
    if (groupByKeys.length === 0 || invalid.length > 0) {
      res.status(400).json({ error: `Invalid groupBy values: ${invalid.join(", ")}. Allowed: ${VENDOR_GROUP_BY_KEYS.join(", ")}` });
      return;
    }
    if (groupByKeys.includes("workflowDynastySlug") && groupByKeys.includes("workflowSlug")) {
      res.status(400).json({ error: "groupBy cannot name both workflowSlug and workflowDynastySlug" });
      return;
    }
    if (q.costSource && !(PUBLIC_COST_SOURCES as readonly string[]).includes(q.costSource)) {
      res.status(400).json({ error: `Invalid costSource value. Allowed: ${PUBLIC_COST_SOURCES.join(", ")}` });
      return;
    }
    const parsedCampaignIds = parseCampaignIds(q.campaignIds);
    if (parsedCampaignIds.error) {
      res.status(400).json({ error: parsedCampaignIds.error });
      return;
    }

    const identity: IdentityHeaders = {
      orgId: (req.headers["x-org-id"] as string) ?? q.orgId,
      userId: req.headers["x-user-id"] as string,
      runId: req.headers["x-run-id"] as string,
    };

    // Workflow filter: resolved dynasty > comma-separated list > single slug.
    let workflowSlugs: string[] | undefined;
    if (q.workflowDynastySlug) {
      const resolved = await resolveWorkflowDynastySlugs(q.workflowDynastySlug, identity);
      if (resolved.length === 0) {
        res.json({ groups: [] });
        return;
      }
      workflowSlugs = resolved;
    } else if (q.workflowSlugs) {
      workflowSlugs = parseCsv(q.workflowSlugs);
    } else if (q.workflowSlug) {
      workflowSlugs = [q.workflowSlug];
    }

    const publicFilter = buildPublicFilterSql({
      orgId: q.orgId,
      brandId: q.brandId,
      campaignId: q.campaignId,
      campaignIds: parsedCampaignIds.ids,
      featureSlug: q.featureSlug,
      featureSlugs: parseCsv(q.featureSlugs),
      workflowSlugs,
      taskName: q.taskName,
      startedAfter: q.startedAfter,
      startedBefore: q.startedBefore,
    });
    const parts = [
      // Committed + refunded only. A cancelled row is in no figure of this read.
      sql`rc.status IN ('actual','provisioned','refunded')`,
    ];
    if (publicFilter) parts.push(publicFilter);
    if (q.serviceName) parts.push(sql`r.service_name = ${q.serviceName}`);
    if (q.audienceId) parts.push(sql`COALESCE(rc.audience_id, r.audience_id) = ${q.audienceId}`);
    const whereSql = parts.reduce((acc, p) => sql`${acc} AND ${p}`);

    const sqlKeys = [...new Set(groupByKeys.map((k) => (k === "workflowDynastySlug" ? "workflowSlug" : k)))];
    const dimSelect = sql.raw(sqlKeys.map((k, i) => `${VENDOR_GROUP_BY_COLUMNS[k]} AS d${i}`).join(", "));
    const dimRefs = sql.raw(sqlKeys.map((_, i) => `d${i}`).join(", "));
    const groupRefs = sql.raw(sqlKeys.map((_, i) => `${i + 1}`).join(", "));

    const versions = await fetchVendorCostCatalog();

    const rows = (await db.execute(sql`
      -- MATERIALIZED for the same reason as the timeseries twin: inlined, the
      -- planner rebuilds the version windows (or their hash) once per row.
      WITH v AS MATERIALIZED (${versionWindowsSql(versions)}),
      base AS MATERIALIZED (
        SELECT
          ${dimSelect},
          rc.status,
          rc.cost_name,
          rc.unit_cost_in_usd_cents,
          rc.created_at,
          rc.quantity,
          rc.total_cost_in_usd_cents
        FROM runs r
        INNER JOIN runs_costs rc ON rc.run_id = r.id ${costSourceJoinSql(q.costSource)}
        WHERE ${whereSql}
      ),
      costed AS (
        SELECT
          ${dimRefs},
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
        ${dimRefs},
        ${sumsSql()},
        COALESCE(
          array_agg(DISTINCT cost_name ORDER BY cost_name)
            FILTER (WHERE status IN ('actual','provisioned') AND NOT priced),
          '{}'
        ) AS unpriced_cost_names
      FROM costed
      GROUP BY ${groupRefs}
    `)) as any[];

    let groups: VendorGroup[] = rows.map((row) => {
      const dimensions: Record<string, string | null> = {};
      sqlKeys.forEach((k, i) => {
        dimensions[k] = (row[`d${i}`] as string | null) ?? null;
      });
      return {
        dimensions,
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
      };
    });

    if (groupByKeys.includes("workflowDynastySlug")) {
      const slugMap = buildSlugToDynastyMap(await fetchAllWorkflowDynasties(identity));
      groups = regroupVendorByDynasty(groups, slugMap);
    } else {
      groups.sort((a, b) => new Decimal(b.totalCostInUsdCents).cmp(a.totalCostInUsdCents));
    }

    res.json({ groups });
  } catch (err) {
    console.error("[Runs Service] Error in GET /internal/stats/costs/vendor:", err);
    if (err instanceof VendorCostCatalogError) {
      res.status(502).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
