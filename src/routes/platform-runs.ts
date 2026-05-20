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
  CreateRunRequestSchema,
  UpdateRunRequestSchema,
  AddCostsRequestSchema,
} from "../schemas.js";

const router = Router();

// POST /v1/platform-runs — create a run for a system-originated caller (cron, webhook, internal worker).
// x-org-id and x-user-id are optional — when provided, the run is attributed to that org/user.
router.post("/v1/platform-runs", requirePlatformAuth, async (req, res) => {
  try {
    const parsed = CreateRunRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { brandIds, campaignId, workflowSlug, featureSlug, serviceName, taskName, idempotencyKey } = parsed.data;

    // Idempotency pre-check: global uniqueness on runs.idempotency_key.
    if (idempotencyKey) {
      const [existing] = await db
        .select()
        .from(runs)
        .where(eq(runs.idempotencyKey, idempotencyKey))
        .limit(1);
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

    // Priority: header > body (deprecated). Org and user come from middleware (optional).
    const values = {
      organizationId: req.orgId ?? null,
      userId: req.userId ?? null,
      brandIds: req.headerBrandIds || brandIds || null,
      campaignId: req.headerCampaignId || campaignId || null,
      workflowSlug: req.headerWorkflowSlug || workflowSlug || null,
      featureSlug: req.headerFeatureSlug || featureSlug || null,
      serviceName,
      taskName,
      parentRunId: null,
      idempotencyKey: idempotencyKey ?? null,
    };

    let created;
    try {
      [created] = await db.insert(runs).values(values).returning();
    } catch (insertErr: any) {
      // Race-condition handling: concurrent request inserted same idempotencyKey between pre-check and insert.
      if (insertErr?.code === "23505" && idempotencyKey) {
        const [raceWinner] = await db
          .select()
          .from(runs)
          .where(eq(runs.idempotencyKey, idempotencyKey))
          .limit(1);
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
      throw insertErr;
    }

    res.status(201).json(created);
  } catch (err) {
    console.error("[Runs Service] Error creating platform run:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /v1/platform-runs/:id/costs — add cost line items to a platform run.
// Per-item idempotencyKey deduped via partial unique idx (run_id, idempotency_key).
// No notifyUsage call: billing-service /v1/customer_balance/usage_apply requires
// x-user-id + x-run-id headers, which platform-runs callers may not have. Truth still
// flows via GET /internal/org-usage-total on the next authorize.
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

    // Resolve unit costs from costs-service (use run record for identity context)
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
        idempotencyKey: item.idempotencyKey ?? null,
      };
    });

    // Insert with ON CONFLICT DO NOTHING — partial unique idx on (run_id, idempotency_key).
    const insertedRows = await db.insert(runsCosts).values(costRows).onConflictDoNothing().returning();

    // Fetch existing rows for items whose idempotencyKey conflicted.
    const insertedKeys = new Set(insertedRows.filter((r) => r.idempotencyKey).map((r) => r.idempotencyKey!));
    const missingKeys = costRows
      .filter((r) => r.idempotencyKey && !insertedKeys.has(r.idempotencyKey))
      .map((r) => r.idempotencyKey!);
    let existingByKey: typeof insertedRows = [];
    if (missingKeys.length > 0) {
      existingByKey = await db
        .select()
        .from(runsCosts)
        .where(and(eq(runsCosts.runId, id), inArray(runsCosts.idempotencyKey, missingKeys)));
    }
    const inserted = [...insertedRows, ...existingByKey];

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
