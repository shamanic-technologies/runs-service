import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { runLifecycleEvents, costLifecycleEvents } from "../../src/db/schema.js";
import {
  cleanTestData,
  insertTestRun,
  insertTestRunCost,
  closeDb,
} from "../helpers/test-db.js";

// Phase 1 of B/S/G substrate (γ migration plan).
// Verifies the generated cost-predicate columns + bronze event tables in
// isolation. No route changes here.
// File-local org IDs keep this isolated from other parallel integration files.
//
// The gold-layer rollup is NOT a view: v_run_cost_rollup / v_org_platform_spend
// / v_runs_with_descendants were dropped in migration 0026 (their unbounded walk
// OOMed prod — see df9230e). Descendant cost rollup is read via inline bounded
// recursive CTEs; that behaviour is exercised against the real endpoints in
// batch-costs.test.ts and bsg-phase2-5.test.ts.
const ORG_ID = "dddddddd-1111-4ddd-1ddd-111111111111";
const OTHER_ORG_ID = "dddddddd-2222-4ddd-2ddd-222222222222";
const CLEANUP_ORG_IDS = [ORG_ID, OTHER_ORG_ID];

describe("B/S/G substrate — Phase 1", () => {
  beforeEach(async () => {
    await cleanTestData(CLEANUP_ORG_IDS);
    // Bronze has no FK to runs so cascade-delete does not clear it.
    // Phase 1 has no handlers writing bronze yet, but tests in this file insert directly.
    await db.delete(runLifecycleEvents);
    await db.delete(costLifecycleEvents);
  });

  afterAll(async () => {
    await cleanTestData(CLEANUP_ORG_IDS);
    await db.delete(runLifecycleEvents);
    await db.delete(costLifecycleEvents);
    await closeDb();
  });

  describe("generated cost-predicate columns (runs_costs)", () => {
    it("platform + actual → both flags true", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "t" });
      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "x",
        costSource: "platform",
        quantity: "1",
        unitCostInUsdCents: "1.0000000000",
        totalCostInUsdCents: "1.0000000000",
        status: "actual",
      });

      const result = await db.execute(sql`
        SELECT is_platform_projected, is_platform_committed
        FROM runs_costs WHERE id = ${cost.id}
      `);
      const row = (result as any[])[0];
      expect(row.is_platform_projected).toBe(true);
      expect(row.is_platform_committed).toBe(true);
    });

    it("platform + provisioned → projected=true, committed=false", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "t" });
      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "x",
        costSource: "platform",
        quantity: "1",
        unitCostInUsdCents: "1.0000000000",
        totalCostInUsdCents: "1.0000000000",
        status: "provisioned",
      });
      const result = await db.execute(sql`
        SELECT is_platform_projected, is_platform_committed
        FROM runs_costs WHERE id = ${cost.id}
      `);
      const row = (result as any[])[0];
      expect(row.is_platform_projected).toBe(true);
      expect(row.is_platform_committed).toBe(false);
    });

    it("platform + cancelled → both flags false", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "t" });
      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "x",
        costSource: "platform",
        quantity: "1",
        unitCostInUsdCents: "1.0000000000",
        totalCostInUsdCents: "1.0000000000",
        status: "cancelled",
      });
      const result = await db.execute(sql`
        SELECT is_platform_projected, is_platform_committed
        FROM runs_costs WHERE id = ${cost.id}
      `);
      const row = (result as any[])[0];
      expect(row.is_platform_projected).toBe(false);
      expect(row.is_platform_committed).toBe(false);
    });

    it("org source → both flags false regardless of status", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "t" });
      const actual = await insertTestRunCost({
        runId: run.id,
        costName: "x",
        costSource: "org",
        quantity: "1",
        unitCostInUsdCents: "1.0000000000",
        totalCostInUsdCents: "1.0000000000",
        status: "actual",
      });
      const provisioned = await insertTestRunCost({
        runId: run.id,
        costName: "y",
        costSource: "org",
        quantity: "1",
        unitCostInUsdCents: "1.0000000000",
        totalCostInUsdCents: "1.0000000000",
        status: "provisioned",
      });
      const result = await db.execute(sql`
        SELECT id, is_platform_projected, is_platform_committed
        FROM runs_costs WHERE id IN (${actual.id}, ${provisioned.id})
      `);
      for (const row of result as any[]) {
        expect(row.is_platform_projected).toBe(false);
        expect(row.is_platform_committed).toBe(false);
      }
    });

    it("partial index idx_runs_costs_projected exists and is partial", async () => {
      const result = await db.execute(sql`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_runs_costs_projected'
      `);
      const row = (result as any[])[0];
      expect(row).toBeDefined();
      expect(String(row.indexdef)).toContain("WHERE is_platform_projected");
    });
  });

  describe("bronze event tables", () => {
    it("run_lifecycle_events accepts inserts with jsonb payload", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "t" });
      const [inserted] = await db
        .insert(runLifecycleEvents)
        .values({
          runId: run.id,
          eventType: "run.created",
          payload: { serviceName: "s", taskName: "t", brandIds: ["b1"] },
          sourceService: "test",
          identity: { orgId: ORG_ID },
          idempotencyKey: "test:run.created:1",
          correlationId: "req_abc123",
        })
        .returning();
      expect(inserted.id).toBeDefined();
      expect(inserted.runId).toBe(run.id);
      expect(inserted.eventType).toBe("run.created");
      expect(inserted.payload).toMatchObject({ serviceName: "s", taskName: "t" });
      expect(inserted.occurredAt).toBeInstanceOf(Date);
    });

    it("cost_lifecycle_events accepts inserts with nullable cost_id", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "t" });
      const [inserted] = await db
        .insert(costLifecycleEvents)
        .values({
          runId: run.id,
          costId: null,
          eventType: "cost.added",
          payload: { costName: "gpt-4o", quantity: "100", status: "actual" },
          identity: { orgId: ORG_ID },
        })
        .returning();
      expect(inserted.id).toBeDefined();
      expect(inserted.runId).toBe(run.id);
      expect(inserted.costId).toBeNull();
      expect(inserted.eventType).toBe("cost.added");
    });
  });
});
