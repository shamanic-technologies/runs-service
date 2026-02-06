import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { organizations } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";

const router = Router();

// POST /v1/organizations — upsert org (externalId -> internalId)
router.post("/v1/organizations", requireApiKey, async (req, res) => {
  try {
    const { externalId } = req.body;

    if (!externalId) {
      res.status(400).json({ error: "externalId is required" });
      return;
    }

    // Try to find existing
    const [existing] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.externalId, externalId))
      .limit(1);

    if (existing) {
      res.json(existing);
      return;
    }

    // Create new
    const [created] = await db
      .insert(organizations)
      .values({ externalId })
      .returning();

    res.status(201).json(created);
  } catch (err) {
    console.error("[Runs Service] Error upserting organization:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
