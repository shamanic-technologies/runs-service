import { Router } from "express";
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, runsCosts, organizations } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { BudgetRequestSchema } from "../schemas.js";

const router = Router();

// --- Validated allowlist for GROUP BY columns ---

const GROUP_BY_COLUMNS: Record<string, string> = {
  brandId: "r.brand_id",
  workflowName: "r.workflow_name",
  campaignId: "r.campaign_id",
  serviceName: "r.service_name",
  appId: "r.app_id",
};

// --- Helpers ---

async function resolveOrgId(externalOrgId: string): Promise<string | null> {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.externalId, externalOrgId))
    .limit(1);
  return org?.id ?? null;
}

function buildFilterSql(
  orgId: string,
  appId: string,
  filters: {
    brandId?: string;
    campaignId?: string;
    workflowName?: string;
    serviceName?: string;
    taskName?: string;
    startedAfter?: string;
    startedBefore?: string;
  }
) {
  const parts = [sql`r.organization_id = ${orgId}`, sql`r.app_id = ${appId}`];

  if (filters.brandId) parts.push(sql`r.brand_id = ${filters.brandId}`);
  if (filters.campaignId) parts.push(sql`r.campaign_id = ${filters.campaignId}`);
  if (filters.workflowName) parts.push(sql`r.workflow_name = ${filters.workflowName}`);
  if (filters.serviceName) parts.push(sql`r.service_name = ${filters.serviceName}`);
  if (filters.taskName) parts.push(sql`r.task_name = ${filters.taskName}`);
  if (filters.startedAfter) parts.push(sql`r.started_at >= ${filters.startedAfter}::timestamptz`);
  if (filters.startedBefore) parts.push(sql`r.started_at <= ${filters.startedBefore}::timestamptz`);

  return parts.reduce((acc, part) => sql`${acc} AND ${part}`);
}

// GET /v1/stats/costs — aggregation with GROUP BY
router.get("/v1/stats/costs", requireApiKey, async (req, res) => {
  try {
    const {
      orgId: externalOrgId,
      groupBy,
      brandId,
      campaignId,
      workflowName,
      serviceName,
      taskName,
      appId,
      startedAfter,
      startedBefore,
    } = req.query as Record<string, string | undefined>;

    if (!externalOrgId) {
      res.status(400).json({ error: "orgId is required" });
      return;
    }
    if (!appId) {
      res.status(400).json({ error: "appId is required" });
      return;
    }
    if (!groupBy) {
      res.status(400).json({ error: "groupBy is required" });
      return;
    }

    // Validate groupBy columns
    const groupByKeys = groupBy.split(",").map((s) => s.trim());
    const invalidKeys = groupByKeys.filter((k) => !GROUP_BY_COLUMNS[k]);
    if (invalidKeys.length > 0) {
      res.status(400).json({
        error: `Invalid groupBy values: ${invalidKeys.join(", ")}. Allowed: ${Object.keys(GROUP_BY_COLUMNS).join(", ")}`,
      });
      return;
    }

    const orgId = await resolveOrgId(externalOrgId);
    if (!orgId) {
      res.json({ groups: [] });
      return;
    }

    const groupByCols = groupByKeys.map((k) => GROUP_BY_COLUMNS[k]);
    const selectCols = groupByCols.map((col) => sql.raw(col));
    const groupByClause = sql.raw(groupByCols.join(", "));

    const whereSql = buildFilterSql(orgId, appId, {
      brandId,
      campaignId,
      workflowName,
      serviceName,
      taskName,
      startedAfter,
      startedBefore,
    });

    const result = await db.execute(sql`
      SELECT ${sql.join(selectCols, sql`, `)},
        COALESCE(SUM(CASE WHEN rc.status != 'cancelled' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as total_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'actual' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as actual_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'provisioned' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as provisioned_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'cancelled' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as cancelled_cost,
        COUNT(DISTINCT r.id) as run_count
      FROM runs r
      LEFT JOIN runs_costs rc ON rc.run_id = r.id
      WHERE ${whereSql}
      GROUP BY ${groupByClause}
      ORDER BY total_cost DESC
    `);

    const rows = result as any[];

    // Map DB column names back to camelCase keys
    const colToCamel: Record<string, string> = {
      brand_id: "brandId",
      workflow_name: "workflowName",
      campaign_id: "campaignId",
      service_name: "serviceName",
      app_id: "appId",
    };

    const groups = rows.map((row) => {
      const dimensions: Record<string, string | null> = {};
      for (const key of groupByKeys) {
        const dbCol = GROUP_BY_COLUMNS[key].replace("r.", "");
        dimensions[key] = row[dbCol] ?? null;
      }
      return {
        dimensions,
        totalCostInUsdCents: Number(row.total_cost).toFixed(10),
        actualCostInUsdCents: Number(row.actual_cost).toFixed(10),
        provisionedCostInUsdCents: Number(row.provisioned_cost).toFixed(10),
        cancelledCostInUsdCents: Number(row.cancelled_cost).toFixed(10),
        runCount: Number(row.run_count),
      };
    });

    res.json({ groups });
  } catch (err) {
    console.error("[Runs Service] Error in GET /v1/stats/costs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /v1/stats/costs/by-cost-name — breakdown by costName
router.get("/v1/stats/costs/by-cost-name", requireApiKey, async (req, res) => {
  try {
    const {
      orgId: externalOrgId,
      brandId,
      campaignId,
      workflowName,
      serviceName,
      taskName,
      appId,
      startedAfter,
      startedBefore,
    } = req.query as Record<string, string | undefined>;

    if (!externalOrgId) {
      res.status(400).json({ error: "orgId is required" });
      return;
    }
    if (!appId) {
      res.status(400).json({ error: "appId is required" });
      return;
    }

    const orgId = await resolveOrgId(externalOrgId);
    if (!orgId) {
      res.json({ costs: [] });
      return;
    }

    const whereSql = buildFilterSql(orgId, appId, {
      brandId,
      campaignId,
      workflowName,
      serviceName,
      taskName,
      startedAfter,
      startedBefore,
    });

    const result = await db.execute(sql`
      SELECT rc.cost_name,
        COALESCE(SUM(CASE WHEN rc.status != 'cancelled' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as total_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'actual' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as actual_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'provisioned' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as provisioned_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'cancelled' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as cancelled_cost,
        COALESCE(SUM(rc.quantity::numeric), 0) as total_quantity
      FROM runs r
      INNER JOIN runs_costs rc ON rc.run_id = r.id
      WHERE ${whereSql}
      GROUP BY rc.cost_name
      ORDER BY total_cost DESC
    `);

    const rows = result as any[];
    const costs = rows.map((row) => ({
      costName: row.cost_name,
      totalCostInUsdCents: Number(row.total_cost).toFixed(10),
      actualCostInUsdCents: Number(row.actual_cost).toFixed(10),
      provisionedCostInUsdCents: Number(row.provisioned_cost).toFixed(10),
      cancelledCostInUsdCents: Number(row.cancelled_cost).toFixed(10),
      totalQuantity: Number(row.total_quantity).toFixed(6),
    }));

    res.json({ costs });
  } catch (err) {
    console.error("[Runs Service] Error in GET /v1/stats/costs/by-cost-name:", err);
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

    const { orgId: externalOrgId, appId, campaignId, brandId, workflowName, windows } = parsed.data;

    const orgId = await resolveOrgId(externalOrgId);
    if (!orgId) {
      // Return zeros for all windows
      res.json({
        windows: windows.map((w) => ({
          label: w.label,
          totalCostInUsdCents: "0.0000000000",
          actualCostInUsdCents: "0.0000000000",
          provisionedCostInUsdCents: "0.0000000000",
        })),
      });
      return;
    }

    // Build base WHERE conditions
    const filterParts = [sql`r.organization_id = ${orgId}`, sql`r.app_id = ${appId}`];
    if (campaignId) filterParts.push(sql`r.campaign_id = ${campaignId}`);
    if (brandId) filterParts.push(sql`r.brand_id = ${brandId}`);
    if (workflowName) filterParts.push(sql`r.workflow_name = ${workflowName}`);

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
      totalCostInUsdCents: Number(row[`w${i}_total`] ?? 0).toFixed(10),
      actualCostInUsdCents: Number(row[`w${i}_actual`] ?? 0).toFixed(10),
      provisionedCostInUsdCents: Number(row[`w${i}_provisioned`] ?? 0).toFixed(10),
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
      total: number;
      actual: number;
      provisioned: number;
      byName: Map<string, { total: number; actual: number; provisioned: number }>;
    }>();

    for (const cost of allCosts) {
      const rootChildId = runToRootChild.get(cost.runId);
      if (!rootChildId) continue;

      if (!childCosts.has(rootChildId)) {
        childCosts.set(rootChildId, { total: 0, actual: 0, provisioned: 0, byName: new Map() });
      }
      const agg = childCosts.get(rootChildId)!;
      const amount = Number(cost.totalCostInUsdCents);

      if (cost.status === "cancelled") continue;

      if (cost.status === "provisioned") {
        agg.provisioned += amount;
      } else {
        agg.actual += amount;
      }
      agg.total += amount;

      // By name
      if (!agg.byName.has(cost.costName)) {
        agg.byName.set(cost.costName, { total: 0, actual: 0, provisioned: 0 });
      }
      const byName = agg.byName.get(cost.costName)!;
      if (cost.status === "provisioned") {
        byName.provisioned += amount;
      } else {
        byName.actual += amount;
      }
      byName.total += amount;
    }

    // Build response
    const children = Array.from(directChildren.values()).map((child) => {
      const agg = childCosts.get(child.id) || { total: 0, actual: 0, provisioned: 0, byName: new Map() };
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

// GET /v1/stats/public/leaderboard — public cross-org leaderboard
const PUBLIC_GROUP_BY_COLUMNS: Record<string, string> = {
  brandId: "r.brand_id",
  workflowName: "r.workflow_name",
};

router.get("/v1/stats/public/leaderboard", async (req, res) => {
  try {
    const { appId, groupBy } = req.query as Record<string, string | undefined>;

    if (!appId) {
      res.status(400).json({ error: "appId is required" });
      return;
    }
    if (!groupBy || !PUBLIC_GROUP_BY_COLUMNS[groupBy]) {
      res.status(400).json({
        error: `Invalid groupBy value. Allowed: ${Object.keys(PUBLIC_GROUP_BY_COLUMNS).join(", ")}`,
      });
      return;
    }

    const col = PUBLIC_GROUP_BY_COLUMNS[groupBy];

    const result = await db.execute(sql`
      SELECT ${sql.raw(col)},
        COALESCE(SUM(CASE WHEN rc.status != 'cancelled' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as total_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'actual' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as actual_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'provisioned' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as provisioned_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'cancelled' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as cancelled_cost,
        COUNT(DISTINCT r.id) as run_count
      FROM runs r
      LEFT JOIN runs_costs rc ON rc.run_id = r.id
      WHERE r.app_id = ${appId}
      GROUP BY ${sql.raw(col)}
      ORDER BY total_cost DESC
    `);

    const rows = result as any[];
    const dbCol = col.replace("r.", "");

    const groups = rows.map((row) => ({
      dimensions: { [groupBy]: row[dbCol] ?? null },
      totalCostInUsdCents: Number(row.total_cost).toFixed(10),
      actualCostInUsdCents: Number(row.actual_cost).toFixed(10),
      provisionedCostInUsdCents: Number(row.provisioned_cost).toFixed(10),
      cancelledCostInUsdCents: Number(row.cancelled_cost).toFixed(10),
      runCount: Number(row.run_count),
    }));

    res.json({ groups });
  } catch (err) {
    console.error("[Runs Service] Error in GET /v1/stats/public/leaderboard:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
