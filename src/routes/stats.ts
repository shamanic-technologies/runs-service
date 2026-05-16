import { Router } from "express";
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { runs, runsCosts } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { BudgetRequestSchema } from "../schemas.js";
import {
  resolveWorkflowDynastySlugs,
  resolveFeatureDynastySlugs,
  fetchAllWorkflowDynasties,
  fetchAllFeatureDynasties,
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
  serviceName: "r.service_name",
  costName: "rc.cost_name",
};

// Maps groupBy keys to the result column name in the SQL result row.
const RESULT_COL_NAMES: Record<string, string> = {
  brandId: "unnest",
  workflowSlug: "workflow_slug",
  campaignId: "campaign_id",
  featureSlug: "feature_slug",
  serviceName: "service_name",
  costName: "cost_name",
};

// Dynasty groupBy keys map to their underlying DB column
const DYNASTY_GROUP_BY: Record<string, string> = {
  workflowDynastySlug: "r.workflow_slug",
  featureDynastySlug: "r.feature_slug",
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
    serviceName?: string;
    taskName?: string;
    startedAfter?: string;
    startedBefore?: string;
  }
) {
  const parts = [sql`r.organization_id = ${orgId}`];

  if (filters.brandId) parts.push(sql`${filters.brandId} = ANY(r.brand_ids)`);
  if (filters.campaignId) parts.push(sql`r.campaign_id = ${filters.campaignId}`);

  // Feature slug filtering: resolved dynasty slugs > single slug
  if (filters.featureSlugs && filters.featureSlugs.length > 0) {
    parts.push(sql`r.feature_slug IN (${sql.join(filters.featureSlugs.map((n) => sql`${n}`), sql`, `)})`);
  } else if (filters.featureSlug) {
    parts.push(sql`r.feature_slug = ${filters.featureSlug}`);
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

/** Resolve dynasty slug filters into arrays of versioned slugs */
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
    workflowSlugs = query.workflowSlugs.split(",").map((s) => s.trim()).filter(Boolean);
  }

  if (query.featureDynastySlug) {
    const resolved = await resolveFeatureDynastySlugs(query.featureDynastySlug, identity);
    if (resolved.length === 0) {
      emptyResult = true;
    } else {
      featureSlugs = resolved;
    }
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
  runCount: number;
  minStartedAt: string | null;
  maxStartedAt: string | null;
  totalQuantity?: string;
}

/** Re-group rows by dynasty slug, merging rows whose underlying slug maps to the same dynasty */
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

    const existing = merged.get(dynasty);
    if (!existing) {
      const newDimensions = { ...group.dimensions };
      delete newDimensions[underlyingKey];
      newDimensions[dynastyKey] = dynasty;
      merged.set(dynasty, { ...group, dimensions: newDimensions });
    } else {
      existing.totalCostInUsdCents = new Decimal(existing.totalCostInUsdCents).plus(group.totalCostInUsdCents).toFixed(10);
      existing.actualCostInUsdCents = new Decimal(existing.actualCostInUsdCents).plus(group.actualCostInUsdCents).toFixed(10);
      existing.provisionedCostInUsdCents = new Decimal(existing.provisionedCostInUsdCents).plus(group.provisionedCostInUsdCents).toFixed(10);
      existing.cancelledCostInUsdCents = new Decimal(existing.cancelledCostInUsdCents).plus(group.cancelledCostInUsdCents).toFixed(10);
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
      featureDynastySlug,
      serviceName,
      taskName,
      startedAfter,
      startedBefore,
    } = req.query as Record<string, string | undefined>;

    if (!groupBy) {
      res.status(400).json({ error: "groupBy is required" });
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

    // Resolve dynasty filters
    const identity: IdentityHeaders = { orgId: req.orgId, userId: req.userId, runId: req.runId };
    const dynastyFilters = await resolveDynastyFilters({
      workflowDynastySlug,
      featureDynastySlug,
      workflowSlugs: workflowSlugsParam,
    }, identity);

    if (dynastyFilters.emptyResult) {
      res.json(EMPTY_STATS_RESPONSE);
      return;
    }

    // Determine which dynasty groupBy keys are present
    const hasDynastyWorkflowGroupBy = groupByKeys.includes("workflowDynastySlug");
    const hasDynastyFeatureGroupBy = groupByKeys.includes("featureDynastySlug");

    // Build actual SQL groupBy keys: replace dynasty keys with their underlying column
    const sqlGroupByKeys = groupByKeys.map((k) => DYNASTY_GROUP_BY[k] ? (k === "workflowDynastySlug" ? "workflowSlug" : "featureSlug") : k);
    const uniqueSqlGroupByKeys = [...new Set(sqlGroupByKeys)];

    const groupByCols = uniqueSqlGroupByKeys.map((k) => GROUP_BY_COLUMNS[k]);
    const selectCols = groupByCols.map((col) => sql.raw(col));
    const groupByClause = sql.raw(groupByCols.join(", "));
    const hasCostName = groupByKeys.includes("costName");

    const whereSql = buildFilterSql(req.orgId, {
      brandId,
      campaignId,
      workflowSlug,
      workflowSlugs: dynastyFilters.workflowSlugs,
      featureSlug,
      featureSlugs: dynastyFilters.featureSlugs,
      serviceName,
      taskName,
      startedAfter,
      startedBefore,
    });

    const joinType = hasCostName ? sql`INNER JOIN` : sql`LEFT JOIN`;
    const quantitySelect = hasCostName
      ? sql`, COALESCE(SUM(rc.quantity::numeric), 0) as total_quantity`
      : sql``;

    const result = await db.execute(sql`
      SELECT ${sql.join(selectCols, sql`, `)},
        COALESCE(SUM(CASE WHEN rc.status != 'cancelled' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as total_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'actual' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as actual_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'provisioned' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as provisioned_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'cancelled' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as cancelled_cost,
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
    if (hasDynastyFeatureGroupBy) {
      const dynasties = await fetchAllFeatureDynasties(identity);
      const slugMap = buildSlugToDynastyMap(dynasties);
      groups = regroupByDynasty(groups, "featureDynastySlug", "featureSlug", slugMap);
    }

    res.json({ groups });
  } catch (err) {
    console.error("[Runs Service] Error in GET /v1/stats/costs:", err);
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

    // Build CASE WHEN per window for actual and provisioned
    const windowSelects = windows.flatMap((w, i) => {
      const sinceCondition = w.since
        ? sql`AND rc.created_at >= ${w.since}::timestamptz`
        : sql``;

      return [
        sql`COALESCE(SUM(CASE WHEN rc.status != 'cancelled' ${sinceCondition} THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as ${sql.raw(`w${i}_total`)}`,
        sql`COALESCE(SUM(CASE WHEN rc.status = 'actual' ${sinceCondition} THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as ${sql.raw(`w${i}_actual`)}`,
        sql`COALESCE(SUM(CASE WHEN rc.status = 'provisioned' ${sinceCondition} THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as ${sql.raw(`w${i}_provisioned`)}`,
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

    // Aggregate costs by root_child_id and costName
    const childCosts = new Map<string, {
      total: Decimal;
      actual: Decimal;
      provisioned: Decimal;
      byName: Map<string, { total: Decimal; actual: Decimal; provisioned: Decimal }>;
    }>();

    for (const cost of allCosts) {
      const rootChildId = runToRootChild.get(cost.runId);
      if (!rootChildId) continue;

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

      if (cost.status === "cancelled") continue;

      if (cost.status === "provisioned") {
        agg.provisioned = agg.provisioned.plus(amount);
      } else {
        agg.actual = agg.actual.plus(amount);
      }
      agg.total = agg.total.plus(amount);

      // By name
      if (!agg.byName.has(cost.costName)) {
        agg.byName.set(cost.costName, {
          total: new Decimal(0),
          actual: new Decimal(0),
          provisioned: new Decimal(0),
        });
      }
      const byName = agg.byName.get(cost.costName)!;
      if (cost.status === "provisioned") {
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
  featureDynastySlug: "r.feature_slug",
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
  return parts.length > 0
    ? parts.reduce((acc, part) => sql`${acc} AND ${part}`)
    : null;
}

function handlePublicCosts(req: any, res: any) {
  (async () => {
    try {
      const { groupBy, orgId, brandId, campaignId, featureSlug, featureSlugs: featureSlugsParam, featureDynastySlug, workflowDynastySlug, taskName } = req.query as Record<string, string | undefined>;

      if (!groupBy || !ALL_PUBLIC_GROUP_BY[groupBy]) {
        res.status(400).json({
          error: `Invalid groupBy value. Allowed: ${Object.keys(ALL_PUBLIC_GROUP_BY).join(", ")}`,
        });
        return;
      }

      const isDynastyGroupBy = !!PUBLIC_DYNASTY_GROUP_BY[groupBy];
      const actualGroupBy = isDynastyGroupBy
        ? (groupBy === "workflowDynastySlug" ? "workflowSlug" : "featureSlug")
        : groupBy;
      const col = PUBLIC_GROUP_BY_COLUMNS[actualGroupBy];
      const hasCostName = groupBy === "costName";
      const joinType = hasCostName ? sql`INNER JOIN` : sql`LEFT JOIN`;
      const quantitySelect = hasCostName
        ? sql`, COALESCE(SUM(rc.quantity::numeric), 0) as total_quantity`
        : sql``;

      // Resolve dynasty filters
      const identity: IdentityHeaders = {
        orgId: req.orgId ?? (req.headers["x-org-id"] as string),
        userId: req.userId ?? (req.headers["x-user-id"] as string),
        runId: req.runId ?? (req.headers["x-run-id"] as string),
      };
      let featureSlugs: string[] | undefined;
      let workflowSlugs: string[] | undefined;
      if (featureDynastySlug) {
        const resolved = await resolveFeatureDynastySlugs(featureDynastySlug, identity);
        if (resolved.length === 0) {
          res.json(EMPTY_STATS_RESPONSE);
          return;
        }
        featureSlugs = resolved;
      } else if (featureSlugsParam) {
        featureSlugs = featureSlugsParam.split(",").map((s) => s.trim()).filter(Boolean);
      }
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

      const result = await db.execute(sql`
        SELECT ${sql.raw(col)},
          COALESCE(SUM(CASE WHEN rc.status != 'cancelled' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as total_cost,
          COALESCE(SUM(CASE WHEN rc.status = 'actual' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as actual_cost,
          COALESCE(SUM(CASE WHEN rc.status = 'provisioned' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as provisioned_cost,
          COALESCE(SUM(CASE WHEN rc.status = 'cancelled' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as cancelled_cost,
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
          runCount: Number(row.run_count),
          minStartedAt: null,
          maxStartedAt: null,
        };
        if (hasCostName) {
          group.totalQuantity = new Decimal(row.total_quantity).toFixed(6);
        }
        return group;
      });

      // Post-process dynasty groupBy
      if (isDynastyGroupBy) {
        const isWorkflow = groupBy === "workflowDynastySlug";
        const dynasties = isWorkflow
          ? await fetchAllWorkflowDynasties(identity)
          : await fetchAllFeatureDynasties(identity);
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
          COALESCE(SUM(
            CASE
              WHEN rc.cost_source = 'platform' AND rc.status != 'cancelled'
                THEN rc.total_cost_in_usd_cents::numeric
              ELSE 0
            END
          ), 0)::text as total_cost
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
          COALESCE(SUM(
            CASE
              WHEN rc.cost_source = 'platform' AND rc.status != 'cancelled'
                THEN rc.total_cost_in_usd_cents::numeric
              ELSE 0
            END
          ), 0)::text as total_cost
        FROM runs r
        LEFT JOIN runs_costs rc ON rc.run_id = r.id
        GROUP BY DATE_TRUNC('week', r.started_at AT TIME ZONE 'UTC')
        ORDER BY period ASC
      `),
      db.execute(sql`
        SELECT COALESCE(SUM(rc.total_cost_in_usd_cents::numeric), 0)::text as total_cost
        FROM runs_costs rc
        WHERE rc.cost_source = 'platform' AND rc.status != 'cancelled'
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
