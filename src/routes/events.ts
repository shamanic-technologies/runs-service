import { Router } from "express";
import { eq, and, desc, asc, gt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs, runEvents } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { CreateRunEventRequestSchema } from "../schemas.js";

const router = Router();

// POST /v1/runs/:id/events — create a run event
router.post("/v1/runs/:id/events", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const parsed = CreateRunEventRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    // Verify run exists
    const [run] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);

    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const { service, event, detail, level, data } = parsed.data;

    const [created] = await db
      .insert(runEvents)
      .values({
        runId: id,
        service,
        event,
        detail: detail ?? null,
        level: level ?? "info",
        data: data ?? null,
        orgId: req.orgId ?? null,
        userId: req.userId ?? null,
        brandIds: req.headers["x-brand-id"] as string ?? null,
        campaignId: req.headerCampaignId ?? null,
        workflowSlug: req.headerWorkflowSlug ?? null,
        featureSlug: req.headerFeatureSlug ?? null,
      })
      .returning();

    res.status(201).json(created);
  } catch (err) {
    console.error("[runs-service] Error creating run event:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /v1/runs/:id/events — list events for a run
router.get("/v1/runs/:id/events", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const { level } = req.query;

    // Verify run exists
    const [run] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);

    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const conditions = [eq(runEvents.runId, id)];
    if (level) {
      conditions.push(eq(runEvents.level, level as string));
    }

    const events = await db
      .select()
      .from(runEvents)
      .where(and(...conditions))
      .orderBy(asc(runEvents.createdAt));

    res.json({ events });
  } catch (err) {
    console.error("[runs-service] Error listing run events:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /v1/runs/:id/events/stream — SSE stream events for a run
router.get("/v1/runs/:id/events/stream", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify run exists
    const [run] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);

    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let lastId: string | null = null;

    const poll = async () => {
      const conditions = [eq(runEvents.runId, id)];
      if (lastId) {
        conditions.push(gt(runEvents.id, lastId));
      }

      const events = await db
        .select()
        .from(runEvents)
        .where(and(...conditions))
        .orderBy(asc(runEvents.createdAt));

      for (const event of events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        lastId = event.id;
      }
    };

    // Initial poll
    await poll();

    const interval = setInterval(async () => {
      try {
        await poll();
      } catch (err) {
        console.error("[runs-service] SSE poll error:", err);
        clearInterval(interval);
        res.end();
      }
    }, 1000);

    req.on("close", () => {
      clearInterval(interval);
    });
  } catch (err) {
    console.error("[runs-service] Error streaming run events:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /v1/events — list events across all runs
router.get("/v1/events", requireApiKey, async (req, res) => {
  try {
    const {
      service,
      orgId,
      brandId,
      campaignId,
      workflowSlug,
      featureSlug,
      level,
      limit: limitStr,
      offset: offsetStr,
    } = req.query;

    const conditions: ReturnType<typeof eq>[] = [];

    if (service) conditions.push(eq(runEvents.service, service as string));
    if (orgId) conditions.push(eq(runEvents.orgId, orgId as string));
    if (brandId) conditions.push(sql`${runEvents.brandIds} LIKE '%' || ${brandId as string} || '%'`);
    if (campaignId) conditions.push(eq(runEvents.campaignId, campaignId as string));
    if (workflowSlug) conditions.push(eq(runEvents.workflowSlug, workflowSlug as string));
    if (featureSlug) conditions.push(eq(runEvents.featureSlug, featureSlug as string));
    if (level) conditions.push(eq(runEvents.level, level as string));

    const limit = limitStr ? Number(limitStr) : undefined;
    const offset = offsetStr ? Number(offsetStr) : 0;

    const baseQuery = db
      .select()
      .from(runEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(runEvents.createdAt))
      .offset(offset);

    const events = limit !== undefined ? await baseQuery.limit(limit) : await baseQuery;

    res.json({ events });
  } catch (err) {
    console.error("[runs-service] Error listing events:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
