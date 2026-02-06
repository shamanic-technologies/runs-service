import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, organizations } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";

const router = Router();

// POST /v1/users — upsert user (externalId -> internalId)
router.post("/v1/users", requireApiKey, async (req, res) => {
  try {
    const { externalId, organizationId } = req.body;

    if (!externalId) {
      res.status(400).json({ error: "externalId is required" });
      return;
    }

    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }

    // Verify org exists
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    // Try to find existing
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.externalId, externalId))
      .limit(1);

    if (existing) {
      res.json(existing);
      return;
    }

    // Create new
    const [created] = await db
      .insert(users)
      .values({ externalId, organizationId })
      .returning();

    res.status(201).json(created);
  } catch (err) {
    console.error("[Runs Service] Error upserting user:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
