import { Router } from "express";
import { sql, type SQL } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { statsDb as db } from "../db/index.js";
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
import { isStatsRollupReady } from "../services/stats-rollup.js";
import { COST_DAY_ROLLUP_NAME } from "../services/stats-rollup-cost-day.js";

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
      provider: v.provider,
    }));
  return sql`
    SELECT x.cost_name, x.billed, x.vendor, x.provider, x.served_from AS valid_from,
           LEAD(x.served_from) OVER (PARTITION BY x.cost_name, x.billed ORDER BY x.served_from) AS valid_to
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      AS x(cost_name text, billed numeric, vendor numeric, served_from timestamptz, provider text)
  `;
}

const STATUSES = {
  total: sql`status IN ('actual','provisioned')`,
  actual: sql`status = 'actual'`,
  provisioned: sql`status = 'provisioned'`,
  refunded: sql`status = 'refunded'`,
} as const;

/** Billed / vendor / unpriced sums per status. `scope` narrows the rows summed; `prefix` names the columns. */
function sumsSql(scope = sql`TRUE`, prefix = "") {
  return sql.join(
    (Object.keys(STATUSES) as Array<keyof typeof STATUSES>).map((k) => {
      const pred = sql`(${STATUSES[k]}) AND (${scope})`;
      return sql`
        COALESCE(SUM(CASE WHEN ${pred} THEN billed_total ELSE 0 END), 0)::text AS ${sql.raw(`${prefix}billed_${k}`)},
        COALESCE(SUM(CASE WHEN ${pred} AND priced THEN vendor_total ELSE 0 END), 0)::text AS ${sql.raw(`${prefix}vendor_${k}`)},
        COALESCE(SUM(CASE WHEN ${pred} AND NOT priced THEN billed_total ELSE 0 END), 0)::text AS ${sql.raw(`${prefix}unpriced_${k}`)}`;
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
 * parameters, same runs, same order, same page) with each run's cost also
 * stated on the VENDOR-COST basis — its own rows (`vendorOwn*`) and its whole
 * subtree (`total*` billed, `vendorTotal*`, as GET /v1/runs/:id's total): what
 * they cost us from the vendor, before our markup, priced as the timeseries above.
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
        -- Bounded to the page's runs and their descendants (idx_runs_parent), as
        -- GET /v1/runs/:id. An execute-workflow run has no cost rows of its own:
        -- what it cost is its subtree, so both the own and the subtree figures
        -- are served.
        WITH RECURSIVE descendants AS (
          SELECT id, id AS root_run_id FROM runs
          WHERE id = ANY(string_to_array(${ids.join(",")}, ',')::uuid[])
          UNION ALL
          SELECT r.id, d.root_run_id FROM runs r INNER JOIN descendants d ON r.parent_run_id = d.id
        ),
        v AS MATERIALIZED (${versionWindowsSql(versions)}),
        costed AS (
          SELECT
            d.root_run_id,
            (rc.run_id = d.root_run_id) AS own,
            rc.status,
            rc.cost_name,
            rc.total_cost_in_usd_cents AS billed_total,
            rc.quantity * v.vendor AS vendor_total,
            (v.vendor IS NOT NULL) AS priced
          FROM descendants d
          -- Per-run LATERAL, as GET /v1/runs?include=subtreeCost: a plain JOIN
          -- makes the planner trust the recursive CTE's estimate and hash-join a
          -- seq scan of the whole ledger (~1.3 s a 20-run page). OFFSET 0 keeps
          -- Postgres from flattening the subquery back into that join, so each
          -- run is looked up on its run_id index.
          CROSS JOIN LATERAL (
            SELECT rc.run_id, rc.status, rc.cost_name, rc.total_cost_in_usd_cents,
                   rc.quantity, rc.unit_cost_in_usd_cents, rc.created_at
            FROM runs_costs rc WHERE rc.run_id = d.id
            OFFSET 0
          ) rc
          LEFT JOIN v
            ON v.cost_name = rc.cost_name
           AND v.billed = rc.unit_cost_in_usd_cents
           AND rc.created_at >= v.valid_from
           AND (v.valid_to IS NULL OR rc.created_at < v.valid_to)
        )
        SELECT
          root_run_id,
          ${sumsSql()},
          ${sumsSql(sql`own`, "own_")},
          COALESCE(
            array_agg(DISTINCT cost_name ORDER BY cost_name)
              FILTER (WHERE status IN ('actual','provisioned') AND NOT priced),
            '{}'
          ) AS unpriced_cost_names,
          COALESCE(
            array_agg(DISTINCT cost_name ORDER BY cost_name)
              FILTER (WHERE own AND status IN ('actual','provisioned') AND NOT priced),
            '{}'
          ) AS own_unpriced_cost_names
        FROM costed
        GROUP BY root_run_id
      `)) as any[];
      for (const row of rows) vendorByRun.set(row.root_run_id as string, row);
    }

    // A run whose subtree has no cost rows has no row here; its billed cost is 0 too.
    const zero = "0";
    const formattedRuns = result.map((r) => {
      const v = vendorByRun.get(r.id);
      return {
        ...r,
        ownCostInUsdCents: fixed(r.ownCostInUsdCents),
        ownActualCostInUsdCents: fixed(r.ownActualCostInUsdCents),
        ownProvisionedCostInUsdCents: fixed(r.ownProvisionedCostInUsdCents),
        vendorOwnCostInUsdCents: fixed(v?.own_vendor_total ?? zero),
        vendorOwnActualCostInUsdCents: fixed(v?.own_vendor_actual ?? zero),
        vendorOwnProvisionedCostInUsdCents: fixed(v?.own_vendor_provisioned ?? zero),
        unpricedOwnCostInUsdCents: fixed(v?.own_unpriced_total ?? zero),
        unpricedOwnActualCostInUsdCents: fixed(v?.own_unpriced_actual ?? zero),
        unpricedOwnProvisionedCostInUsdCents: fixed(v?.own_unpriced_provisioned ?? zero),
        unpricedOwnCostNames: (v?.own_unpriced_cost_names as string[] | undefined) ?? [],
        totalCostInUsdCents: fixed(v?.billed_total ?? zero),
        actualCostInUsdCents: fixed(v?.billed_actual ?? zero),
        provisionedCostInUsdCents: fixed(v?.billed_provisioned ?? zero),
        vendorTotalCostInUsdCents: fixed(v?.vendor_total ?? zero),
        vendorActualCostInUsdCents: fixed(v?.vendor_actual ?? zero),
        vendorProvisionedCostInUsdCents: fixed(v?.vendor_provisioned ?? zero),
        unpricedTotalCostInUsdCents: fixed(v?.unpriced_total ?? zero),
        unpricedActualCostInUsdCents: fixed(v?.unpriced_actual ?? zero),
        unpricedProvisionedCostInUsdCents: fixed(v?.unpriced_provisioned ?? zero),
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

// --- Margin by provider and cost item ---

/**
 * Which vendor a cost row's spend went to, per cost NAME and point in time: the
 * provider of the name's version being served when the row was written,
 * regardless of billed price. Used for rows that match no priced version (an
 * unknown or retired billed price) — a priced row takes its MATCHED version's
 * provider. The name's first window is open to -infinity so a row written before
 * the catalogue's first version of its name still lands on that name's provider.
 * Ties on served_from collapse to empty windows, so a row matches one window.
 */
function providerWindowsSql(versions: VendorCostVersion[]) {
  const rows = versions.map((v) => ({ cost_name: v.costName, provider: v.provider, served_from: v.servedFrom }));
  return sql`
    SELECT x.cost_name, x.provider,
           CASE WHEN ROW_NUMBER() OVER w = 1 THEN '-infinity'::timestamptz ELSE x.served_from END AS valid_from,
           LEAD(x.served_from) OVER w AS valid_to
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      AS x(cost_name text, provider text, served_from timestamptz)
    WINDOW w AS (PARTITION BY x.cost_name ORDER BY x.served_from)
  `;
}

/**
 * Served-from instants of every catalogue version, per cost name: the only points
 * in time where a cost row's vendor price or provider can change (the edges of
 * versionWindowsSql and providerWindowsSql).
 */
function servedFromEdgesSql(versions: VendorCostVersion[]) {
  const rows = versions.map((v) => ({ cost_name: v.costName, served_from: v.servedFrom }));
  return sql`
    SELECT DISTINCT x.cost_name, x.served_from AS at
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(cost_name text, served_from timestamptz)
  `;
}

/**
 * The rows the margin reads price — PLATFORM rows that were charged ('actual') or
 * refunded — as (status, cost_name, unit_cost_in_usd_cents, created_at, quantity,
 * gross, net).
 *
 * Live: one row per ledger row. From the (org, cost name, billed price, status,
 * UTC day) rollup (migration 0040): one row per group, carrying its summed
 * quantity / gross / net at its earliest created_at. That prices exactly like its
 * ledger rows whenever no served-from instant of the name falls in the group's
 * (min, max] created_at: every row is then on the same side of every window edge
 * as the earliest one, and Σ(quantity × vendor) = Σquantity × vendor in numeric.
 * A group that straddles an instant is read row by row from the ledger.
 */
function marginBaseSql(versions: VendorCostVersion[], orgId: string | undefined, fromRollup: boolean) {
  if (!fromRollup) {
    // runs_costs.organization_id is the RUN's org frozen at write (migration 0029).
    const orgSql = orgId ? sql`AND rc.organization_id = ${orgId}::uuid` : sql``;
    return sql`
      base AS MATERIALIZED (
        SELECT rc.status, rc.cost_name, rc.unit_cost_in_usd_cents, rc.created_at, rc.quantity,
               rc.total_cost_in_usd_cents AS gross,
               COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) AS net
        FROM runs_costs rc
        WHERE rc.cost_source = 'platform' AND rc.status IN ('actual','refunded') ${orgSql}
      )`;
  }
  const orgSql = orgId ? sql`AND d.organization_id = ${orgId}::uuid` : sql``;
  return sql`
      e AS MATERIALIZED (${servedFromEdgesSql(versions)}),
      g AS MATERIALIZED (
        SELECT d.*,
               EXISTS (
                 SELECT 1 FROM e
                 WHERE e.cost_name = d.cost_name AND e.at > d.min_created_at AND e.at <= d.max_created_at
               ) AS split
        FROM stats_rollup_cost_day d
        WHERE d.n > 0 ${orgSql}
      ),
      base AS MATERIALIZED (
        SELECT g.status, g.cost_name, g.unit_cost_in_usd_cents, g.min_created_at AS created_at,
               g.quantity, g.gross, g.net
        FROM g
        WHERE NOT g.split
        UNION ALL
        SELECT rc.status, rc.cost_name, rc.unit_cost_in_usd_cents, rc.created_at, rc.quantity,
               rc.total_cost_in_usd_cents AS gross,
               COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) AS net
        FROM g
        JOIN runs_costs rc
          ON rc.cost_name = g.cost_name
         AND rc.created_at >= g.min_created_at AND rc.created_at <= g.max_created_at
         AND rc.unit_cost_in_usd_cents = g.unit_cost_in_usd_cents
         AND rc.status = g.status
         AND rc.organization_id IS NOT DISTINCT FROM g.organization_id
        WHERE g.split AND rc.cost_source = 'platform' AND rc.status IN ('actual','refunded')
      )`;
}

/**
 * The margin reads' row set as CTEs ending in `costed`: PLATFORM rows that were
 * charged ('actual') or refunded, each with its provider, gross/net, vendor cost
 * and whether it is priced. Shared by the since-inception margin and its monthly
 * series so both attribute every row to the same provider on the same basis.
 */
function marginCostedCtesSql(versions: VendorCostVersion[], orgId: string | undefined, fromRollup: boolean) {
  return sql`
      WITH v AS MATERIALIZED (${versionWindowsSql(versions)}),
      pw AS MATERIALIZED (${providerWindowsSql(versions)}),
      ${marginBaseSql(versions, orgId, fromRollup)},
      costed AS (
        SELECT
          COALESCE(v.provider, pw.provider) AS provider,
          b.cost_name,
          b.status,
          b.created_at,
          b.gross,
          b.net,
          b.quantity * v.vendor AS vendor,
          (v.vendor IS NOT NULL) AS priced
        FROM base b
        LEFT JOIN v
          ON v.cost_name = b.cost_name
         AND v.billed = b.unit_cost_in_usd_cents
         AND b.created_at >= v.valid_from
         AND (v.valid_to IS NULL OR b.created_at < v.valid_to)
        LEFT JOIN pw
          ON pw.cost_name = b.cost_name
         AND b.created_at >= pw.valid_from
         AND (pw.valid_to IS NULL OR b.created_at < pw.valid_to)
      )`;
}

/** Money fields of one margin row, all computed in Postgres and served as 10-decimal strings. */
const MARGIN_MONEY_FIELDS = {
  billedCostInUsdCents: "billed",
  netBilledCostInUsdCents: "net_billed",
  pricedBilledCostInUsdCents: "priced",
  netPricedBilledCostInUsdCents: "net_priced",
  vendorCostInUsdCents: "vendor",
  marginCostInUsdCents: "margin",
  netMarginCostInUsdCents: "net_margin",
  unpricedBilledCostInUsdCents: "unpriced",
  netUnpricedBilledCostInUsdCents: "net_unpriced",
  refundedCostInUsdCents: "refunded",
  vendorRefundedCostInUsdCents: "vendor_refunded",
  unpricedRefundedCostInUsdCents: "unpriced_refunded",
} as const;

function marginRow(row: any) {
  const out: Record<string, string | string[]> = {};
  for (const [field, col] of Object.entries(MARGIN_MONEY_FIELDS)) out[field] = row[col] as string;
  out.unpricedCostNames = row.unpriced_cost_names as string[];
  return out;
}

/**
 * GET /internal/stats/costs/margin — PLATFORM-billed spend, fleet-wide (or one
 * org), since inception: per provider, per (provider, cost item) and in total,
 * what we billed (gross, and net of the per-org usage discount frozen on each
 * row), what the vendor charged us for it, and the margin.
 *
 * - Billed = CHARGED rows (status 'actual', cost_source 'platform'). Holds
 *   (provisioned), cancels and BYOK rows are in no figure. Refunded rows — spend
 *   that happened and that we did not charge — are stated apart (refunded*),
 *   never folded into billed or margin.
 * - A row is PRICED when costs-service states a vendor cost for the version it
 *   froze (same matching as the other vendor-basis reads). Margin covers priced
 *   rows only: margin + vendor == pricedBilled, exactly (net: netMargin + vendor
 *   == netPricedBilled). An unpriced row's billed amount goes to unpriced*, never
 *   into margin at zero vendor cost. billed == pricedBilled + unpricedBilled.
 * - Provider = the matched version's provider; for an unpriced row, the provider
 *   of the name's version served when the row was written; null when costs-service
 *   has never listed the name.
 *
 * Service-auth only — the vendor cost reveals our margin.
 */
router.get("/internal/stats/costs/margin", requireInternalAuth, async (req, res) => {
  try {
    const orgId = req.query.orgId;
    if (orgId !== undefined && (typeof orgId !== "string" || !UUID_RE.test(orgId))) {
      res.status(400).json({ error: "orgId must be a valid UUID" });
      return;
    }
    const versions = await fetchVendorCostCatalog();
    const fromRollup = await isStatsRollupReady(COST_DAY_ROLLUP_NAME);

    const rows = (await db.execute(sql`
      ${marginCostedCtesSql(versions, orgId, fromRollup)},
      sums AS (
        SELECT
          provider,
          cost_name,
          GROUPING(provider, cost_name) AS lvl,
          COALESCE(SUM(gross) FILTER (WHERE status = 'actual'), 0) AS billed,
          COALESCE(SUM(net) FILTER (WHERE status = 'actual'), 0) AS net_billed,
          COALESCE(SUM(gross) FILTER (WHERE status = 'actual' AND priced), 0) AS priced,
          COALESCE(SUM(net) FILTER (WHERE status = 'actual' AND priced), 0) AS net_priced,
          round(COALESCE(SUM(vendor) FILTER (WHERE status = 'actual' AND priced), 0), 10) AS vendor,
          COALESCE(SUM(gross) FILTER (WHERE status = 'actual' AND NOT priced), 0) AS unpriced,
          COALESCE(SUM(net) FILTER (WHERE status = 'actual' AND NOT priced), 0) AS net_unpriced,
          COALESCE(SUM(gross) FILTER (WHERE status = 'refunded'), 0) AS refunded,
          round(COALESCE(SUM(vendor) FILTER (WHERE status = 'refunded' AND priced), 0), 10) AS vendor_refunded,
          COALESCE(SUM(gross) FILTER (WHERE status = 'refunded' AND NOT priced), 0) AS unpriced_refunded,
          COALESCE(array_agg(DISTINCT cost_name ORDER BY cost_name) FILTER (WHERE NOT priced), '{}') AS unpriced_cost_names
        FROM costed
        GROUP BY GROUPING SETS ((provider, cost_name), (provider), ())
      )
      SELECT
        provider, cost_name, lvl,
        round(billed, 10)::text AS billed,
        round(net_billed, 10)::text AS net_billed,
        round(priced, 10)::text AS priced,
        round(net_priced, 10)::text AS net_priced,
        vendor::text AS vendor,
        (round(priced, 10) - vendor)::text AS margin,
        (round(net_priced, 10) - vendor)::text AS net_margin,
        round(unpriced, 10)::text AS unpriced,
        round(net_unpriced, 10)::text AS net_unpriced,
        round(refunded, 10)::text AS refunded,
        vendor_refunded::text AS vendor_refunded,
        round(unpriced_refunded, 10)::text AS unpriced_refunded,
        unpriced_cost_names
      FROM sums
      -- an expression binds to the numeric input column, not the text output alias
      ORDER BY lvl DESC, round(billed, 10) DESC, provider NULLS LAST, cost_name
    `)) as any[];

    const totalRow = rows.find((r) => Number(r.lvl) === 3);
    const providers = rows.filter((r) => Number(r.lvl) === 1).map((r) => ({ provider: (r.provider as string | null) ?? null, ...marginRow(r) }));
    const costItems = rows
      .filter((r) => Number(r.lvl) === 0)
      .map((r) => ({ provider: (r.provider as string | null) ?? null, costName: r.cost_name as string, ...marginRow(r) }));
    // GROUPING SETS always yields the () row, even over zero input rows.
    res.json({ total: marginRow(totalRow), providers, costItems });
  } catch (err) {
    console.error("[Runs Service] Error in GET /internal/stats/costs/margin:", err);
    if (err instanceof VendorCostCatalogError) {
      res.status(502).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /internal/stats/costs/margin/timeseries — the margin read above, split by
 * provider and by UTC calendar MONTH of the cost row's created_at (when the money
 * was charged), since the first row in scope through the current month.
 *
 * Same rows, same provider attribution, same figures as the margin read, so for
 * every provider the sum of its months equals its row there, field by field and
 * to the 1e-10 cent. The vendor cost is unrounded per row (quantity x vendor
 * unit) and the margin read rounds the provider's lifetime SUM to 10 decimals;
 * rounding each month alone would drift from it. So a month's vendor figure is
 * round(running SUM through it) - round(running SUM before it): the months
 * telescope to the rounded total exactly, and each one is within 1e-10 of its
 * own unrounded sum. Billed gross/net are scale 10 per row and sum exactly.
 *
 * Every provider carries every period (zeros where it had no row), oldest first;
 * the current month is `complete: false`. Providers ordered as the margin read.
 *
 * Service-auth only — the vendor cost reveals our margin.
 */
router.get("/internal/stats/costs/margin/timeseries", requireInternalAuth, async (req, res) => {
  try {
    const orgId = req.query.orgId;
    if (orgId !== undefined && (typeof orgId !== "string" || !UUID_RE.test(orgId))) {
      res.status(400).json({ error: "orgId must be a valid UUID" });
      return;
    }
    const versions = await fetchVendorCostCatalog();
    const fromRollup = await isStatsRollupReady(COST_DAY_ROLLUP_NAME);

    const rows = (await db.execute(sql`
      ${marginCostedCtesSql(versions, orgId, fromRollup)},
      monthly AS (
        SELECT
          provider,
          date_trunc('month', created_at AT TIME ZONE 'UTC')::date AS month,
          COALESCE(SUM(gross) FILTER (WHERE status = 'actual'), 0) AS billed,
          COALESCE(SUM(net) FILTER (WHERE status = 'actual'), 0) AS net_billed,
          COALESCE(SUM(gross) FILTER (WHERE status = 'actual' AND priced), 0) AS priced,
          COALESCE(SUM(net) FILTER (WHERE status = 'actual' AND priced), 0) AS net_priced,
          COALESCE(SUM(vendor) FILTER (WHERE status = 'actual' AND priced), 0) AS vendor_raw,
          COALESCE(SUM(gross) FILTER (WHERE status = 'actual' AND NOT priced), 0) AS unpriced,
          COALESCE(SUM(net) FILTER (WHERE status = 'actual' AND NOT priced), 0) AS net_unpriced,
          COALESCE(SUM(gross) FILTER (WHERE status = 'refunded'), 0) AS refunded,
          COALESCE(SUM(vendor) FILTER (WHERE status = 'refunded' AND priced), 0) AS vendor_refunded_raw,
          COALESCE(SUM(gross) FILTER (WHERE status = 'refunded' AND NOT priced), 0) AS unpriced_refunded,
          COALESCE(array_agg(DISTINCT cost_name ORDER BY cost_name) FILTER (WHERE NOT priced), '{}') AS unpriced_cost_names
        FROM costed
        GROUP BY 1, 2
      ),
      running AS (
        SELECT m.*,
               round(SUM(vendor_raw) OVER w, 10) AS vendor_cum,
               round(SUM(vendor_refunded_raw) OVER w, 10) AS vendor_refunded_cum,
               SUM(billed) OVER (PARTITION BY provider) AS provider_billed
        FROM monthly m
        WINDOW w AS (PARTITION BY provider ORDER BY month)
      ),
      telescoped AS (
        SELECT r.*,
               vendor_cum - COALESCE(LAG(vendor_cum) OVER w, 0) AS vendor,
               vendor_refunded_cum - COALESCE(LAG(vendor_refunded_cum) OVER w, 0) AS vendor_refunded
        FROM running r
        WINDOW w AS (PARTITION BY provider ORDER BY month)
      )
      SELECT
        provider,
        to_char(month, 'YYYY-MM-DD') AS period,
        round(billed, 10)::text AS billed,
        round(net_billed, 10)::text AS net_billed,
        round(priced, 10)::text AS priced,
        round(net_priced, 10)::text AS net_priced,
        vendor::text AS vendor,
        (round(priced, 10) - vendor)::text AS margin,
        (round(net_priced, 10) - vendor)::text AS net_margin,
        round(unpriced, 10)::text AS unpriced,
        round(net_unpriced, 10)::text AS net_unpriced,
        round(refunded, 10)::text AS refunded,
        vendor_refunded::text AS vendor_refunded,
        round(unpriced_refunded, 10)::text AS unpriced_refunded,
        unpriced_cost_names
      FROM telescoped
      ORDER BY round(provider_billed, 10) DESC, provider NULLS LAST, month
    `)) as any[];

    const nowMonth = new Date().toISOString().slice(0, 7) + "-01";
    // Dense calendar: first month in scope through the current UTC month.
    const periods: string[] = [];
    if (rows.length > 0) {
      const first = rows.reduce((min, r) => (r.period < min ? (r.period as string) : min), nowMonth);
      for (let d = new Date(`${first}T00:00:00Z`); ; d.setUTCMonth(d.getUTCMonth() + 1)) {
        const p = d.toISOString().slice(0, 10);
        if (p > nowMonth) break;
        periods.push(p);
      }
    }

    const zeroRow = marginRow(
      Object.fromEntries([...Object.values(MARGIN_MONEY_FIELDS).map((c) => [c, "0.0000000000"]), ["unpriced_cost_names", []]]),
    );
    const byProvider = new Map<string | null, Map<string, any>>();
    for (const r of rows) {
      const provider = (r.provider as string | null) ?? null;
      if (!byProvider.has(provider)) byProvider.set(provider, new Map());
      byProvider.get(provider)!.set(r.period as string, r);
    }
    const providers = [...byProvider].map(([provider, months]) => ({
      provider,
      buckets: periods.map((period) => {
        const r = months.get(period);
        return { period, complete: period < nowMonth, ...(r ? marginRow(r) : zeroRow) };
      }),
    }));

    res.json({ interval: "month", timezone: "UTC", periods, providers });
  } catch (err) {
    console.error("[Runs Service] Error in GET /internal/stats/costs/margin/timeseries:", err);
    if (err instanceof VendorCostCatalogError) {
      res.status(502).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Units consumed (and billed) per day, fleet-wide or per org / brand ---

const MAX_COST_NAMES = 500;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONSUMPTION_GROUP_BY = ["orgId", "brandId"] as const;
type ConsumptionGroupKey = (typeof CONSUMPTION_GROUP_BY)[number];

/** Figures of one consumption row: quantities scale 6, money scale 10, all decimal strings. */
const CONSUMPTION_FIELDS = {
  quantity: "quantity",
  refundedQuantity: "refunded_quantity",
  billedCostInUsdCents: "billed",
  netBilledCostInUsdCents: "net_billed",
  refundedCostInUsdCents: "refunded",
  netRefundedCostInUsdCents: "net_refunded",
} as const;
const CONSUMPTION_SCALE: Record<keyof typeof CONSUMPTION_FIELDS, number> = {
  quantity: 6,
  refundedQuantity: 6,
  billedCostInUsdCents: 10,
  netBilledCostInUsdCents: 10,
  refundedCostInUsdCents: 10,
  netRefundedCostInUsdCents: 10,
};

/**
 * GET /internal/stats/costs/consumption — QUANTITY consumed (and the money
 * billed for it) per UTC day of the cost row's created_at, per cost name and per
 * cost source, across every org (org-less platform runs included), or narrowed /
 * grouped by org and brand. costs-service divides what a vendor subscription cost
 * us by the units consumed through it, so the platform key ('platform') and a
 * customer's own key ('org') are kept apart, never merged.
 *
 * Counted rows = status 'actual' or 'refunded', the margin read's row set: a
 * refund is spend that happened at the vendor and that we did not charge, so the
 * unit was still consumed (refundedQuantity states that part, already inside
 * quantity). Money follows the margin read: billed = 'actual' rows (gross and net
 * of the usage discount frozen on the row), refunded stated apart. Holds
 * (provisioned) and cancels are in no figure.
 *
 * Org = the RUN's org frozen on the cost row (0029). Brand = the run's brand_ids;
 * grouped by brand, a co-branded run's row counts under EACH of its brands.
 *
 * Days are SPARSE. totals[] = per (group, name, source) sum of its days, exactly.
 */
router.get("/internal/stats/costs/consumption", requireInternalAuth, async (req, res) => {
  try {
    let names: string[] | undefined;
    if (req.query.costNames !== undefined) {
      if (typeof req.query.costNames !== "string") {
        res.status(400).json({ error: "costNames must be a comma-separated string" });
        return;
      }
      names = [...new Set(req.query.costNames.split(",").map((n) => n.trim()).filter(Boolean))];
      if (names.length === 0 || names.length > MAX_COST_NAMES) {
        res.status(400).json({ error: `costNames must list between 1 and ${MAX_COST_NAMES} cost names` });
        return;
      }
    }
    const since = req.query.since;
    if (since !== undefined && (typeof since !== "string" || !DAY_RE.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`)))) {
      res.status(400).json({ error: "since must be a YYYY-MM-DD day" });
      return;
    }
    const orgId = req.query.orgId;
    if (orgId !== undefined && (typeof orgId !== "string" || !UUID_RE.test(orgId))) {
      res.status(400).json({ error: "orgId must be a valid UUID" });
      return;
    }
    const brandId = req.query.brandId;
    if (brandId !== undefined && (typeof brandId !== "string" || brandId.trim() === "")) {
      res.status(400).json({ error: "brandId must be a non-empty string" });
      return;
    }
    let groupBy: ConsumptionGroupKey[] = [];
    if (req.query.groupBy !== undefined) {
      const keys = typeof req.query.groupBy === "string" ? [...new Set(req.query.groupBy.split(",").map((k) => k.trim()).filter(Boolean))] : [];
      if (keys.length === 0 || keys.some((k) => !(CONSUMPTION_GROUP_BY as readonly string[]).includes(k))) {
        res.status(400).json({ error: `groupBy must be a comma-separated subset of ${CONSUMPTION_GROUP_BY.join(", ")}` });
        return;
      }
      groupBy = CONSUMPTION_GROUP_BY.filter((k) => keys.includes(k));
    }
    const byOrg = groupBy.includes("orgId");
    const byBrand = groupBy.includes("brandId");

    const filters: SQL[] = [sql`rc.status IN ('actual','refunded')`];
    if (names) filters.push(sql`rc.cost_name IN (SELECT jsonb_array_elements_text(${JSON.stringify(names)}::jsonb))`);
    if (since) filters.push(sql`rc.created_at >= ${`${since}T00:00:00Z`}::timestamptz`);
    if (orgId) filters.push(sql`rc.organization_id = ${orgId}::uuid`);
    // `@>` (not `= ANY`) so the GIN idx_runs_brand_ids narrows runs to the brand's:
    // 0.65 s for the busiest org's top brand in prod instead of a seq scan of runs.
    if (brandId) filters.push(sql`r.brand_ids @> ARRAY[${brandId}]::text[]`);
    // A cost row's org IS its run's org (frozen at write, moved together by
    // transfer-brand), so stating it on runs too lets the join read only the org's
    // runs: busiest org grouped by brand, 25 s -> 4.4 s in prod.
    if (orgId && (byBrand || brandId)) filters.push(sql`r.organization_id = ${orgId}::uuid`);
    // The runs join is paid only when a brand is asked for. Grouped by brand, a
    // run with no brand lands in a NULL brand group (unnest of an empty array
    // would drop it, so it is coalesced to one NULL element).
    // With a brandId filter the only brand group is that brand: a co-branded run's
    // other brands were not asked for.
    const unnestBrands = byBrand && !brandId;
    const fromSql = unnestBrands
      ? sql`runs_costs rc JOIN runs r ON r.id = rc.run_id CROSS JOIN LATERAL unnest(COALESCE(NULLIF(r.brand_ids, '{}'), ARRAY[NULL]::text[])) AS b(brand_id)`
      : brandId
        ? sql`runs_costs rc JOIN runs r ON r.id = rc.run_id`
        : sql`runs_costs rc`;
    const orgCol = byOrg ? sql`rc.organization_id::text` : sql`NULL::text`;
    const brandCol = unnestBrands ? sql`b.brand_id` : byBrand ? sql`${brandId}::text` : sql`NULL::text`;

    const rows = (await db.execute(sql`
      SELECT
        ${orgCol} AS org_id,
        ${brandCol} AS brand_id,
        to_char((rc.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
        rc.cost_name,
        rc.cost_source,
        SUM(rc.quantity)::text AS quantity,
        COALESCE(SUM(rc.quantity) FILTER (WHERE rc.status = 'refunded'), 0)::text AS refunded_quantity,
        COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'actual'), 0)::text AS billed,
        COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'actual'), 0)::text AS net_billed,
        COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'refunded'), 0)::text AS refunded,
        COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'refunded'), 0)::text AS net_refunded
      FROM ${fromSql}
      WHERE ${sql.join(filters, sql` AND `)}
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY 3, 1 NULLS LAST, 2 NULLS LAST, 4, 5
    `)) as any[];

    const groupKeys = (r: { org_id: string | null; brand_id: string | null }) => ({
      ...(byOrg && { orgId: r.org_id ?? null }),
      ...(byBrand && { brandId: r.brand_id ?? null }),
    });
    // Totals summed in decimal.js from the same day rows (never Number on a quantity or a cost).
    const totals = new Map<string, { head: Record<string, unknown>; sort: string[]; sums: Record<string, Decimal> }>();
    const days = rows.map((r) => {
      const head = { ...groupKeys(r), costName: r.cost_name as string, costSource: r.cost_source as string };
      const key = JSON.stringify(head);
      const t = totals.get(key) ?? {
        head,
        sort: [r.org_id ?? "\uffff", r.brand_id ?? "\uffff", r.cost_name, r.cost_source],
        sums: Object.fromEntries(Object.keys(CONSUMPTION_FIELDS).map((f) => [f, new Decimal(0)])),
      };
      const figures: Record<string, string> = {};
      for (const [field, col] of Object.entries(CONSUMPTION_FIELDS) as [keyof typeof CONSUMPTION_FIELDS, string][]) {
        t.sums[field] = t.sums[field].plus(r[col] as string);
        figures[field] = new Decimal(r[col] as string).toFixed(CONSUMPTION_SCALE[field]);
      }
      totals.set(key, t);
      return { day: r.day as string, ...head, ...figures };
    });

    const cmp = (a: string[], b: string[]) => {
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
      return 0;
    };
    res.json({
      timezone: "UTC",
      since: since ?? null,
      statuses: ["actual", "refunded"],
      groupBy,
      days,
      totals: [...totals.values()]
        .sort((a, b) => cmp(a.sort, b.sort))
        .map((t) => ({
          ...t.head,
          ...Object.fromEntries(
            (Object.keys(CONSUMPTION_FIELDS) as (keyof typeof CONSUMPTION_FIELDS)[]).map((f) => [f, t.sums[f].toFixed(CONSUMPTION_SCALE[f])]),
          ),
        })),
    });
  } catch (err) {
    console.error("[Runs Service] Error in GET /internal/stats/costs/consumption:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
