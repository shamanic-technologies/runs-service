import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { runs } from "../db/schema.js";
import { requireInternalAuth } from "../middleware/auth.js";
import { TransferBrandRequestSchema } from "../schemas.js";

const router = Router();

// POST /internal/transfer-brand — re-assign solo-brand runs to a different org
router.post("/internal/transfer-brand", requireInternalAuth, async (req, res) => {
  try {
    const parsed = TransferBrandRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

    // Step 1: Move org — solo-brand runs from sourceOrgId to targetOrgId
    const step1 = await db
      .update(runs)
      .set({ organizationId: targetOrgId, updatedAt: new Date() })
      .where(
        and(
          eq(runs.organizationId, sourceOrgId),
          sql`array_length(${runs.brandIds}, 1) = 1`,
          sql`${runs.brandIds}[1] = ${sourceBrandId}`
        )
      )
      .returning({ id: runs.id });

    // Step 2: Rewrite brand reference globally (no org filter) when targetBrandId is present
    let rewriteCount = 0;
    if (targetBrandId) {
      const step2 = await db
        .update(runs)
        .set({ brandIds: sql`ARRAY[${targetBrandId}]::text[]`, updatedAt: new Date() })
        .where(
          and(
            sql`array_length(${runs.brandIds}, 1) = 1`,
            sql`${runs.brandIds}[1] = ${sourceBrandId}`
          )
        )
        .returning({ id: runs.id });
      rewriteCount = step2.length;
    }

    const totalUpdated = Math.max(step1.length, rewriteCount);
    console.log(`[Runs Service] transfer-brand: moved ${step1.length} runs from org ${sourceOrgId} to ${targetOrgId} for brand ${sourceBrandId}${targetBrandId ? `, rewrote ${rewriteCount} brand refs → ${targetBrandId}` : ""}`);

    res.json({
      updatedTables: [{ tableName: "runs", count: totalUpdated }],
    });
  } catch (err) {
    console.error("[Runs Service] Error in POST /internal/transfer-brand:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
