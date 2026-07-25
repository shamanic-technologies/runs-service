import { Router } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { runs, runsCosts } from "../db/schema.js";
import { requirePlatformAuth } from "../middleware/auth.js";
import {
  resolveMultipleUnitCosts,
  CostNotFoundError,
  UpstreamError,
} from "../services/cost-resolver.js";
import {
  logRunLifecycle,
  logCostLifecycle,
  newRunId,
  newCostId,
  type Identity,
} from "../services/bronze.js";
import { costAttribution, requestAttribution } from "../services/attribution.js";
import {
  resolveUsageDiscount,
  netFromGross,
  UsageDiscountError,
} from "../services/usage-discount.js";
import {
  CreateRunRequestSchema,
  UpdateRunRequestSchema,
  AddCostsRequestSchema,
} from "../schemas.js";

const router = Router();

// Phase 2+5 — POST /v1/platform-runs. App writes only to bronze; trigger projects silver.
router.post("/v1/platform-runs", requirePlatformAuth, async (req, res) => {
  try {
    const parsed = CreateRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const {
      brandIds,
      campaignId,
      workflowSlug,
      featureSlug,
      goal,
      brandProfileId,
      audienceId,
      workflowContext,
      serviceName,
      taskName,
      idempotencyKey,
    } = parsed.data;

    if (idempotencyKey) {
      const [existing] = await db.select().from(runs).where(eq(runs.idempotencyKey, idempotencyKey)).limit(1);
      if (existing) {
        if (existing.serviceName !== serviceName || existing.taskName !== taskName) {
          res.status(409).json({
            error: "idempotencyKey collision with different (serviceName, taskName)",
            existing: { id: existing.id, serviceName: existing.serviceName, taskName: existing.taskName },
          });
          return;
        }
        res.status(200).json(existing);
        return;
      }
    }

    const id = newRunId();
    const attribution = requestAttribution(req, {
      goal,
      brandProfileId,
      audienceId,
      workflowContext,
    });
    const identity: Identity = {
      orgId: req.orgId ?? null,
      userId: req.userId ?? null,
      brandIds: req.headerBrandIds ?? brandIds ?? null,
      campaignId: req.headerCampaignId ?? campaignId ?? null,
      workflowSlug: req.headerWorkflowSlug ?? workflowSlug ?? null,
      featureSlug: req.headerFeatureSlug ?? featureSlug ?? null,
      ...attribution,
    };
    const payload = {
      runId: id,
      parentRunId: null,
      organizationId: req.orgId ?? null,
      userId: req.userId ?? null,
      brandIds: req.headerBrandIds ?? brandIds ?? null,
      campaignId: req.headerCampaignId ?? campaignId ?? null,
      workflowSlug: req.headerWorkflowSlug ?? workflowSlug ?? null,
      featureSlug: req.headerFeatureSlug ?? featureSlug ?? null,
      ...attribution,
      serviceName,
      taskName,
      idempotencyKey: idempotencyKey ?? null,
    };

    try {
      const created = await db.transaction(async (tx) => {
        await logRunLifecycle(tx, {
          runId: id,
          eventType: "run.created",
          payload,
          identity,
          sourceService: req.platformServiceName ?? null,
          idempotencyKey: idempotencyKey ?? null,
        });
        const [silver] = await tx.select().from(runs).where(eq(runs.id, id)).limit(1);
        return silver;
      });
      res.status(201).json(created);
    } catch (err: any) {
      if (err?.code === "23505" && idempotencyKey) {
        const [raceWinner] = await db.select().from(runs).where(eq(runs.idempotencyKey, idempotencyKey)).limit(1);
        if (raceWinner) {
          if (raceWinner.serviceName !== serviceName || raceWinner.taskName !== taskName) {
            res.status(409).json({
              error: "idempotencyKey collision with different (serviceName, taskName)",
              existing: { id: raceWinner.id, serviceName: raceWinner.serviceName, taskName: raceWinner.taskName },
            });
            return;
          }
          res.status(200).json(raceWinner);
          return;
        }
      }
      throw err;
    }
  } catch (err) {
    console.error("[runs-service] Error creating platform run:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Phase 2+5 — POST /v1/platform-runs/:id/costs. Bronze-only writes; trigger projects silver.
// No notifyUsage per CLAUDE.md "Idempotency on silver writes" — billing-service re-derives
// via GET /internal/org-usage-total on next authorize.
router.post("/v1/platform-runs/:id/costs", requirePlatformAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const parsed = AddCostsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { items } = parsed.data;

    const [run] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const names = items.map((i) => i.costName);
    let costMap: Map<string, string>;
    try {
      costMap = await resolveMultipleUnitCosts(names, {
        orgId: run.organizationId ?? undefined,
        userId: run.userId ?? undefined,
        runId: id,
      });
    } catch (err) {
      if (err instanceof CostNotFoundError) {
        res.status(422).json({ error: `Unknown cost: ${err.costName}` });
        return;
      }
      throw err;
    }

    const keyed = items.filter((i) => i.idempotencyKey);
    const existingByKey = new Map<string, any>();
    if (keyed.length > 0) {
      const existing = await db
        .select()
        .from(runsCosts)
        .where(and(eq(runsCosts.runId, id), inArray(runsCosts.idempotencyKey, keyed.map((i) => i.idempotencyKey!))));
      for (const row of existing) existingByKey.set(row.idempotencyKey!, row);
    }

    // Freeze the org's usage discount at write time. Platform runs may carry an
    // org (run.organizationId) or be org-less; org-less → no discount → net==gross.
    const discountPct = await resolveUsageDiscount(run.organizationId ?? undefined);
    const discountPctStr = discountPct.gt(0) ? discountPct.toFixed(8) : null;

    const itemsToCreate: Array<{ item: typeof items[number]; costId: string; total: string; net: string }> = [];
    for (const item of items) {
      if (item.idempotencyKey && existingByKey.has(item.idempotencyKey)) continue;
      const unitCost = costMap.get(item.costName)!;
      const total = new Decimal(item.quantity).times(unitCost).toFixed(10);
      const net = netFromGross(total, discountPct);
      itemsToCreate.push({ item, costId: newCostId(), total, net });
    }

    const newRows = await db.transaction(async (tx) => {
      for (const { item, costId, total, net } of itemsToCreate) {
        const unitCost = costMap.get(item.costName)!;
        const attribution = costAttribution(item, req, run);
        await logCostLifecycle(tx, {
          runId: id,
          costId,
          eventType: "cost.added",
          payload: {
            costId,
            costName: item.costName,
            costSource: item.costSource,
            quantity: String(item.quantity),
            unitCostInUsdCents: unitCost,
            totalCostInUsdCents: total,
            netCostInUsdCents: net,
            usageDiscountPct: discountPctStr,
            status: item.status ?? "actual",
            // Denormalized org (migration 0029): the RUN's org (may be NULL for
            // org-less platform runs). org-spend SUMs never count NULL-org rows.
            runOrganizationId: run.organizationId ?? null,
            ...attribution,
            idempotencyKey: item.idempotencyKey ?? null,
          },
          identity: {
            orgId: run.organizationId,
            userId: run.userId,
            brandIds: run.brandIds,
            campaignId: run.campaignId,
            workflowSlug: run.workflowSlug,
            featureSlug: run.featureSlug,
            ...attribution,
          },
          idempotencyKey: item.idempotencyKey ?? null,
        });
      }
      if (itemsToCreate.length === 0) return [] as any[];
      return await tx
        .select()
        .from(runsCosts)
        .where(inArray(runsCosts.id, itemsToCreate.map((c) => c.costId)));
    });

    const inserted: any[] = [];
    let createdIdx = 0;
    for (const item of items) {
      if (item.idempotencyKey && existingByKey.has(item.idempotencyKey)) {
        inserted.push(existingByKey.get(item.idempotencyKey));
      } else {
        inserted.push(newRows[createdIdx]);
        createdIdx++;
      }
    }

    res.status(201).json({ costs: inserted });
  } catch (err) {
    if (err instanceof UpstreamError) {
      console.error(`[runs-service] costs-service unavailable (${err.statusCode}):`, err.message);
      res.status(502).json({ error: `costs-service unavailable: ${err.message}` });
      return;
    }
    if (err instanceof UsageDiscountError) {
      console.error(`[runs-service] usage-discount unresolvable (${err.statusCode}):`, err.message);
      res.status(502).json({ error: `usage-discount unresolvable: ${err.message}` });
      return;
    }
    console.error("[runs-service] Error adding platform run costs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Phase 2+5 — PATCH /v1/platform-runs/:id.
router.patch("/v1/platform-runs/:id", requirePlatformAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const parsed = UpdateRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { status } = parsed.data;
    const eventType = status === "completed" ? "run.completed" : "run.failed";

    const updated = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(runs).where(eq(runs.id, id)).limit(1);
      if (!existing) return null;
      await logRunLifecycle(tx, {
        runId: id,
        eventType,
        payload: { from: existing.status, to: status },
        identity: {
          orgId: existing.organizationId,
          userId: existing.userId,
          brandIds: existing.brandIds,
          campaignId: existing.campaignId,
          workflowSlug: existing.workflowSlug,
          featureSlug: existing.featureSlug,
          goal: existing.goal,
          brandProfileId: existing.brandProfileId,
          audienceId: existing.audienceId,
          workflowContext: existing.workflowContext,
        },
        sourceService: req.platformServiceName ?? null,
      });
      const [row] = await tx.select().from(runs).where(eq(runs.id, id)).limit(1);
      return row;
    });

    if (!updated) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error("[runs-service] Error updating platform run:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
