import { Router } from "express";
import { eq, and, gte, lte, desc, sql, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, runsCosts, organizations, users } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  resolveMultipleUnitCosts,
  CostNotFoundError,
  UpstreamError,
} from "../services/cost-resolver.js";
import {
  CreateRunRequestSchema,
  UpdateRunRequestSchema,
  AddCostsRequestSchema,
} from "../schemas.js";

const router = Router();

// --- Helpers ---

async function getOrCreateOrg(externalId: string) {
  const [existing] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.externalId, externalId))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(organizations)
    .values({ externalId })
    .returning();
  return created;
}

async function getOrCreateUser(externalId: string, organizationId: string) {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.externalId, externalId))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(users)
    .values({ externalId, organizationId })
    .returning();
  return created;
}

// POST /v1/runs — create a run
router.post("/v1/runs", requireApiKey, async (req, res) => {
  try {
    const parsed = CreateRunRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { clerkOrgId, clerkUserId, appId, brandId, campaignId, serviceName, taskName, parentRunId } = parsed.data;

    // Get-or-create org
    const org = await getOrCreateOrg(clerkOrgId);

    // Get-or-create user (optional)
    let userId: string | null = null;
    if (clerkUserId) {
      const user = await getOrCreateUser(clerkUserId, org.id);
      userId = user.id;
    }

    const values = {
      organizationId: org.id,
      userId,
      appId,
      brandId: brandId || null,
      campaignId: campaignId || null,
      serviceName,
      taskName,
      parentRunId: parentRunId || null,
    };

    let created;
    try {
      [created] = await db.insert(runs).values(values).returning();
    } catch (insertErr: any) {
      if (insertErr?.code === "23503" && values.parentRunId) {
        console.error(
          `[Runs Service] Foreign key violation: parentRunId ${values.parentRunId} does not exist in runs table`
        );
        res.status(400).json({
          error: `parentRunId ${values.parentRunId} does not exist`,
        });
        return;
      }
      throw insertErr;
    }

    res.status(201).json(created);
  } catch (err) {
    console.error("[Runs Service] Error creating run:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /v1/runs/:id — get run with costs and descendant runs
router.get("/v1/runs/:id", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);

    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    // Get own costs
    const costs = await db
      .select()
      .from(runsCosts)
      .where(eq(runsCosts.runId, id));

    const ownTotal = costs.reduce(
      (sum, c) => sum + Number(c.totalCostInUsdCents),
      0
    );

    // Get all descendant run IDs using recursive CTE
    const descendantResult = await db.execute(
      sql`WITH RECURSIVE descendants AS (
        SELECT id, parent_run_id, service_name, task_name, status, started_at, completed_at
        FROM runs WHERE parent_run_id = ${id}
        UNION ALL
        SELECT r.id, r.parent_run_id, r.service_name, r.task_name, r.status, r.started_at, r.completed_at
        FROM runs r INNER JOIN descendants d ON r.parent_run_id = d.id
      )
      SELECT * FROM descendants`
    );

    const descendantRows = descendantResult as any[];
    const descendantIds = descendantRows.map((r: any) => r.id);

    // Get all descendant costs in one query
    let allDescendantCosts: any[] = [];
    if (descendantIds.length > 0) {
      allDescendantCosts = await db
        .select()
        .from(runsCosts)
        .where(inArray(runsCosts.runId, descendantIds));
    }

    // Group costs by runId
    const costsByRunId = new Map<string, any[]>();
    for (const cost of allDescendantCosts) {
      const list = costsByRunId.get(cost.runId) || [];
      list.push(cost);
      costsByRunId.set(cost.runId, list);
    }

    // Build descendant runs with costs
    const descendantRuns = descendantRows.map((r: any) => {
      const runCosts = costsByRunId.get(r.id) || [];
      const runOwnTotal = runCosts.reduce(
        (sum: number, c: any) => sum + Number(c.totalCostInUsdCents),
        0
      );
      return {
        id: r.id,
        parentRunId: r.parent_run_id,
        serviceName: r.service_name,
        taskName: r.task_name,
        status: r.status,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        costs: runCosts,
        ownCostInUsdCents: runOwnTotal.toFixed(10),
      };
    });

    const childrenTotal = allDescendantCosts.reduce(
      (sum, c) => sum + Number(c.totalCostInUsdCents),
      0
    );

    res.json({
      ...run,
      costs,
      totalCostInUsdCents: (ownTotal + childrenTotal).toFixed(10),
      ownCostInUsdCents: ownTotal.toFixed(10),
      childrenCostInUsdCents: childrenTotal.toFixed(10),
      descendantRuns,
    });
  } catch (err) {
    console.error("[Runs Service] Error getting run:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /v1/runs/:id/costs — add cost line items
router.post("/v1/runs/:id/costs", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const parsed = AddCostsRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { items } = parsed.data;

    // Verify run exists
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);

    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    // Resolve unit costs from costs-service
    const names = items.map((i) => i.costName);
    let costMap: Map<string, string>;
    try {
      costMap = await resolveMultipleUnitCosts(names);
    } catch (err) {
      if (err instanceof CostNotFoundError) {
        res
          .status(422)
          .json({ error: `Unknown cost: ${err.costName}` });
        return;
      }
      throw err;
    }

    // Build cost rows
    const costRows = items.map((item) => {
      const unitCost = costMap.get(item.costName)!;
      const qty = Number(item.quantity);
      const total = (qty * Number(unitCost)).toFixed(10);
      return {
        runId: id,
        costName: item.costName,
        quantity: String(item.quantity),
        unitCostInUsdCents: unitCost,
        totalCostInUsdCents: total,
      };
    });

    // Insert costs
    const inserted = await db.insert(runsCosts).values(costRows).returning();

    res.status(201).json({ costs: inserted });
  } catch (err) {
    if (err instanceof UpstreamError) {
      console.error(`[Runs Service] costs-service unavailable (${err.statusCode}):`, err.message);
      res.status(502).json({ error: `costs-service unavailable: ${err.message}` });
      return;
    }
    console.error("[Runs Service] Error adding run costs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /v1/runs/:id — update run status
router.patch("/v1/runs/:id", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const parsed = UpdateRunRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { status } = parsed.data;

    const [updated] = await db
      .update(runs)
      .set({
        status,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runs.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    res.json(updated);
  } catch (err) {
    console.error("[Runs Service] Error updating run:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /v1/runs — list runs with cost totals
router.get("/v1/runs", requireApiKey, async (req, res) => {
  try {
    const {
      clerkOrgId,
      clerkUserId,
      appId,
      brandId,
      campaignId,
      serviceName,
      taskName,
      status,
      parentRunId,
      startedAfter,
      startedBefore,
      limit: limitStr,
      offset: offsetStr,
    } = req.query;

    if (!clerkOrgId) {
      res.status(400).json({ error: "clerkOrgId query param is required" });
      return;
    }

    // Resolve clerkOrgId to internal org ID
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.externalId, clerkOrgId as string))
      .limit(1);

    if (!org) {
      // Org doesn't exist — no runs possible
      res.json({ runs: [], limit: Math.min(Number(limitStr) || 50, 200), offset: Number(offsetStr) || 0 });
      return;
    }

    const conditions = [eq(runs.organizationId, org.id)];

    // Resolve clerkUserId to internal user ID
    if (clerkUserId) {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.externalId, clerkUserId as string))
        .limit(1);
      if (!user) {
        res.json({ runs: [], limit: Math.min(Number(limitStr) || 50, 200), offset: Number(offsetStr) || 0 });
        return;
      }
      conditions.push(eq(runs.userId, user.id));
    }

    if (appId) conditions.push(eq(runs.appId, appId as string));
    if (brandId) conditions.push(eq(runs.brandId, brandId as string));
    if (campaignId) conditions.push(eq(runs.campaignId, campaignId as string));
    if (serviceName) conditions.push(eq(runs.serviceName, serviceName as string));
    if (taskName) conditions.push(eq(runs.taskName, taskName as string));
    if (status) conditions.push(eq(runs.status, status as string));
    if (parentRunId) conditions.push(eq(runs.parentRunId, parentRunId as string));
    if (startedAfter)
      conditions.push(gte(runs.startedAt, new Date(startedAfter as string)));
    if (startedBefore)
      conditions.push(lte(runs.startedAt, new Date(startedBefore as string)));

    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
    const limit = Math.min(Number(limitStr) || 50, 200);
    const offset = Number(offsetStr) || 0;

    // Select runs with own cost totals via LEFT JOIN + SUM
    const result = await db
      .select({
        id: runs.id,
        parentRunId: runs.parentRunId,
        organizationId: runs.organizationId,
        userId: runs.userId,
        appId: runs.appId,
        brandId: runs.brandId,
        campaignId: runs.campaignId,
        serviceName: runs.serviceName,
        taskName: runs.taskName,
        status: runs.status,
        startedAt: runs.startedAt,
        completedAt: runs.completedAt,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
        ownCostInUsdCents: sql<string>`COALESCE(SUM(${runsCosts.totalCostInUsdCents}), 0)`.as("own_cost_in_usd_cents"),
      })
      .from(runs)
      .leftJoin(runsCosts, eq(runsCosts.runId, runs.id))
      .where(whereClause)
      .groupBy(
        runs.id,
        runs.parentRunId,
        runs.organizationId,
        runs.userId,
        runs.appId,
        runs.brandId,
        runs.campaignId,
        runs.serviceName,
        runs.taskName,
        runs.status,
        runs.startedAt,
        runs.completedAt,
        runs.createdAt,
        runs.updatedAt,
      )
      .orderBy(desc(runs.startedAt))
      .limit(limit)
      .offset(offset);

    // Format ownCostInUsdCents to fixed decimal
    const formattedRuns = result.map((r) => ({
      ...r,
      ownCostInUsdCents: Number(r.ownCostInUsdCents).toFixed(10),
    }));

    res.json({ runs: formattedRuns, limit, offset });
  } catch (err) {
    console.error("[Runs Service] Error listing runs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
