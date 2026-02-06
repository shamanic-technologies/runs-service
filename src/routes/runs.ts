import { Router } from "express";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, runsCosts } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  resolveMultipleUnitCosts,
  CostNotFoundError,
} from "../services/cost-resolver.js";

const router = Router();

// POST /v1/runs — create a run
router.post("/v1/runs", requireApiKey, async (req, res) => {
  try {
    const { organizationId, userId, serviceName, taskName, parentRunId } =
      req.body;

    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }
    if (!serviceName) {
      res.status(400).json({ error: "serviceName is required" });
      return;
    }
    if (!taskName) {
      res.status(400).json({ error: "taskName is required" });
      return;
    }

    const values = {
      organizationId,
      userId: userId || null,
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

// GET /v1/runs/summary — aggregate costs
router.get("/v1/runs/summary", requireApiKey, async (req, res) => {
  try {
    const { organizationId, serviceName, taskName, startedAfter, startedBefore, groupBy } =
      req.query;

    if (!organizationId) {
      res.status(400).json({ error: "organizationId query param is required" });
      return;
    }

    const conditions = [eq(runs.organizationId, organizationId as string)];
    if (serviceName) conditions.push(eq(runs.serviceName, serviceName as string));
    if (taskName) conditions.push(eq(runs.taskName, taskName as string));
    if (startedAfter)
      conditions.push(gte(runs.startedAt, new Date(startedAfter as string)));
    if (startedBefore)
      conditions.push(lte(runs.startedAt, new Date(startedBefore as string)));

    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

    if (groupBy === "costName") {
      const result = await db
        .select({
          key: runsCosts.costName,
          totalCostInUsdCents: sql<string>`sum(${runsCosts.totalCostInUsdCents})`,
          totalQuantity: sql<string>`sum(${runsCosts.quantity})`,
        })
        .from(runsCosts)
        .innerJoin(runs, eq(runsCosts.runId, runs.id))
        .where(whereClause)
        .groupBy(runsCosts.costName);

      res.json({ breakdown: result });
      return;
    }

    const groupColumn =
      groupBy === "userId" ? runs.userId : runs.serviceName;

    const result = await db
      .select({
        key: groupColumn,
        totalCostInUsdCents: sql<string>`sum(${runsCosts.totalCostInUsdCents})`,
        runCount: sql<number>`count(distinct ${runs.id})`,
      })
      .from(runs)
      .leftJoin(runsCosts, eq(runsCosts.runId, runs.id))
      .where(whereClause)
      .groupBy(groupColumn);

    res.json({ breakdown: result });
  } catch (err) {
    console.error("[Runs Service] Error getting summary:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /v1/runs/:id — get run with costs (including children costs)
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

    // Get children runs and their costs recursively using CTE
    const childrenCostResult = await db.execute(
      sql`WITH RECURSIVE descendants AS (
        SELECT id FROM runs WHERE parent_run_id = ${id}
        UNION ALL
        SELECT r.id FROM runs r INNER JOIN descendants d ON r.parent_run_id = d.id
      )
      SELECT COALESCE(SUM(rc.total_cost_in_usd_cents), 0) as children_total
      FROM runs_costs rc
      WHERE rc.run_id IN (SELECT id FROM descendants)`
    );

    const childrenTotal = Number(
      (childrenCostResult as any)[0]?.children_total || 0
    );

    res.json({
      ...run,
      costs,
      totalCostInUsdCents: (ownTotal + childrenTotal).toFixed(10),
      ownCostInUsdCents: ownTotal.toFixed(10),
      childrenCostInUsdCents: childrenTotal.toFixed(10),
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
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "items array is required" });
      return;
    }

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
    const names = items.map((i: any) => i.costName as string);
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
    const costRows = items.map((item: any) => {
      const unitCost = costMap.get(item.costName)!;
      const qty = Number(item.quantity);
      const total = (qty * Number(unitCost)).toFixed(10);
      return {
        runId: id,
        costName: item.costName as string,
        quantity: String(item.quantity),
        unitCostInUsdCents: unitCost,
        totalCostInUsdCents: total,
      };
    });

    // Insert costs
    const inserted = await db.insert(runsCosts).values(costRows).returning();

    res.status(201).json({ costs: inserted });
  } catch (err) {
    console.error("[Runs Service] Error adding run costs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /v1/runs/:id — update run status
router.patch("/v1/runs/:id", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['completed', 'failed'].includes(status)) {
      res.status(400).json({ error: "status must be 'completed' or 'failed'" });
      return;
    }

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

// GET /v1/runs — list runs
router.get("/v1/runs", requireApiKey, async (req, res) => {
  try {
    const {
      organizationId,
      serviceName,
      taskName,
      userId,
      status,
      startedAfter,
      startedBefore,
      limit: limitStr,
      offset: offsetStr,
    } = req.query;

    if (!organizationId) {
      res.status(400).json({ error: "organizationId query param is required" });
      return;
    }

    const conditions = [eq(runs.organizationId, organizationId as string)];
    if (serviceName) conditions.push(eq(runs.serviceName, serviceName as string));
    if (taskName) conditions.push(eq(runs.taskName, taskName as string));
    if (userId) conditions.push(eq(runs.userId, userId as string));
    if (status) conditions.push(eq(runs.status, status as string));
    if (startedAfter)
      conditions.push(gte(runs.startedAt, new Date(startedAfter as string)));
    if (startedBefore)
      conditions.push(lte(runs.startedAt, new Date(startedBefore as string)));

    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
    const limit = Math.min(Number(limitStr) || 50, 200);
    const offset = Number(offsetStr) || 0;

    const result = await db
      .select()
      .from(runs)
      .where(whereClause)
      .orderBy(desc(runs.startedAt))
      .limit(limit)
      .offset(offset);

    res.json({ runs: result, limit, offset });
  } catch (err) {
    console.error("[Runs Service] Error listing runs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
