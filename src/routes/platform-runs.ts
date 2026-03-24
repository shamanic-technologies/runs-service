import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, runsCosts } from "../db/schema.js";
import { requirePlatformAuth } from "../middleware/auth.js";
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

// POST /v1/platform-runs — create a platform-level run (no org/user)
router.post("/v1/platform-runs", requirePlatformAuth, async (req, res) => {
  try {
    const parsed = CreateRunRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { brandId, campaignId, workflowName, featureSlug, serviceName, taskName } = parsed.data;

    // Priority: header > body (deprecated)
    const values = {
      organizationId: null,
      userId: null,
      brandId: req.headerBrandId || brandId || null,
      campaignId: req.headerCampaignId || campaignId || null,
      workflowName: req.headerWorkflowName || workflowName || null,
      featureSlug: req.headerFeatureSlug || featureSlug || null,
      serviceName,
      taskName,
      parentRunId: null,
    };

    const [created] = await db.insert(runs).values(values).returning();

    res.status(201).json(created);
  } catch (err) {
    console.error("[Runs Service] Error creating platform run:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /v1/platform-runs/:id/costs — add cost line items to a platform run
router.post("/v1/platform-runs/:id/costs", requirePlatformAuth, async (req, res) => {
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

    // Resolve unit costs from costs-service (no org context for platform runs)
    const names = items.map((i) => i.costName);
    let costMap: Map<string, string>;
    try {
      costMap = await resolveMultipleUnitCosts(names, {});
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

    res.status(201).json({ costs: inserted });
  } catch (err) {
    if (err instanceof UpstreamError) {
      console.error(`[Runs Service] costs-service unavailable (${err.statusCode}):`, err.message);
      res.status(502).json({ error: `costs-service unavailable: ${err.message}` });
      return;
    }
    console.error("[Runs Service] Error adding platform run costs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /v1/platform-runs/:id — update platform run status
router.patch("/v1/platform-runs/:id", requirePlatformAuth, async (req, res) => {
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
    console.error("[Runs Service] Error updating platform run:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
