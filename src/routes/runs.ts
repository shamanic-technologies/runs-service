import { Router } from "express";
import { eq, and, gte, lte, desc, sql, inArray } from "drizzle-orm";
import { Decimal } from "decimal.js";
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
  BatchCostsRequestSchema,
} from "../schemas.js";

const router = Router();

// --- Cost breakdown helper ---

function computeCostBreakdown(costs: { totalCostInUsdCents: string | number; status: string }[]) {
  let actual = new Decimal(0);
  let provisioned = new Decimal(0);
  for (const c of costs) {
    if (c.status === "cancelled") continue;
    const amount = new Decimal(c.totalCostInUsdCents);
    if (c.status === "provisioned") {
      provisioned = provisioned.plus(amount);
    } else {
      actual = actual.plus(amount);
    }
  }
  return { total: actual.plus(provisioned), actual, provisioned };
}

// POST /v1/runs — create a run
router.post("/v1/runs", requireApiKey, async (req, res) => {
  try {
    const parsed = CreateRunRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { brandIds, campaignId, workflowSlug, featureSlug, serviceName, taskName } = parsed.data;
    const parentRunId = req.runId || null;

    // Priority: header > body (deprecated) > parent inheritance
    // If parent has a different non-null value than the resolved one, reject with 409
    let resolvedBrandIds = req.headerBrandIds || brandIds || null;
    let resolvedCampaignId = req.headerCampaignId || campaignId || null;
    let resolvedWorkflowSlug = req.headerWorkflowSlug || workflowSlug || null;
    let resolvedFeatureSlug = req.headerFeatureSlug || featureSlug || null;
    let resolvedOrgId = req.orgId;
    let resolvedUserId = req.userId || null;

    if (parentRunId) {
      const [parentRun] = await db
        .select({
          brandIds: runs.brandIds,
          campaignId: runs.campaignId,
          workflowSlug: runs.workflowSlug,
          featureSlug: runs.featureSlug,
          organizationId: runs.organizationId,
          userId: runs.userId,
        })
        .from(runs)
        .where(eq(runs.id, parentRunId))
        .limit(1);

      if (parentRun) {
        // Conflict detection: if both parent and resolved value are non-null and differ, reject
        const conflicts: string[] = [];
        if (resolvedBrandIds && parentRun.brandIds) {
          const sortedResolved = [...resolvedBrandIds].sort().join(",");
          const sortedParent = [...parentRun.brandIds].sort().join(",");
          if (sortedResolved !== sortedParent) {
            conflicts.push(`brandIds: request="${resolvedBrandIds.join(",")}" vs parent="${parentRun.brandIds.join(",")}"`);
          }
        }
        if (resolvedCampaignId && parentRun.campaignId && resolvedCampaignId !== parentRun.campaignId) {
          conflicts.push(`campaignId: request="${resolvedCampaignId}" vs parent="${parentRun.campaignId}"`);
        }
        if (resolvedWorkflowSlug && parentRun.workflowSlug && resolvedWorkflowSlug !== parentRun.workflowSlug) {
          conflicts.push(`workflowSlug: request="${resolvedWorkflowSlug}" vs parent="${parentRun.workflowSlug}"`);
        }
        if (resolvedFeatureSlug && parentRun.featureSlug && resolvedFeatureSlug !== parentRun.featureSlug) {
          conflicts.push(`featureSlug: request="${resolvedFeatureSlug}" vs parent="${parentRun.featureSlug}"`);
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
        if (!resolvedBrandIds) resolvedBrandIds = parentRun.brandIds;
        if (!resolvedCampaignId) resolvedCampaignId = parentRun.campaignId;
        if (!resolvedWorkflowSlug) resolvedWorkflowSlug = parentRun.workflowSlug;
        if (!resolvedFeatureSlug) resolvedFeatureSlug = parentRun.featureSlug;
        if (!resolvedUserId) resolvedUserId = parentRun.userId;
      }
    }

    const values = {
      organizationId: resolvedOrgId,
      userId: resolvedUserId,
      brandIds: resolvedBrandIds,
      campaignId: resolvedCampaignId,
      workflowSlug: resolvedWorkflowSlug,
      featureSlug: resolvedFeatureSlug,
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

// POST /v1/runs/costs/batch — batch cost lookup by run IDs
router.post("/v1/runs/costs/batch", requireApiKey, async (req, res) => {
  try {
    const parsed = BatchCostsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { runIds } = parsed.data;

    // Single recursive CTE: find each requested run + all its descendants,
    // tracking which root run ID each row belongs to.
    // Platform-only own-row aggregations gate on `d.id = d.root_run_id` to exclude descendants.
    const result = await db.execute(
      sql`WITH RECURSIVE descendants AS (
        SELECT id, id as root_run_id
        FROM runs
        WHERE id IN (${sql.join(runIds.map((id) => sql`${id}`), sql`, `)})
          AND organization_id = ${req.orgId}
        UNION ALL
        SELECT r.id, d.root_run_id
        FROM runs r
        INNER JOIN descendants d ON r.parent_run_id = d.id
      )
      SELECT
        d.root_run_id,
        COALESCE(SUM(CASE WHEN rc.status != 'cancelled' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as total_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'actual' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as actual_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'provisioned' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as provisioned_cost,
        COALESCE(SUM(CASE WHEN d.id = d.root_run_id AND rc.status = 'actual' AND rc.cost_source = 'platform' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as own_actual_platform_cost,
        COALESCE(SUM(CASE WHEN d.id = d.root_run_id AND rc.status = 'provisioned' AND rc.cost_source = 'platform' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0) as own_provisioned_platform_cost
      FROM descendants d
      LEFT JOIN runs_costs rc ON rc.run_id = d.id
      GROUP BY d.root_run_id`
    );

    const rows = result as any[];
    const costs = rows.map((row) => ({
      runId: row.root_run_id,
      totalCostInUsdCents: new Decimal(row.total_cost).toFixed(10),
      actualCostInUsdCents: new Decimal(row.actual_cost).toFixed(10),
      provisionedCostInUsdCents: new Decimal(row.provisioned_cost).toFixed(10),
      ownActualPlatformCostInUsdCents: new Decimal(row.own_actual_platform_cost).toFixed(10),
      ownProvisionedPlatformCostInUsdCents: new Decimal(row.own_provisioned_platform_cost).toFixed(10),
    }));

    res.json({ costs });
  } catch (err) {
    console.error("[Runs Service] Error in POST /v1/runs/costs/batch:", err);
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
      totalCostInUsdCents: ownBreakdown.total.plus(childrenBreakdown.total).toFixed(10),
      actualCostInUsdCents: ownBreakdown.actual.plus(childrenBreakdown.actual).toFixed(10),
      provisionedCostInUsdCents: ownBreakdown.provisioned.plus(childrenBreakdown.provisioned).toFixed(10),
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
        userId: req.userId || (run.userId ?? undefined),
        runId: req.runId || id,
        brandIds: req.headerBrandIds,
        campaignId: req.headerCampaignId,
        workflowSlug: req.headerWorkflowSlug,
        featureSlug: req.headerFeatureSlug,
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
      const total = new Decimal(item.quantity).times(unitCost).toFixed(10);
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
    const billingUserId = req.userId || run.userId;
    if (!billingUserId && costRows.some((r) => r.costSource === "platform")) {
      console.error(`[Runs Service] Cannot bill for run ${id}: no userId available from request or run record`);
      res.status(400).json({ error: "x-user-id header is required when adding platform cost items" });
      return;
    }

    const billingCtx: BillingContext = {
      orgId: req.orgId,
      userId: billingUserId!,
      runId: id,
      brandIds: req.headerBrandIds,
      campaignId: req.headerCampaignId,
      workflowSlug: req.headerWorkflowSlug,
      featureSlug: req.headerFeatureSlug,
    };

    // Deduct: sum actual + platform costs (raw fractional, no rounding)
    const actualPlatformCents = costRows
      .filter((r) => r.status === "actual" && r.costSource === "platform")
      .reduce((sum, r) => sum.plus(r.totalCostInUsdCents), new Decimal(0));

    if (actualPlatformCents.gt(0)) {
      const deductResult = await deductCredits(
        actualPlatformCents.toNumber(),
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

    // Provision: ONE call per provisioned + platform cost row, bound by cost_id
    // (raw fractional amount — billing-service stores numeric(16,10), no rounding)
    const provisionedPlatformRows = inserted.filter(
      (c) => c.status === "provisioned" && c.costSource === "platform",
    );

    if (provisionedPlatformRows.length > 0) {
      for (const row of provisionedPlatformRows) {
        const result = await provisionCredits(
          new Decimal(row.totalCostInUsdCents).toNumber(),
          `run:${id} cost:${row.id} (${row.costName})`,
          billingCtx,
          row.id,
        );
        await db
          .update(runsCosts)
          .set({ billingTransactionId: result.transaction_id })
          .where(eq(runsCosts.id, row.id));
      }

      // Re-read to return updated rows with billing_transaction_id
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
      // 4xx from billing-service is a real, actionable status from upstream — propagate.
      // 5xx / network / timeout signals upstream unavailability — surface as 502.
      if (err.statusCode >= 400 && err.statusCode < 500) {
        console.error(`[runs-service] billing-service ${err.statusCode}:`, err.message);
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      console.error(`[runs-service] billing-service unavailable (${err.statusCode}):`, err.message);
      res.status(502).json({ error: `billing-service unavailable: ${err.message}` });
      return;
    }
    if (err instanceof UpstreamError) {
      console.error(`[runs-service] costs-service unavailable (${err.statusCode}):`, err.message);
      res.status(502).json({ error: `costs-service unavailable: ${err.message}` });
      return;
    }
    console.error("[runs-service] Error adding run costs:", err);
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

    // Billing integration for platform costs with a provision.
    // Bound by cost_id (the runs_costs.id natural key), NOT the audit-only billing_transaction_id.
    if (existing.costSource === "platform" && existing.billingTransactionId) {
      const billingUserId = req.userId || run.userId;
      if (!billingUserId) {
        console.error(`[runs-service] Cannot bill for run ${id}: no userId available from request or run record`);
        res.status(400).json({ error: "x-user-id header is required when updating platform cost items" });
        return;
      }

      const billingCtx: BillingContext = {
        orgId: req.orgId,
        userId: billingUserId,
        runId: id,
        brandIds: req.headerBrandIds,
        campaignId: req.headerCampaignId,
        workflowSlug: req.headerWorkflowSlug,
        featureSlug: req.headerFeatureSlug,
      };

      if (existing.status === "provisioned" && newStatus === "actual") {
        // Confirm provision with raw fractional actual cost (no rounding)
        await confirmProvision(
          existing.id,
          new Decimal(existing.totalCostInUsdCents).toNumber(),
          billingCtx,
        );
      } else if (existing.status === "provisioned" && newStatus === "cancelled") {
        // Cancel provision — re-credits the org
        await cancelProvision(existing.id, billingCtx);
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
      if (err.statusCode >= 400 && err.statusCode < 500) {
        console.error(`[runs-service] billing-service ${err.statusCode}:`, err.message);
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      console.error(`[runs-service] billing-service unavailable (${err.statusCode}):`, err.message);
      res.status(502).json({ error: `billing-service unavailable: ${err.message}` });
      return;
    }
    console.error("[runs-service] Error updating cost:", err);
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
      workflowSlug,
      featureSlug,
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
    if (brandId) conditions.push(sql`${brandId} = ANY(${runs.brandIds})`);
    if (campaignId) conditions.push(eq(runs.campaignId, campaignId as string));
    if (workflowSlug) conditions.push(eq(runs.workflowSlug, workflowSlug as string));
    if (featureSlug) conditions.push(eq(runs.featureSlug, featureSlug as string));
    if (serviceName) conditions.push(eq(runs.serviceName, serviceName as string));
    if (taskName) conditions.push(eq(runs.taskName, taskName as string));
    if (status) conditions.push(eq(runs.status, status as string));
    if (parentRunId) conditions.push(eq(runs.parentRunId, parentRunId as string));
    if (startedAfter)
      conditions.push(gte(runs.startedAt, new Date(startedAfter as string)));
    if (startedBefore)
      conditions.push(lte(runs.startedAt, new Date(startedBefore as string)));

    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
    const limit = limitStr ? Number(limitStr) : undefined;
    const offset = offsetStr ? Number(offsetStr) : 0;

    // Select runs with own cost totals via LEFT JOIN + SUM
    const query = db
      .select({
        id: runs.id,
        parentRunId: runs.parentRunId,
        organizationId: runs.organizationId,
        userId: runs.userId,
        brandIds: runs.brandIds,
        campaignId: runs.campaignId,
        workflowSlug: runs.workflowSlug,
        featureSlug: runs.featureSlug,
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
        runs.brandIds,
        runs.campaignId,
        runs.workflowSlug,
        runs.featureSlug,
        runs.serviceName,
        runs.taskName,
        runs.status,
        runs.startedAt,
        runs.completedAt,
        runs.createdAt,
        runs.updatedAt,
      )
      .orderBy(desc(runs.startedAt));

    if (limit !== undefined) query.limit(limit);
    if (offset) query.offset(offset);

    const result = await query;

    // Format cost fields to fixed decimal
    const formattedRuns = result.map((r) => ({
      ...r,
      ownCostInUsdCents: new Decimal(r.ownCostInUsdCents).toFixed(10),
      ownActualCostInUsdCents: new Decimal(r.ownActualCostInUsdCents).toFixed(10),
      ownProvisionedCostInUsdCents: new Decimal(r.ownProvisionedCostInUsdCents).toFixed(10),
    }));

    res.json({ runs: formattedRuns, ...(limit !== undefined && { limit }), offset });
  } catch (err) {
    console.error("[Runs Service] Error listing runs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
