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

    // Update runs where org_id = sourceOrgId AND brand_ids has exactly one element AND that element is sourceBrandId
    // When targetBrandId is present, also rewrite the brand reference
    const setClause: Record<string, unknown> = { organizationId: targetOrgId, updatedAt: new Date() };
    if (targetBrandId) {
      setClause.brandIds = sql`ARRAY[${targetBrandId}]::text[]`;
    }

    const result = await db
      .update(runs)
      .set(setClause)
      .where(
        and(
          eq(runs.organizationId, sourceOrgId),
          sql`array_length(${runs.brandIds}, 1) = 1`,
          sql`${runs.brandIds}[1] = ${sourceBrandId}`
        )
      )
      .returning({ id: runs.id });

    console.log(`[Runs Service] transfer-brand: moved ${result.length} runs from org ${sourceOrgId} to ${targetOrgId} for brand ${sourceBrandId}${targetBrandId ? ` → ${targetBrandId}` : ""}`);

    res.json({
      updatedTables: [{ tableName: "runs", count: result.length }],
    });
  } catch (err) {
    console.error("[Runs Service] Error in POST /internal/transfer-brand:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
