import { Router } from "express";
import { eq, and, gte, lte, desc, sql, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, runsCosts } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  resolveMultipleUnitCosts,
  CostNotFoundError,
  UpstreamError,
} from "../services/cost-resolver.js";
import {
  deductCredits,
  provisionCredits,
  confirmProvision,
  cancelProvision,
  BillingError,
} from "../services/billing.js";
import type { BillingContext } from "../services/billing.js";
import {
  CreateRunRequestSchema,
  UpdateRunRequestSchema,
  AddCostsRequestSchema,
  UpdateCostRequestSchema,
} from "../schemas.js";

const router = Router();

// --- Cost breakdown helper ---

function computeCostBreakdown(costs: { totalCostInUsdCents: string | number; status: string }[]) {
  let actual = 0;
  let provisioned = 0;
  for (const c of costs) {
    if (c.status === "cancelled") continue;
    const amount = Number(c.totalCostInUsdCents);
    if (c.status === "provisioned") {
      provisioned += amount;
    } else {
      actual += amount;
    }
  }
  return { total: actual + provisioned, actual, provisioned };
}

// POST /v1/runs — create a run
router.post("/v1/runs", requireApiKey, async (req, res) => {
  try {
    const parsed = CreateRunRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { brandId, campaignId, workflowName, serviceName, taskName } = parsed.data;
    const parentRunId = req.runId || null;

    // Priority: header > body (deprecated) > parent inheritance
    // If parent has a different non-null value than the resolved one, reject with 409
    let resolvedBrandId = req.headerBrandId || brandId || null;
    let resolvedCampaignId = req.headerCampaignId || campaignId || null;
    let resolvedWorkflowName = req.headerWorkflowName || workflowName || null;
    let resolvedOrgId = req.orgId;
    let resolvedUserId = req.userId || null;

    if (parentRunId) {
      const [parentRun] = await db
        .select({
          brandId: runs.brandId,
          campaignId: runs.campaignId,
          workflowName: runs.workflowName,
          organizationId: runs.organizationId,
          userId: runs.userId,
        })
        .from(runs)
        .where(eq(runs.id, parentRunId))
        .limit(1);

      if (parentRun) {
        // Conflict detection: if both parent and resolved value are non-null and differ, reject
        const conflicts: string[] = [];
        if (resolvedBrandId && parentRun.brandId && resolvedBrandId !== parentRun.brandId) {
          conflicts.push(`brandId: request="${resolvedBrandId}" vs parent="${parentRun.brandId}"`);
        }
        if (resolvedCampaignId && parentRun.campaignId && resolvedCampaignId !== parentRun.campaignId) {
          conflicts.push(`campaignId: request="${resolvedCampaignId}" vs parent="${parentRun.campaignId}"`);
        }
        if (resolvedWorkflowName && parentRun.workflowName && resolvedWorkflowName !== parentRun.workflowName) {
          conflicts.push(`workflowName: request="${resolvedWorkflowName}" vs parent="${parentRun.workflowName}"`);
        }
        if (parentRun.organizationId && resolvedOrgId !== parentRun.organizationId) {
          conflicts.push(`orgId: request="${resolvedOrgId}" vs parent="${parentRun.organizationId}"`);
        }
        if (resolvedUserId && parentRun.userId && resolvedUserId !== parentRun.userId) {
          conflicts.push(`userId: request="${resolvedUserId}" vs parent="${parentRun.userId}"`);
        }

        if (conflicts.length > 0) {
          console.error(`[Runs Service] Parent-child conflict on run ${parentRunId}: ${conflicts.join(", ")}`);
          res.status(409).json({
            error: "Parent-child field conflict",
            conflicts,
          });
          return;
        }

        // Inherit from parent when resolved value is absent
        if (!resolvedBrandId) resolvedBrandId = parentRun.brandId;
        if (!resolvedCampaignId) resolvedCampaignId = parentRun.campaignId;
        if (!resolvedWorkflowName) resolvedWorkflowName = parentRun.workflowName;
        if (!resolvedUserId) resolvedUserId = parentRun.userId;
      }
    }

    const values = {
      organizationId: resolvedOrgId,
      userId: resolvedUserId,
      brandId: resolvedBrandId,
      campaignId: resolvedCampaignId,
      workflowName: resolvedWorkflowName,
      serviceName,
      taskName,
      parentRunId,
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

    const ownBreakdown = computeCostBreakdown(costs);

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
      const breakdown = computeCostBreakdown(runCosts);
      return {
        id: r.id,
        parentRunId: r.parent_run_id,
        serviceName: r.service_name,
        taskName: r.task_name,
        status: r.status,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        costs: runCosts,
        ownCostInUsdCents: breakdown.total.toFixed(10),
        ownActualCostInUsdCents: breakdown.actual.toFixed(10),
        ownProvisionedCostInUsdCents: breakdown.provisioned.toFixed(10),
      };
    });

    const childrenBreakdown = computeCostBreakdown(allDescendantCosts);

    res.json({
      ...run,
      costs,
      totalCostInUsdCents: (ownBreakdown.total + childrenBreakdown.total).toFixed(10),
      actualCostInUsdCents: (ownBreakdown.actual + childrenBreakdown.actual).toFixed(10),
      provisionedCostInUsdCents: (ownBreakdown.provisioned + childrenBreakdown.provisioned).toFixed(10),
      ownCostInUsdCents: ownBreakdown.total.toFixed(10),
      ownActualCostInUsdCents: ownBreakdown.actual.toFixed(10),
      ownProvisionedCostInUsdCents: ownBreakdown.provisioned.toFixed(10),
      childrenCostInUsdCents: childrenBreakdown.total.toFixed(10),
      childrenActualCostInUsdCents: childrenBreakdown.actual.toFixed(10),
      childrenProvisionedCostInUsdCents: childrenBreakdown.provisioned.toFixed(10),
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
      costMap = await resolveMultipleUnitCosts(names, {
        orgId: req.orgId,
        userId: req.userId,
        runId: req.runId,
        brandId: req.headerBrandId,
        campaignId: req.headerCampaignId,
        workflowName: req.headerWorkflowName,
      });
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
        costSource: item.costSource,
        quantity: String(item.quantity),
        unitCostInUsdCents: unitCost,
        totalCostInUsdCents: total,
        status: item.status ?? "actual",
      };
    });

    // Insert costs
    const inserted = await db.insert(runsCosts).values(costRows).returning();

    // --- Billing integration ---
    const billingCtx: BillingContext = {
      orgId: req.orgId,
      userId: req.userId,
      runId: req.runId,
      brandId: req.headerBrandId,
      campaignId: req.headerCampaignId,
      workflowName: req.headerWorkflowName,
    };

    // Deduct: sum actual + platform costs
    const actualPlatformCents = costRows
      .filter((r) => r.status === "actual" && r.costSource === "platform")
      .reduce((sum, r) => sum + Number(r.totalCostInUsdCents), 0);

    if (actualPlatformCents > 0) {
      const deductResult = await deductCredits(
        actualPlatformCents,
        `run:${id} — ${costRows.filter((r) => r.status === "actual" && r.costSource === "platform").length} cost items`,
        billingCtx,
      );
      if (!deductResult.success) {
        console.error(`[Runs Service] Billing deduction failed for run ${id}: depleted=${deductResult.depleted}`);
        res.status(402).json({
          error: "Credit deduction failed",
          costs: inserted,
          billing: deductResult,
        });
        return;
      }
    }

    // Provision: sum provisioned + platform costs
    const provisionedPlatformItems = costRows
      .filter((r) => r.status === "provisioned" && r.costSource === "platform");
    const provisionedPlatformCents = provisionedPlatformItems
      .reduce((sum, r) => sum + Number(r.totalCostInUsdCents), 0);

    if (provisionedPlatformCents > 0) {
      const provisionResult = await provisionCredits(
        provisionedPlatformCents,
        `run:${id} — ${provisionedPlatformItems.length} provisioned items`,
        billingCtx,
      );

      // Store billing_provision_id on all provisioned platform cost rows
      const provisionedInsertedIds = inserted
        .filter((c) => c.status === "provisioned" && c.costSource === "platform")
        .map((c) => c.id);

      if (provisionedInsertedIds.length > 0) {
        await db
          .update(runsCosts)
          .set({ billingProvisionId: provisionResult.provision_id })
          .where(inArray(runsCosts.id, provisionedInsertedIds));
      }

      // Re-read to return updated rows with billing_provision_id
      const updatedCosts = await db
        .select()
        .from(runsCosts)
        .where(inArray(runsCosts.id, inserted.map((c) => c.id)));

      res.status(201).json({ costs: updatedCosts });
      return;
    }

    res.status(201).json({ costs: inserted });
  } catch (err) {
    if (err instanceof BillingError) {
      console.error(`[Runs Service] billing-service unavailable (${err.statusCode}):`, err.message);
      res.status(502).json({ error: `billing-service unavailable: ${err.message}` });
      return;
    }
    if (err instanceof UpstreamError) {
      console.error(`[Runs Service] costs-service unavailable (${err.statusCode}):`, err.message);
      res.status(502).json({ error: `costs-service unavailable: ${err.message}` });
      return;
    }
    console.error("[Runs Service] Error adding run costs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /v1/runs/:id/costs/:costId — update a cost item (e.g. realize a provision)
router.patch("/v1/runs/:id/costs/:costId", requireApiKey, async (req, res) => {
  try {
    const { id, costId } = req.params;

    const parsed = UpdateCostRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    // Verify run exists
    const [run] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    // Read the existing cost item before updating
    const [existing] = await db
      .select()
      .from(runsCosts)
      .where(and(eq(runsCosts.id, costId), eq(runsCosts.runId, id)))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Cost not found" });
      return;
    }

    const newStatus = parsed.data.status;

    // Billing integration for platform costs with a provision
    if (existing.costSource === "platform" && existing.billingProvisionId) {
      const billingCtx: BillingContext = {
        orgId: req.orgId,
        userId: req.userId,
        runId: req.runId,
        brandId: req.headerBrandId,
        campaignId: req.headerCampaignId,
        workflowName: req.headerWorkflowName,
      };

      if (existing.status === "provisioned" && newStatus === "actual") {
        // Confirm provision with the actual cost
        await confirmProvision(
          existing.billingProvisionId,
          Number(existing.totalCostInUsdCents),
          billingCtx,
        );
      } else if (existing.status === "provisioned" && newStatus === "cancelled") {
        // Cancel provision — re-credits the org
        await cancelProvision(existing.billingProvisionId, billingCtx);
      }
    }

    // Update the cost row
    const [updated] = await db
      .update(runsCosts)
      .set({ status: newStatus })
      .where(and(eq(runsCosts.id, costId), eq(runsCosts.runId, id)))
      .returning();

    res.json(updated);
  } catch (err) {
    if (err instanceof BillingError) {
      console.error(`[Runs Service] billing-service error (${err.statusCode}):`, err.message);
      res.status(502).json({ error: `billing-service unavailable: ${err.message}` });
      return;
    }
    console.error("[Runs Service] Error updating cost:", err);
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
      userId,
      brandId,
      campaignId,
      workflowName,
      serviceName,
      taskName,
      status,
      parentRunId,
      startedAfter,
      startedBefore,
      limit: limitStr,
      offset: offsetStr,
    } = req.query;

    const conditions = [eq(runs.organizationId, req.orgId)];

    if (userId) conditions.push(eq(runs.userId, userId as string));
    if (brandId) conditions.push(eq(runs.brandId, brandId as string));
    if (campaignId) conditions.push(eq(runs.campaignId, campaignId as string));
    if (workflowName) conditions.push(eq(runs.workflowName, workflowName as string));
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
        brandId: runs.brandId,
        campaignId: runs.campaignId,
        workflowName: runs.workflowName,
        serviceName: runs.serviceName,
        taskName: runs.taskName,
        status: runs.status,
        startedAt: runs.startedAt,
        completedAt: runs.completedAt,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
        ownCostInUsdCents: sql<string>`COALESCE(SUM(CASE WHEN ${runsCosts.status} != 'cancelled' THEN ${runsCosts.totalCostInUsdCents} ELSE 0 END), 0)`.as("own_cost_in_usd_cents"),
        ownActualCostInUsdCents: sql<string>`COALESCE(SUM(CASE WHEN ${runsCosts.status} = 'actual' THEN ${runsCosts.totalCostInUsdCents} ELSE 0 END), 0)`.as("own_actual_cost_in_usd_cents"),
        ownProvisionedCostInUsdCents: sql<string>`COALESCE(SUM(CASE WHEN ${runsCosts.status} = 'provisioned' THEN ${runsCosts.totalCostInUsdCents} ELSE 0 END), 0)`.as("own_provisioned_cost_in_usd_cents"),
      })
      .from(runs)
      .leftJoin(runsCosts, eq(runsCosts.runId, runs.id))
      .where(whereClause)
      .groupBy(
        runs.id,
        runs.parentRunId,
        runs.organizationId,
        runs.userId,
        runs.brandId,
        runs.campaignId,
        runs.workflowName,
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

    // Format cost fields to fixed decimal
    const formattedRuns = result.map((r) => ({
      ...r,
      ownCostInUsdCents: Number(r.ownCostInUsdCents).toFixed(10),
      ownActualCostInUsdCents: Number(r.ownActualCostInUsdCents).toFixed(10),
      ownProvisionedCostInUsdCents: Number(r.ownProvisionedCostInUsdCents).toFixed(10),
    }));

    res.json({ runs: formattedRuns, limit, offset });
  } catch (err) {
    console.error("[Runs Service] Error listing runs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
