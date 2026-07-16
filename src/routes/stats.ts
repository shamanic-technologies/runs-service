import { Router } from "express";
import { eq, sql, inArray } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { runs, runsCosts } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  BudgetRequestSchema,
  StatsCostsByServiceTasksRequestSchema,
} from "../schemas.js";
import {
  costAggregateSelectSql,
  costAggregateNetSelectSql,
  costAggregateWithSinceSql,
  costAggregateNetWithSinceSql,
  platformTotalSelectSql,
} from "../services/cost-aggregator.js";
import {
  resolveWorkflowDynastySlugs,
  fetchAllWorkflowDynasties,
  buildSlugToDynastyMap,
  type IdentityHeaders,
} from "../services/dynasty-resolver.js";

const router = Router();

// --- Validated allowlist for GROUP BY columns ---

// Maps groupBy keys to their SQL expression. For brandId we unnest the array.
const GROUP_BY_COLUMNS: Record<string, string> = {
  brandId: "unnest(r.brand_ids)",
  workflowSlug: "r.workflow_slug",
  campaignId: "r.campaign_id",
  featureSlug: "r.feature_slug",
  goal: "COALESCE(rc.goal, r.goal)",
  brandProfileId: "COALESCE(rc.brand_profile_id, r.brand_profile_id)",
  audienceId: "COALESCE(rc.audience_id, r.audience_id)",
  workflowContext: "COALESCE(rc.workflow_context, r.workflow_context)",
  serviceName: "r.service_name",
  taskName: "r.task_name",
  costName: "rc.cost_name",
};

const SELECT_COLUMNS: Record<string, string> = {
  goal: "COALESCE(rc.goal, r.goal) AS goal",
  brandProfileId: "COALESCE(rc.brand_profile_id, r.brand_profile_id) AS brand_profile_id",
  audienceId: "COALESCE(rc.audience_id, r.audience_id) AS audience_id",
  workflowContext: "COALESCE(rc.workflow_context, r.workflow_context) AS workflow_context",
};

// Maps groupBy keys to the result column name in the SQL result row.
const RESULT_COL_NAMES: Record<string, string> = {
  brandId: "unnest",
  workflowSlug: "workflow_slug",
  campaignId: "campaign_id",
  featureSlug: "feature_slug",
  goal: "goal",
  brandProfileId: "brand_profile_id",
  audienceId: "audience_id",
  workflowContext: "workflow_context",
  serviceName: "service_name",
  taskName: "task_name",
  costName: "cost_name",
};

// Dynasty groupBy keys map to their underlying DB column
const DYNASTY_GROUP_BY: Record<string, string> = {
  workflowDynastySlug: "r.workflow_slug",
};

const ALL_GROUP_BY_COLUMNS: Record<string, string> = {
  ...GROUP_BY_COLUMNS,
  ...DYNASTY_GROUP_BY,
};

// --- Helpers ---

function buildFilterSql(
  orgId: string,
  filters: {
    brandId?: string;
    campaignId?: string;
    workflowSlug?: string;
    workflowSlugs?: string[];
    featureSlug?: string;
    featureSlugs?: string[];
    goal?: string;
    brandProfileId?: string;
    audienceId?: string;
    workflowContext?: string;
    attributionStatus?: string;
    serviceName?: string;
    taskName?: string;
    startedAfter?: string;
    startedBefore?: string;
  }
) {
  const parts = [sql`r.organization_id = ${orgId}`];

  if (filters.brandId) parts.push(sql`${filters.brandId} = ANY(r.brand_ids)`);
  if (filters.campaignId) parts.push(sql`r.campaign_id = ${filters.campaignId}`);

  // Feature slug filtering: list takes precedence over singular
  if (filters.featureSlugs && filters.featureSlugs.length > 0) {
    parts.push(sql`r.feature_slug IN (${sql.join(filters.featureSlugs.map((n) => sql`${n}`), sql`, `)})`);
  } else if (filters.featureSlug) {
    parts.push(sql`r.feature_slug = ${filters.featureSlug}`);
  }

  if (filters.goal) parts.push(sql`COALESCE(rc.goal, r.goal) = ${filters.goal}`);
  if (filters.brandProfileId) parts.push(sql`COALESCE(rc.brand_profile_id, r.brand_profile_id) = ${filters.brandProfileId}`);
  if (filters.audienceId) parts.push(sql`COALESCE(rc.audience_id, r.audience_id) = ${filters.audienceId}`);
  if (filters.workflowContext) parts.push(sql`COALESCE(rc.workflow_context, r.workflow_context) = ${filters.workflowContext}`);
  if (filters.attributionStatus === "tagged") {
    parts.push(sql`(
      COALESCE(rc.brand_profile_id, r.brand_profile_id) IS NOT NULL
      OR COALESCE(rc.audience_id, r.audience_id) IS NOT NULL
    )`);
  } else if (filters.attributionStatus === "unattributed") {
    parts.push(sql`COALESCE(rc.brand_profile_id, r.brand_profile_id) IS NULL`);
    parts.push(sql`COALESCE(rc.audience_id, r.audience_id) IS NULL`);
  }

  // Workflow slug filtering: resolved dynasty slugs > comma-separated > single slug
  if (filters.workflowSlugs && filters.workflowSlugs.length > 0) {
    parts.push(sql`r.workflow_slug IN (${sql.join(filters.workflowSlugs.map((n) => sql`${n}`), sql`, `)})`);
  } else if (filters.workflowSlug) {
    parts.push(sql`r.workflow_slug = ${filters.workflowSlug}`);
  }

  if (filters.serviceName) parts.push(sql`r.service_name = ${filters.serviceName}`);
  if (filters.taskName) parts.push(sql`r.task_name = ${filters.taskName}`);
  if (filters.startedAfter) parts.push(sql`r.started_at >= ${filters.startedAfter}::timestamptz`);
  if (filters.startedBefore) parts.push(sql`r.started_at <= ${filters.startedBefore}::timestamptz`);

  return parts.reduce((acc, part) => sql`${acc} AND ${part}`);
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/** Resolve dynasty + multi-slug query params into arrays of versioned slugs */
async function resolveDynastyFilters(query: Record<string, string | undefined>, identity: IdentityHeaders): Promise<{
  workflowSlugs?: string[];
  featureSlugs?: string[];
  emptyResult: boolean;
}> {
  let workflowSlugs: string[] | undefined;
  let featureSlugs: string[] | undefined;
  let emptyResult = false;

  if (query.workflowDynastySlug) {
    const resolved = await resolveWorkflowDynastySlugs(query.workflowDynastySlug, identity);
    if (resolved.length === 0) {
      emptyResult = true;
    } else {
      workflowSlugs = resolved;
    }
  } else if (query.workflowSlugs) {
    workflowSlugs = parseCsv(query.workflowSlugs);
  }

  if (query.featureSlugs) {
    featureSlugs = parseCsv(query.featureSlugs);
  }

  return { workflowSlugs, featureSlugs, emptyResult };
}

const EMPTY_STATS_RESPONSE = { groups: [] };

interface AggRow {
  dimensions: Record<string, string | null>;
  totalCostInUsdCents: string;
  actualCostInUsdCents: string;
  provisionedCostInUsdCents: string;
  cancelledCostInUsdCents: string;
  // Frozen NET amounts (gross reduced by the per-cost frozen usage discount).
  // Present only on the per-attribution stats reads features-service consumes;
  // undefined elsewhere (public/gross-only reads). Gross fields above are
  // unchanged, so a reader that ignores these sees today's numbers exactly.
  netTotalCostInUsdCents?: string;
  netActualCostInUsdCents?: string;
  netProvisionedCostInUsdCents?: string;
  runCount: number;
  minStartedAt: string | null;
  maxStartedAt: string | null;
  totalQuantity?: string;
}

/**
 * Re-group rows by dynasty slug, merging rows whose underlying slug maps to the
 * same dynasty. The merge key is the FULL tuple of the OTHER groupBy dimensions
 * plus the dynasty — so a multi-dimension groupBy (e.g. audienceId,workflowDynastySlug)
 * yields one row per distinct (otherDim, dynasty) pair, applying the dynasty
 * rollup WITHIN each value of the other dimension rather than across the whole
 * result set. Keying on dynasty alone would collapse every row sharing a dynasty
 * into one, silently dropping the co-grouped dimension (runs-service#174).
 */
function regroupByDynasty(
  groups: AggRow[],
  dynastyKey: string,
  underlyingKey: string,
  slugToDynasty: Map<string, string>
): AggRow[] {
  const merged = new Map<string, AggRow>();

  for (const group of groups) {
    const rawSlug = group.dimensions[underlyingKey] ?? "";
    const dynasty = slugToDynasty.get(rawSlug) ?? rawSlug;

    // Merge key = every OTHER groupBy dimension (in sorted key order) + the
    // resolved dynasty. JSON-encode so null and distinct string values never
    // collide. This preserves the other dimensions instead of dropping them.
    const otherDims: Record<string, string | null> = {};
    for (const key of Object.keys(group.dimensions).sort()) {
      if (key === underlyingKey) continue;
      otherDims[key] = group.dimensions[key];
    }
    const mergeKey = JSON.stringify([otherDims, dynasty]);

    const existing = merged.get(mergeKey);
    if (!existing) {
      const newDimensions = { ...group.dimensions };
      delete newDimensions[underlyingKey];
      newDimensions[dynastyKey] = dynasty;
      merged.set(mergeKey, { ...group, dimensions: newDimensions });
    } else {
      existing.totalCostInUsdCents = new Decimal(existing.totalCostInUsdCents).plus(group.totalCostInUsdCents).toFixed(10);
      existing.actualCostInUsdCents = new Decimal(existing.actualCostInUsdCents).plus(group.actualCostInUsdCents).toFixed(10);
      existing.provisionedCostInUsdCents = new Decimal(existing.provisionedCostInUsdCents).plus(group.provisionedCostInUsdCents).toFixed(10);
      existing.cancelledCostInUsdCents = new Decimal(existing.cancelledCostInUsdCents).plus(group.cancelledCostInUsdCents).toFixed(10);
      if (existing.netTotalCostInUsdCents !== undefined && group.netTotalCostInUsdCents !== undefined) {
        existing.netTotalCostInUsdCents = new Decimal(existing.netTotalCostInUsdCents).plus(group.netTotalCostInUsdCents).toFixed(10);
        existing.netActualCostInUsdCents = new Decimal(existing.netActualCostInUsdCents!).plus(group.netActualCostInUsdCents!).toFixed(10);
        existing.netProvisionedCostInUsdCents = new Decimal(existing.netProvisionedCostInUsdCents!).plus(group.netProvisionedCostInUsdCents!).toFixed(10);
      }
      existing.runCount += group.runCount;

      if (group.minStartedAt && (!existing.minStartedAt || group.minStartedAt < existing.minStartedAt)) {
        existing.minStartedAt = group.minStartedAt;
      }
      if (group.maxStartedAt && (!existing.maxStartedAt || group.maxStartedAt > existing.maxStartedAt)) {
        existing.maxStartedAt = group.maxStartedAt;
      }
      if (existing.totalQuantity !== undefined && group.totalQuantity !== undefined) {
        existing.totalQuantity = new Decimal(existing.totalQuantity).plus(group.totalQuantity).toFixed(6);
      }
    }
  }

  return Array.from(merged.values()).sort(
    (a, b) => new Decimal(b.totalCostInUsdCents).cmp(a.totalCostInUsdCents)
  );
}

// GET /v1/stats/costs — aggregation with GROUP BY
router.get("/v1/stats/costs", requireApiKey, async (req, res) => {
  try {
    const {
      groupBy,
      brandId,
      campaignId,
      workflowSlug,
      workflowSlugs: workflowSlugsParam,
      workflowDynastySlug,
      featureSlug,
      featureSlugs: featureSlugsParam,
      goal,
      brandProfileId,
      audienceId,
      workflowContext,
      attributionStatus,
      serviceName,
      taskName,
      startedAfter,
      startedBefore,
    } = req.query as Record<string, string | undefined>;

    if (!groupBy) {
      res.status(400).json({ error: "groupBy is required" });
      return;
    }

    if (attributionStatus && !["all", "tagged", "unattributed"].includes(attributionStatus)) {
      res.status(400).json({ error: "Invalid attributionStatus. Allowed: all, tagged, unattributed" });
      return;
    }

    // Validate groupBy columns
    const groupByKeys = groupBy.split(",").map((s) => s.trim());
    const invalidKeys = groupByKeys.filter((k) => !ALL_GROUP_BY_COLUMNS[k]);
    if (invalidKeys.length > 0) {
      res.status(400).json({
        error: `Invalid groupBy values: ${invalidKeys.join(", ")}. Allowed: ${Object.keys(ALL_GROUP_BY_COLUMNS).join(", ")}`,
      });
      return;
    }

    // Resolve dynasty + multi-slug filters
    const identity: IdentityHeaders = { orgId: req.orgId, userId: req.userId, runId: req.runId };
    const dynastyFilters = await resolveDynastyFilters({
      workflowDynastySlug,
      workflowSlugs: workflowSlugsParam,
      featureSlugs: featureSlugsParam,
    }, identity);

    if (dynastyFilters.emptyResult) {
      res.json(EMPTY_STATS_RESPONSE);
      return;
    }

    // Determine which dynasty groupBy keys are present
    const hasDynastyWorkflowGroupBy = groupByKeys.includes("workflowDynastySlug");

    // Build actual SQL groupBy keys: replace dynasty keys with their underlying column
    const sqlGroupByKeys = groupByKeys.map((k) => k === "workflowDynastySlug" ? "workflowSlug" : k);
    const uniqueSqlGroupByKeys = [...new Set(sqlGroupByKeys)];

    const groupByCols = uniqueSqlGroupByKeys.map((k) => GROUP_BY_COLUMNS[k]);
    const selectCols = uniqueSqlGroupByKeys.map((k) => sql.raw(SELECT_COLUMNS[k] ?? GROUP_BY_COLUMNS[k]));
    const groupByClause = sql.raw(groupByCols.join(", "));
    const hasCostName = groupByKeys.includes("costName");

    const whereSql = buildFilterSql(req.orgId, {
      brandId,
      campaignId,
      workflowSlug,
      workflowSlugs: dynastyFilters.workflowSlugs,
      featureSlug,
      featureSlugs: dynastyFilters.featureSlugs,
      goal,
      brandProfileId,
      audienceId,
      workflowContext,
      attributionStatus,
      serviceName,
      taskName,
      startedAfter,
      startedBefore,
    });

    const joinType = hasCostName ? sql`INNER JOIN` : sql`LEFT JOIN`;
    const quantitySelect = hasCostName
      ? sql`, COALESCE(SUM(rc.quantity::numeric), 0) as total_quantity`
      : sql``;

    // Cost aggregation via cost-aggregator (atomic literals, doctrine-compliant).
    // Gross + frozen net (features-service reads GROSS or NET per-attribution).
    const result = await db.execute(sql`
      SELECT ${sql.join(selectCols, sql`, `)},
        ${costAggregateSelectSql("rc")},
        ${costAggregateNetSelectSql("rc")},
        COUNT(DISTINCT r.id) as run_count,
        MIN(r.started_at) as min_started_at,
        MAX(r.started_at) as max_started_at
        ${quantitySelect}
      FROM runs r
      ${joinType} runs_costs rc ON rc.run_id = r.id
      WHERE ${whereSql}
      GROUP BY ${groupByClause}
      ORDER BY total_cost DESC
    `);

    const rows = result as any[];

    let groups: AggRow[] = rows.map((row) => {
      const dimensions: Record<string, string | null> = {};
      for (const key of uniqueSqlGroupByKeys) {
        const resultCol = RESULT_COL_NAMES[key] ?? GROUP_BY_COLUMNS[key].replace(/^r\.|^rc\./, "");
        dimensions[key] = row[resultCol] ?? null;
      }
      const group: AggRow = {
        dimensions,
        totalCostInUsdCents: new Decimal(row.total_cost).toFixed(10),
        actualCostInUsdCents: new Decimal(row.actual_cost).toFixed(10),
        provisionedCostInUsdCents: new Decimal(row.provisioned_cost).toFixed(10),
        cancelledCostInUsdCents: new Decimal(row.cancelled_cost).toFixed(10),
        netTotalCostInUsdCents: new Decimal(row.net_total_cost).toFixed(10),
        netActualCostInUsdCents: new Decimal(row.net_actual_cost).toFixed(10),
        netProvisionedCostInUsdCents: new Decimal(row.net_provisioned_cost).toFixed(10),
        runCount: Number(row.run_count),
        minStartedAt: row.min_started_at ? new Date(row.min_started_at).toISOString() : null,
        maxStartedAt: row.max_started_at ? new Date(row.max_started_at).toISOString() : null,
      };
      if (hasCostName) {
        group.totalQuantity = new Decimal(row.total_quantity).toFixed(6);
      }
      return group;
    });

    // Post-process: re-group by dynasty if needed
    if (hasDynastyWorkflowGroupBy) {
      const dynasties = await fetchAllWorkflowDynasties(identity);
      const slugMap = buildSlugToDynastyMap(dynasties);
      groups = regroupByDynasty(groups, "workflowDynastySlug", "workflowSlug", slugMap);
    }

    res.json({ groups });
  } catch (err) {
    console.error("[Runs Service] Error in GET /v1/stats/costs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /v1/stats/costs — batched aggregation across multiple (serviceName, taskName) tuples in ONE SQL pass
router.post("/v1/stats/costs", requireApiKey, async (req, res) => {
  try {
    const parsed = StatsCostsByServiceTasksRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const {
      groupBy,
      brandId,
      campaignId,
      workflowSlug,
      workflowSlugs,
      featureSlug,
      featureSlugs,
      goal,
      brandProfileId,
      audienceId,
      workflowContext,
      attributionStatus,
      startedAfter,
      startedBefore,
      serviceTasks,
    } = parsed.data;

    const groupByKeys = groupBy.split(",").map((s) => s.trim());
    const invalidKeys = groupByKeys.filter((k) => !GROUP_BY_COLUMNS[k]);
    if (invalidKeys.length > 0) {
      res.status(400).json({
        error: `Invalid groupBy values: ${invalidKeys.join(", ")}. Allowed: ${Object.keys(GROUP_BY_COLUMNS).join(", ")}. Dynasty groupBy is not supported on POST /v1/stats/costs.`,
      });
      return;
    }
    if (attributionStatus && !["all", "tagged", "unattributed"].includes(attributionStatus)) {
      res.status(400).json({ error: "Invalid attributionStatus. Allowed: all, tagged, unattributed" });
      return;
    }

    // Discriminator dims = service_name + task_name, plus user-requested groupBy
    const userDimKeys = [...new Set(groupByKeys)];
    const allDimKeys = [...new Set(["serviceName", "taskName", ...userDimKeys])];
    const groupByCols = allDimKeys.map((k) => GROUP_BY_COLUMNS[k]);
    const selectCols = allDimKeys.map((k) => sql.raw(SELECT_COLUMNS[k] ?? GROUP_BY_COLUMNS[k]));
    const groupByClause = sql.raw(groupByCols.join(", "));
    const hasCostName = groupByKeys.includes("costName");

    const baseWhereParts = [sql`r.organization_id = ${req.orgId}`];
    if (brandId) baseWhereParts.push(sql`${brandId} = ANY(r.brand_ids)`);
    if (campaignId) baseWhereParts.push(sql`r.campaign_id = ${campaignId}`);
    if (featureSlugs && featureSlugs.length > 0) {
      baseWhereParts.push(sql`r.feature_slug IN (${sql.join(featureSlugs.map((n) => sql`${n}`), sql`, `)})`);
    } else if (featureSlug) {
      baseWhereParts.push(sql`r.feature_slug = ${featureSlug}`);
    }
    if (goal) baseWhereParts.push(sql`COALESCE(rc.goal, r.goal) = ${goal}`);
    if (brandProfileId) baseWhereParts.push(sql`COALESCE(rc.brand_profile_id, r.brand_profile_id) = ${brandProfileId}`);
    if (audienceId) baseWhereParts.push(sql`COALESCE(rc.audience_id, r.audience_id) = ${audienceId}`);
    if (workflowContext) baseWhereParts.push(sql`COALESCE(rc.workflow_context, r.workflow_context) = ${workflowContext}`);
    if (attributionStatus === "tagged") {
      baseWhereParts.push(sql`(
        COALESCE(rc.brand_profile_id, r.brand_profile_id) IS NOT NULL
        OR COALESCE(rc.audience_id, r.audience_id) IS NOT NULL
      )`);
    } else if (attributionStatus === "unattributed") {
      baseWhereParts.push(sql`COALESCE(rc.brand_profile_id, r.brand_profile_id) IS NULL`);
      baseWhereParts.push(sql`COALESCE(rc.audience_id, r.audience_id) IS NULL`);
    }
    if (workflowSlugs && workflowSlugs.length > 0) {
      baseWhereParts.push(sql`r.workflow_slug IN (${sql.join(workflowSlugs.map((n) => sql`${n}`), sql`, `)})`);
    } else if (workflowSlug) {
      baseWhereParts.push(sql`r.workflow_slug = ${workflowSlug}`);
    }
    if (startedAfter) baseWhereParts.push(sql`r.started_at >= ${startedAfter}::timestamptz`);
    if (startedBefore) baseWhereParts.push(sql`r.started_at <= ${startedBefore}::timestamptz`);

    const serviceTaskTuples = sql.join(
      serviceTasks.map((st) => sql`(${st.serviceName}, ${st.taskName})`),
      sql`, `
    );
    baseWhereParts.push(sql`(r.service_name, r.task_name) IN (${serviceTaskTuples})`);

    const whereSql = baseWhereParts.reduce((acc, part) => sql`${acc} AND ${part}`);

    const joinType = hasCostName ? sql`INNER JOIN` : sql`LEFT JOIN`;
    const quantitySelect = hasCostName
      ? sql`, COALESCE(SUM(rc.quantity::numeric), 0) as total_quantity`
      : sql``;

    // Cost aggregation via cost-aggregator (atomic literals, doctrine-compliant).
    // Gross + frozen net (features-service reads GROSS or NET per-attribution).
    const result = await db.execute(sql`
      SELECT ${sql.join(selectCols, sql`, `)},
        ${costAggregateSelectSql("rc")},
        ${costAggregateNetSelectSql("rc")},
        COUNT(DISTINCT r.id) as run_count,
        MIN(r.started_at) as min_started_at,
        MAX(r.started_at) as max_started_at
        ${quantitySelect}
      FROM runs r
      ${joinType} runs_costs rc ON rc.run_id = r.id
      WHERE ${whereSql}
      GROUP BY ${groupByClause}
      ORDER BY total_cost DESC
    `);

    const rows = result as any[];

    // Initialize buckets in input order so missing combos surface as empty groups
    const buckets = serviceTasks.map((st) => ({
      serviceName: st.serviceName,
      taskName: st.taskName,
      groups: [] as AggRow[],
    }));
    const bucketIndex = new Map<string, number>();
    serviceTasks.forEach((st, i) => bucketIndex.set(`${st.serviceName} ${st.taskName}`, i));

    for (const row of rows) {
      const key = `${row.service_name} ${row.task_name}`;
      const idx = bucketIndex.get(key);
      if (idx === undefined) continue;

      const dimensions: Record<string, string | null> = {};
      for (const k of userDimKeys) {
        const resultCol = RESULT_COL_NAMES[k] ?? GROUP_BY_COLUMNS[k].replace(/^r\.|^rc\./, "");
        dimensions[k] = row[resultCol] ?? null;
      }
      const group: AggRow = {
        dimensions,
        totalCostInUsdCents: new Decimal(row.total_cost).toFixed(10),
        actualCostInUsdCents: new Decimal(row.actual_cost).toFixed(10),
        provisionedCostInUsdCents: new Decimal(row.provisioned_cost).toFixed(10),
        cancelledCostInUsdCents: new Decimal(row.cancelled_cost).toFixed(10),
        netTotalCostInUsdCents: new Decimal(row.net_total_cost).toFixed(10),
        netActualCostInUsdCents: new Decimal(row.net_actual_cost).toFixed(10),
        netProvisionedCostInUsdCents: new Decimal(row.net_provisioned_cost).toFixed(10),
        runCount: Number(row.run_count),
        minStartedAt: row.min_started_at ? new Date(row.min_started_at).toISOString() : null,
        maxStartedAt: row.max_started_at ? new Date(row.max_started_at).toISOString() : null,
      };
      if (hasCostName) {
        group.totalQuantity = new Decimal(row.total_quantity).toFixed(6);
      }
      buckets[idx].groups.push(group);
    }

    res.json({ buckets });
  } catch (err) {
    console.error("[Runs Service] Error in POST /v1/stats/costs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /v1/stats/budget — temporal windows
router.post("/v1/stats/budget", requireApiKey, async (req, res) => {
  try {
    const parsed = BudgetRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { campaignId, brandId, workflowSlug, featureSlug, windows } = parsed.data;

    // Build base WHERE conditions
    const filterParts = [sql`r.organization_id = ${req.orgId}`];
    if (campaignId) filterParts.push(sql`r.campaign_id = ${campaignId}`);
    if (brandId) filterParts.push(sql`${brandId} = ANY(r.brand_ids)`);
    if (workflowSlug) filterParts.push(sql`r.workflow_slug = ${workflowSlug}`);
    if (featureSlug) filterParts.push(sql`r.feature_slug = ${featureSlug}`);

    const baseWhere = filterParts.reduce((acc, part) => sql`${acc} AND ${part}`);

    // Build per-window aggregations via cost-aggregator (atomic literals).
    // Gross window columns (unchanged) + frozen NET window columns so a consumer
    // can pace / display on what the org actually pays (post-usage-discount).
    const windowSelects = windows.flatMap((w, i) => {
      const sinceCondition = w.since
        ? sql`AND rc.created_at >= ${w.since}::timestamptz`
        : sql``;
      return [
        costAggregateWithSinceSql("rc", i, sinceCondition),
        costAggregateNetWithSinceSql("rc", i, sinceCondition),
      ];
    });

    const result = await db.execute(sql`
      SELECT ${sql.join(windowSelects, sql`, `)}
      FROM runs r
      INNER JOIN runs_costs rc ON rc.run_id = r.id
      WHERE ${baseWhere}
    `);

    const row = (result as any[])[0] || {};

    const responseWindows = windows.map((w, i) => ({
      label: w.label,
      totalCostInUsdCents: new Decimal(row[`w${i}_total`] ?? 0).toFixed(10),
      actualCostInUsdCents: new Decimal(row[`w${i}_actual`] ?? 0).toFixed(10),
      provisionedCostInUsdCents: new Decimal(row[`w${i}_provisioned`] ?? 0).toFixed(10),
      // Frozen NET (post-usage-discount) committed spend per window. Sum of the
      // per-row frozen net (COALESCE(net, gross) for pre-freeze rows) — no
      // read-time discount math. Gross fields above stay byte-identical.
      netTotalCostInUsdCents: new Decimal(row[`w${i}_net_total`] ?? 0).toFixed(10),
      netActualCostInUsdCents: new Decimal(row[`w${i}_net_actual`] ?? 0).toFixed(10),
      netProvisionedCostInUsdCents: new Decimal(row[`w${i}_net_provisioned`] ?? 0).toFixed(10),
    }));

    res.json({ windows: responseWindows });
  } catch (err) {
    console.error("[Runs Service] Error in POST /v1/stats/budget:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /v1/runs/:id/children-summary — per-child cost drill-down
router.get("/v1/runs/:id/children-summary", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify parent run exists
    const [parentRun] = await db
      .select({ id: runs.id, serviceName: runs.serviceName })
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);

    if (!parentRun) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    // Get all descendants with root_child_id tracking
    const descendantResult = await db.execute(sql`
      WITH RECURSIVE descendants AS (
        SELECT id, id as root_child_id, service_name, task_name, status, started_at, completed_at
        FROM runs WHERE parent_run_id = ${id}
        UNION ALL
        SELECT r.id, d.root_child_id, r.service_name, r.task_name, r.status, r.started_at, r.completed_at
        FROM runs r INNER JOIN descendants d ON r.parent_run_id = d.id
      )
      SELECT * FROM descendants
    `);

    const descendantRows = descendantResult as any[];

    if (descendantRows.length === 0) {
      res.json({ parentRunId: id, children: [] });
      return;
    }

    // Direct children info (root_child_id === id means the row IS a direct child)
    const directChildren = new Map<
      string,
      { id: string; serviceName: string; taskName: string; status: string; startedAt: string; completedAt: string | null }
    >();
    for (const row of descendantRows) {
      if (row.id === row.root_child_id) {
        directChildren.set(row.id, {
          id: row.id,
          serviceName: row.service_name,
          taskName: row.task_name,
          status: row.status,
          startedAt: row.started_at,
          completedAt: row.completed_at,
        });
      }
    }

    // Collect all descendant IDs for batch cost fetch
    const allDescendantIds = descendantRows.map((r: any) => r.id);

    const allCosts = await db
      .select()
      .from(runsCosts)
      .where(inArray(runsCosts.runId, allDescendantIds));

    // Map runId → root_child_id
    const runToRootChild = new Map<string, string>();
    for (const row of descendantRows) {
      runToRootChild.set(row.id, row.root_child_id);
    }

    // Aggregate costs by root_child_id and costName. Atomic status literals
    // (matches the cost-aggregator doctrine): unknown statuses are ignored,
    // never silently mis-bucketed via an `else` fall-through.
    const childCosts = new Map<string, {
      total: Decimal;
      actual: Decimal;
      provisioned: Decimal;
      byName: Map<string, { total: Decimal; actual: Decimal; provisioned: Decimal }>;
    }>();

    for (const cost of allCosts) {
      const rootChildId = runToRootChild.get(cost.runId);
      if (!rootChildId) continue;

      // Only known status values are aggregated. cancelled is audit-only.
      // Unknown statuses (e.g. a future enum extension) are ignored — explicit
      // enumeration replaces the prior `else` fall-through that would have
      // routed any non-cancelled/non-provisioned value into the actual bucket.
      const status = cost.status;
      if (status !== "actual" && status !== "provisioned") continue;

      if (!childCosts.has(rootChildId)) {
        childCosts.set(rootChildId, {
          total: new Decimal(0),
          actual: new Decimal(0),
          provisioned: new Decimal(0),
          byName: new Map(),
        });
      }
      const agg = childCosts.get(rootChildId)!;
      const amount = new Decimal(cost.totalCostInUsdCents);

      if (status === "provisioned") {
        agg.provisioned = agg.provisioned.plus(amount);
      } else {
        agg.actual = agg.actual.plus(amount);
      }
      agg.total = agg.total.plus(amount);

      if (!agg.byName.has(cost.costName)) {
        agg.byName.set(cost.costName, {
          total: new Decimal(0),
          actual: new Decimal(0),
          provisioned: new Decimal(0),
        });
      }
      const byName = agg.byName.get(cost.costName)!;
      if (status === "provisioned") {
        byName.provisioned = byName.provisioned.plus(amount);
      } else {
        byName.actual = byName.actual.plus(amount);
      }
      byName.total = byName.total.plus(amount);
    }

    // Build response
    const children = Array.from(directChildren.values()).map((child) => {
      const agg = childCosts.get(child.id) || {
        total: new Decimal(0),
        actual: new Decimal(0),
        provisioned: new Decimal(0),
        byName: new Map<string, { total: Decimal; actual: Decimal; provisioned: Decimal }>(),
      };
      return {
        id: child.id,
        serviceName: child.serviceName,
        taskName: child.taskName,
        status: child.status,
        startedAt: child.startedAt,
        completedAt: child.completedAt,
        totalCostInUsdCents: agg.total.toFixed(10),
        actualCostInUsdCents: agg.actual.toFixed(10),
        provisionedCostInUsdCents: agg.provisioned.toFixed(10),
        costsByName: Array.from(agg.byName.entries()).map(([costName, v]) => ({
          costName,
          totalCostInUsdCents: v.total.toFixed(10),
          actualCostInUsdCents: v.actual.toFixed(10),
          provisionedCostInUsdCents: v.provisioned.toFixed(10),
        })),
      };
    });

    res.json({ parentRunId: id, children });
  } catch (err) {
    console.error("[Runs Service] Error in GET /v1/runs/:id/children-summary:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Public costs endpoint ---

const PUBLIC_GROUP_BY_COLUMNS: Record<string, string> = {
  brandId: "unnest(r.brand_ids)",
  workflowSlug: "r.workflow_slug",
  campaignId: "r.campaign_id",
  featureSlug: "r.feature_slug",
  serviceName: "r.service_name",
  costName: "rc.cost_name",
};

const PUBLIC_RESULT_COL_NAMES: Record<string, string> = {
  brandId: "unnest",
  workflowSlug: "workflow_slug",
  campaignId: "campaign_id",
  featureSlug: "feature_slug",
  serviceName: "service_name",
  costName: "cost_name",
};

const PUBLIC_DYNASTY_GROUP_BY: Record<string, string> = {
  workflowDynastySlug: "r.workflow_slug",
};

const ALL_PUBLIC_GROUP_BY: Record<string, string> = {
  ...PUBLIC_GROUP_BY_COLUMNS,
  ...PUBLIC_DYNASTY_GROUP_BY,
};

function buildPublicFilterSql(filters: {
  orgId?: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
  featureSlugs?: string[];
  workflowSlugs?: string[];
  taskName?: string;
  startedAfter?: string;
  startedBefore?: string;
}) {
  const parts: ReturnType<typeof sql>[] = [];
  if (filters.orgId) parts.push(sql`r.organization_id = ${filters.orgId}`);
  if (filters.brandId) parts.push(sql`${filters.brandId} = ANY(r.brand_ids)`);
  if (filters.campaignId) parts.push(sql`r.campaign_id = ${filters.campaignId}`);

  if (filters.featureSlugs && filters.featureSlugs.length > 0) {
    parts.push(sql`r.feature_slug IN (${sql.join(filters.featureSlugs.map((n) => sql`${n}`), sql`, `)})`);
  } else if (filters.featureSlug) {
    parts.push(sql`r.feature_slug = ${filters.featureSlug}`);
  }

  if (filters.workflowSlugs && filters.workflowSlugs.length > 0) {
    parts.push(sql`r.workflow_slug IN (${sql.join(filters.workflowSlugs.map((n) => sql`${n}`), sql`, `)})`);
  }

  if (filters.taskName) parts.push(sql`r.task_name = ${filters.taskName}`);
  // Optional window bounds — the untimed public endpoint never passes these, so
  // reconciliation (sum of dated buckets == untimed total) holds for the same
  // filter. The timeseries endpoint uses them to bound the scanned range.
  if (filters.startedAfter) parts.push(sql`r.started_at >= ${filters.startedAfter}::timestamptz`);
  if (filters.startedBefore) parts.push(sql`r.started_at <= ${filters.startedBefore}::timestamptz`);
  return parts.length > 0
    ? parts.reduce((acc, part) => sql`${acc} AND ${part}`)
    : null;
}

function handlePublicCosts(req: any, res: any) {
  (async () => {
    try {
      const { groupBy, orgId, brandId, campaignId, featureSlug, featureSlugs: featureSlugsParam, workflowDynastySlug, taskName } = req.query as Record<string, string | undefined>;

      if (!groupBy || !ALL_PUBLIC_GROUP_BY[groupBy]) {
        res.status(400).json({
          error: `Invalid groupBy value. Allowed: ${Object.keys(ALL_PUBLIC_GROUP_BY).join(", ")}`,
        });
        return;
      }

      const isDynastyGroupBy = !!PUBLIC_DYNASTY_GROUP_BY[groupBy];
      const actualGroupBy = isDynastyGroupBy ? "workflowSlug" : groupBy;
      const col = PUBLIC_GROUP_BY_COLUMNS[actualGroupBy];
      const hasCostName = groupBy === "costName";
      const joinType = hasCostName ? sql`INNER JOIN` : sql`LEFT JOIN`;
      const quantitySelect = hasCostName
        ? sql`, COALESCE(SUM(rc.quantity::numeric), 0) as total_quantity`
        : sql``;

      // Resolve dynasty + multi-slug filters
      const identity: IdentityHeaders = {
        orgId: req.orgId ?? (req.headers["x-org-id"] as string),
        userId: req.userId ?? (req.headers["x-user-id"] as string),
        runId: req.runId ?? (req.headers["x-run-id"] as string),
      };
      const featureSlugs: string[] | undefined = parseCsv(featureSlugsParam);
      let workflowSlugs: string[] | undefined;
      if (workflowDynastySlug) {
        const resolved = await resolveWorkflowDynastySlugs(workflowDynastySlug, identity);
        if (resolved.length === 0) {
          res.json(EMPTY_STATS_RESPONSE);
          return;
        }
        workflowSlugs = resolved;
      }

      const filterSql = buildPublicFilterSql({ orgId, brandId, campaignId, featureSlug, featureSlugs, workflowSlugs, taskName });
      const whereSql = filterSql ? sql`WHERE ${filterSql}` : sql``;

      // Cost aggregation via cost-aggregator (atomic literals).
      const result = await db.execute(sql`
        SELECT ${sql.raw(col)},
          ${costAggregateSelectSql("rc")},
          ${costAggregateNetSelectSql("rc")},
          COUNT(DISTINCT r.id) as run_count
          ${quantitySelect}
        FROM runs r
        ${joinType} runs_costs rc ON rc.run_id = r.id
        ${whereSql}
        GROUP BY ${sql.raw(col)}
        ORDER BY total_cost DESC
      `);

      const rows = result as any[];
      const resultCol = PUBLIC_RESULT_COL_NAMES[actualGroupBy] ?? col.replace(/^r\.|^rc\./, "");

      let groups: AggRow[] = rows.map((row) => {
        const group: AggRow = {
          dimensions: { [actualGroupBy]: row[resultCol] ?? null },
          totalCostInUsdCents: new Decimal(row.total_cost).toFixed(10),
          actualCostInUsdCents: new Decimal(row.actual_cost).toFixed(10),
          provisionedCostInUsdCents: new Decimal(row.provisioned_cost).toFixed(10),
          cancelledCostInUsdCents: new Decimal(row.cancelled_cost).toFixed(10),
          // Frozen NET (post per-org usage-discount). COALESCE(net, gross) makes
          // pre-freeze / no-discount rows read net == gross. Additive: gross
          // fields above unchanged, so a gross-only consumer sees identical numbers.
          netTotalCostInUsdCents: new Decimal(row.net_total_cost).toFixed(10),
          netActualCostInUsdCents: new Decimal(row.net_actual_cost).toFixed(10),
          netProvisionedCostInUsdCents: new Decimal(row.net_provisioned_cost).toFixed(10),
          runCount: Number(row.run_count),
          minStartedAt: null,
          maxStartedAt: null,
        };
        if (hasCostName) {
          group.totalQuantity = new Decimal(row.total_quantity).toFixed(6);
        }
        return group;
      });

      // Post-process dynasty groupBy (workflow only — feature dynasty was eradicated)
      if (isDynastyGroupBy) {
        const dynasties = await fetchAllWorkflowDynasties(identity);
        const slugMap = buildSlugToDynastyMap(dynasties);
        groups = regroupByDynasty(groups, groupBy, actualGroupBy, slugMap);
      }

      res.json({ groups });
    } catch (err) {
      console.error("[Runs Service] Error in GET /v1/stats/public/costs:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  })();
}

// GET /v1/stats/public/costs
router.get("/v1/stats/public/costs", handlePublicCosts);

// --- Public cost time-series endpoint ---

const PUBLIC_TIMESERIES_INTERVALS = new Set(["day", "week", "month"]);

/**
 * Cross-org (no-auth) fleet spend split into dated buckets.
 *
 * Same WHERE filters + same cost aggregator (`costAggregateSelectSql`) as
 * `GET /v1/stats/public/costs`, with one extra partition dimension: the run's
 * `started_at` truncated to `interval` (day|week|month) in `tz` (default UTC).
 * Because every run has exactly one `started_at`, each cost row lands in exactly
 * one bucket — so summing the buckets for a filter equals the untimed total for
 * the same filter (reconciliation invariant). Empty intervals are simply absent
 * (never fabricated).
 */
function handlePublicCostsTimeseries(req: any, res: any) {
  (async () => {
    try {
      const {
        interval: intervalParam,
        tz: tzParam,
        orgId,
        brandId,
        campaignId,
        featureSlug,
        featureSlugs: featureSlugsParam,
        workflowDynastySlug,
        taskName,
        startedAfter,
        startedBefore,
      } = req.query as Record<string, string | undefined>;

      const interval = intervalParam ?? "day";
      if (!PUBLIC_TIMESERIES_INTERVALS.has(interval)) {
        res.status(400).json({
          error: `Invalid interval value. Allowed: ${Array.from(PUBLIC_TIMESERIES_INTERVALS).join(", ")}`,
        });
        return;
      }
      const timezone = tzParam ?? "UTC";

      const identity: IdentityHeaders = {
        orgId: req.orgId ?? (req.headers["x-org-id"] as string),
        userId: req.userId ?? (req.headers["x-user-id"] as string),
        runId: req.runId ?? (req.headers["x-run-id"] as string),
      };
      const featureSlugs: string[] | undefined = parseCsv(featureSlugsParam);
      let workflowSlugs: string[] | undefined;
      if (workflowDynastySlug) {
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
        featureSlug,
        featureSlugs,
        workflowSlugs,
        taskName,
        startedAfter,
        startedBefore,
      });
      const whereSql = filterSql ? sql`WHERE ${filterSql}` : sql``;

      // interval is whitelisted above; tz + interval are bound parameters (not raw).
      const bucketExpr = sql`DATE_TRUNC(${interval}, r.started_at AT TIME ZONE ${timezone})`;

      const result = await db.execute(sql`
        SELECT
          to_char(${bucketExpr}, 'YYYY-MM-DD') AS period,
          ${costAggregateSelectSql("rc")},
          ${costAggregateNetSelectSql("rc")},
          COUNT(DISTINCT r.id) as run_count
        FROM runs r
        LEFT JOIN runs_costs rc ON rc.run_id = r.id
        ${whereSql}
        GROUP BY 1
        ORDER BY 1 ASC
      `);

      const rows = result as any[];
      const buckets = rows.map((row) => ({
        period: row.period as string,
        totalCostInUsdCents: new Decimal(row.total_cost).toFixed(10),
        actualCostInUsdCents: new Decimal(row.actual_cost).toFixed(10),
        provisionedCostInUsdCents: new Decimal(row.provisioned_cost).toFixed(10),
        cancelledCostInUsdCents: new Decimal(row.cancelled_cost).toFixed(10),
        // Frozen NET (post per-org usage-discount). COALESCE(net, gross) makes
        // pre-freeze / no-discount rows read net == gross. Additive: gross fields
        // above unchanged, so the fleet-revenue consumer can sum net instead of
        // gross while every existing gross reader sees identical numbers.
        netTotalCostInUsdCents: new Decimal(row.net_total_cost).toFixed(10),
        netActualCostInUsdCents: new Decimal(row.net_actual_cost).toFixed(10),
        netProvisionedCostInUsdCents: new Decimal(row.net_provisioned_cost).toFixed(10),
        runCount: Number(row.run_count),
      }));

      res.json({ interval, timezone, buckets });
    } catch (err) {
      console.error("[Runs Service] Error in GET /v1/stats/public/costs/timeseries:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  })();
}

// GET /v1/stats/public/costs/timeseries
router.get("/v1/stats/public/costs/timeseries", handlePublicCostsTimeseries);

// GET /public/stats/runs — public run counts by status + monthly/weekly breakdown + cumulative cost
router.get("/public/stats/runs", async (_req, res) => {
  try {
    const [statusResult, monthlyResult, weeklyResult, totalCostResult] = await Promise.all([
      db.execute(sql`
        SELECT status, COUNT(*)::int as count
        FROM runs
        GROUP BY status
      `),
      db.execute(sql`
        SELECT TO_CHAR(DATE_TRUNC('month', r.started_at), 'YYYY-MM') as month,
          COUNT(DISTINCT r.id) FILTER (WHERE r.status = 'completed')::int as completed,
          COUNT(DISTINCT r.id) FILTER (WHERE r.status = 'failed')::int as failed,
          COUNT(DISTINCT r.id) FILTER (WHERE r.status = 'running')::int as running,
          ${platformTotalSelectSql("rc")}::text as total_cost
        FROM runs r
        LEFT JOIN runs_costs rc ON rc.run_id = r.id
        GROUP BY DATE_TRUNC('month', r.started_at)
        ORDER BY month ASC
      `),
      db.execute(sql`
        SELECT TO_CHAR(DATE_TRUNC('week', r.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') as period,
          COUNT(DISTINCT r.id) FILTER (WHERE r.status = 'completed')::int as completed,
          COUNT(DISTINCT r.id) FILTER (WHERE r.status = 'failed')::int as failed,
          COUNT(DISTINCT r.id) FILTER (WHERE r.status = 'running')::int as running,
          ${platformTotalSelectSql("rc")}::text as total_cost
        FROM runs r
        LEFT JOIN runs_costs rc ON rc.run_id = r.id
        GROUP BY DATE_TRUNC('week', r.started_at AT TIME ZONE 'UTC')
        ORDER BY period ASC
      `),
      db.execute(sql`
        SELECT COALESCE(SUM(rc.total_cost_in_usd_cents), 0)::text as total_cost
        FROM runs_costs rc
        WHERE rc.is_platform_projected
      `),
    ]);

    const statusRows = statusResult as any[];
    const byStatus = { completed: 0, failed: 0, running: 0 };
    for (const row of statusRows) {
      if (row.status in byStatus) {
        byStatus[row.status as keyof typeof byStatus] = row.count;
      }
    }

    const monthly = (monthlyResult as any[]).map((row) => ({
      month: row.month,
      completed: row.completed,
      failed: row.failed,
      running: row.running,
      totalCostInUsdCents: new Decimal(row.total_cost).toFixed(10),
    }));

    const weekly = (weeklyResult as any[]).map((row) => ({
      period: row.period,
      completed: row.completed,
      failed: row.failed,
      running: row.running,
      totalCostInUsdCents: new Decimal(row.total_cost).toFixed(10),
    }));

    const totalCostRow = (totalCostResult as any[])[0];
    const totalCostInUsdCents = new Decimal(totalCostRow.total_cost).toFixed(10);

    res.json({ byStatus, monthly, weekly, totalCostInUsdCents });
  } catch (err) {
    console.error("[Runs Service] Error in GET /public/stats/runs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
