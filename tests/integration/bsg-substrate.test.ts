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
// Verifies generated columns + gold views in isolation. No route changes yet.
// File-local org IDs keep this isolated from other parallel integration files.
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

  describe("v_runs_with_descendants", () => {
    it("returns root + child + grandchild with correct depths and shared root_run_id", async () => {
      const root = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "root" });
      const child = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "s",
        taskName: "child",
        parentRunId: root.id,
      });
      const grand = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "s",
        taskName: "grand",
        parentRunId: child.id,
      });

      const result = await db.execute(sql`
        SELECT id, root_run_id, organization_id, depth
        FROM v_runs_with_descendants
        WHERE root_run_id = ${root.id}
        ORDER BY depth
      `);
      const rows = result as any[];
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ id: root.id, root_run_id: root.id, depth: 0 });
      expect(rows[1]).toMatchObject({ id: child.id, root_run_id: root.id, depth: 1 });
      expect(rows[2]).toMatchObject({ id: grand.id, root_run_id: root.id, depth: 2 });
      for (const r of rows) expect(r.organization_id).toBe(ORG_ID);
    });

    it("each run is its own root at depth 0 when standalone", async () => {
      const a = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "a" });
      const result = await db.execute(sql`
        SELECT id, root_run_id, depth FROM v_runs_with_descendants WHERE id = ${a.id}
      `);
      const rows = result as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: a.id, root_run_id: a.id, depth: 0 });
    });
  });

  describe("v_run_cost_rollup", () => {
    it("aggregates parent + child costs into root totals; own_platform counts depth=0 only", async () => {
      const parent = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "p" });
      const child = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "s",
        taskName: "c",
        parentRunId: parent.id,
      });
      // Parent platform actual: counts toward total, actual, own_actual_platform
      await insertTestRunCost({
        runId: parent.id,
        costName: "p-plat",
        costSource: "platform",
        quantity: "1",
        unitCostInUsdCents: "0.3000000000",
        totalCostInUsdCents: "0.3000000000",
        status: "actual",
      });
      // Child platform actual: counts toward total/actual but NOT own_actual_platform (depth=1)
      await insertTestRunCost({
        runId: child.id,
        costName: "c-plat",
        costSource: "platform",
        quantity: "1",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "0.5000000000",
        status: "actual",
      });
      // Parent platform provisioned: counts toward total/provisioned and own_provisioned_platform
      await insertTestRunCost({
        runId: parent.id,
        costName: "p-prov",
        costSource: "platform",
        quantity: "1",
        unitCostInUsdCents: "0.1000000000",
        totalCostInUsdCents: "0.1000000000",
        status: "provisioned",
      });

      const result = await db.execute(sql`
        SELECT total_cost::text, actual_cost::text, provisioned_cost::text,
               own_actual_platform_cost::text, own_provisioned_platform_cost::text
        FROM v_run_cost_rollup
        WHERE root_run_id = ${parent.id}
      `);
      const row = (result as any[])[0];
      expect(row.total_cost).toBe("0.9000000000");        // 0.3 + 0.5 + 0.1
      expect(row.actual_cost).toBe("0.8000000000");        // 0.3 + 0.5
      expect(row.provisioned_cost).toBe("0.1000000000");
      expect(row.own_actual_platform_cost).toBe("0.3000000000");      // parent only
      expect(row.own_provisioned_platform_cost).toBe("0.1000000000"); // parent only
    });

    it("excludes cancelled costs from total / actual / provisioned", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "t" });
      await insertTestRunCost({
        runId: run.id,
        costName: "actual",
        costSource: "platform",
        quantity: "1",
        unitCostInUsdCents: "1.0000000000",
        totalCostInUsdCents: "1.0000000000",
        status: "actual",
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "cancelled",
        costSource: "platform",
        quantity: "1",
        unitCostInUsdCents: "9.9999999999",
        totalCostInUsdCents: "9.9999999999",
        status: "cancelled",
      });
      const result = await db.execute(sql`
        SELECT total_cost::text, actual_cost::text, cancelled_cost::text
        FROM v_run_cost_rollup WHERE root_run_id = ${run.id}
      `);
      const row = (result as any[])[0];
      expect(row.total_cost).toBe("1.0000000000");
      expect(row.actual_cost).toBe("1.0000000000");
      expect(row.cancelled_cost).toBe("9.9999999999");
    });

    it("own_actual_platform excludes org-source rows", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "t" });
      await insertTestRunCost({
        runId: run.id,
        costName: "plat",
        costSource: "platform",
        quantity: "1",
        unitCostInUsdCents: "0.2000000000",
        totalCostInUsdCents: "0.2000000000",
        status: "actual",
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "byok",
        costSource: "org",
        quantity: "1",
        unitCostInUsdCents: "5.0000000000",
        totalCostInUsdCents: "5.0000000000",
        status: "actual",
      });
      const result = await db.execute(sql`
        SELECT own_actual_platform_cost::text, actual_cost::text
        FROM v_run_cost_rollup WHERE root_run_id = ${run.id}
      `);
      const row = (result as any[])[0];
      expect(row.own_actual_platform_cost).toBe("0.2000000000");
      // rolled-up actual includes both sources
      expect(row.actual_cost).toBe("5.2000000000");
    });
  });

  describe("v_org_platform_spend", () => {
    it("sums only platform projected (actual+provisioned) rows for an org", async () => {
      const r1 = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "a" });
      const r2 = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "b" });
      // counted
      await insertTestRunCost({
        runId: r1.id, costName: "x", costSource: "platform",
        quantity: "1", unitCostInUsdCents: "0.7000000000",
        totalCostInUsdCents: "0.7000000000", status: "actual",
      });
      // counted
      await insertTestRunCost({
        runId: r2.id, costName: "y", costSource: "platform",
        quantity: "1", unitCostInUsdCents: "0.3000000000",
        totalCostInUsdCents: "0.3000000000", status: "provisioned",
      });
      // excluded — cancelled
      await insertTestRunCost({
        runId: r1.id, costName: "z", costSource: "platform",
        quantity: "1", unitCostInUsdCents: "9.0000000000",
        totalCostInUsdCents: "9.0000000000", status: "cancelled",
      });
      // excluded — org source
      await insertTestRunCost({
        runId: r2.id, costName: "byok", costSource: "org",
        quantity: "1", unitCostInUsdCents: "100.0000000000",
        totalCostInUsdCents: "100.0000000000", status: "actual",
      });

      const result = await db.execute(sql`
        SELECT projected_spent_cents::text
        FROM v_org_platform_spend
        WHERE organization_id = ${ORG_ID}
      `);
      const row = (result as any[])[0];
      expect(row.projected_spent_cents).toBe("1.0000000000");
    });

    it("isolates orgs", async () => {
      const r1 = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "a" });
      const r2 = await insertTestRun({ organizationId: OTHER_ORG_ID, serviceName: "s", taskName: "b" });
      await insertTestRunCost({
        runId: r1.id, costName: "x", costSource: "platform",
        quantity: "1", unitCostInUsdCents: "1.0000000000",
        totalCostInUsdCents: "1.0000000000", status: "actual",
      });
      await insertTestRunCost({
        runId: r2.id, costName: "x", costSource: "platform",
        quantity: "1", unitCostInUsdCents: "2.0000000000",
        totalCostInUsdCents: "2.0000000000", status: "actual",
      });
      const res1 = await db.execute(sql`
        SELECT projected_spent_cents::text FROM v_org_platform_spend WHERE organization_id = ${ORG_ID}
      `);
      const res2 = await db.execute(sql`
        SELECT projected_spent_cents::text FROM v_org_platform_spend WHERE organization_id = ${OTHER_ORG_ID}
      `);
      expect((res1 as any[])[0].projected_spent_cents).toBe("1.0000000000");
      expect((res2 as any[])[0].projected_spent_cents).toBe("2.0000000000");
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

  describe("parity with existing aggregations", () => {
    it("v_run_cost_rollup matches the cost numbers POST /v1/runs/costs/batch would compute", async () => {
      // Reproduce the costs/batch CTE result by reading from the view instead.
      // Same dataset shape as batch-costs.test.ts "includes descendant costs in totals" + platform-split.
      const parent = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "p" });
      const child = await insertTestRun({
        organizationId: ORG_ID, serviceName: "s", taskName: "c", parentRunId: parent.id,
      });
      const grand = await insertTestRun({
        organizationId: ORG_ID, serviceName: "s", taskName: "g", parentRunId: child.id,
      });
      await insertTestRunCost({
        runId: parent.id, costName: "a", costSource: "platform",
        quantity: "1", unitCostInUsdCents: "0.1000000000",
        totalCostInUsdCents: "0.1000000000", status: "actual",
      });
      await insertTestRunCost({
        runId: child.id, costName: "b", costSource: "platform",
        quantity: "1", unitCostInUsdCents: "0.2000000000",
        totalCostInUsdCents: "0.2000000000", status: "actual",
      });
      await insertTestRunCost({
        runId: grand.id, costName: "c", costSource: "platform",
        quantity: "1", unitCostInUsdCents: "0.3000000000",
        totalCostInUsdCents: "0.3000000000", status: "actual",
      });

      const fromView = await db.execute(sql`
        SELECT total_cost::text, actual_cost::text, own_actual_platform_cost::text
        FROM v_run_cost_rollup WHERE root_run_id = ${parent.id}
      `);
      const view = (fromView as any[])[0];

      // Reproduce the existing costs/batch CTE inline. Must produce identical numbers.
      const fromCte = await db.execute(sql`
        WITH RECURSIVE descendants AS (
          SELECT id, id as root_run_id
          FROM runs WHERE id = ${parent.id} AND organization_id = ${ORG_ID}
          UNION ALL
          SELECT r.id, d.root_run_id
          FROM runs r INNER JOIN descendants d ON r.parent_run_id = d.id
        )
        SELECT
          COALESCE(SUM(CASE WHEN rc.status <> 'cancelled' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0)::text as total_cost,
          COALESCE(SUM(CASE WHEN rc.status = 'actual' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0)::text as actual_cost,
          COALESCE(SUM(CASE WHEN d.id = d.root_run_id AND rc.status = 'actual' AND rc.cost_source = 'platform' THEN rc.total_cost_in_usd_cents::numeric ELSE 0 END), 0)::text as own_actual_platform_cost
        FROM descendants d
        LEFT JOIN runs_costs rc ON rc.run_id = d.id
      `);
      const cte = (fromCte as any[])[0];

      expect(view.total_cost).toBe(cte.total_cost);
      expect(view.actual_cost).toBe(cte.actual_cost);
      expect(view.own_actual_platform_cost).toBe(cte.own_actual_platform_cost);
    });

    it("v_org_platform_spend matches the inline /internal/org-usage-total query", async () => {
      const r = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "t" });
      await insertTestRunCost({
        runId: r.id, costName: "x", costSource: "platform",
        quantity: "1", unitCostInUsdCents: "1.2345678910",
        totalCostInUsdCents: "1.2345678910", status: "actual",
      });
      await insertTestRunCost({
        runId: r.id, costName: "y", costSource: "platform",
        quantity: "1", unitCostInUsdCents: "0.0000000010",
        totalCostInUsdCents: "0.0000000010", status: "provisioned",
      });
      await insertTestRunCost({
        runId: r.id, costName: "z", costSource: "platform",
        quantity: "1", unitCostInUsdCents: "9.0000000000",
        totalCostInUsdCents: "9.0000000000", status: "cancelled",
      });

      const fromView = await db.execute(sql`
        SELECT projected_spent_cents::text FROM v_org_platform_spend WHERE organization_id = ${ORG_ID}
      `);
      const fromInline = await db.execute(sql`
        SELECT COALESCE(SUM(rc.total_cost_in_usd_cents), 0)::text AS spent_cents
        FROM runs r JOIN runs_costs rc ON rc.run_id = r.id
        WHERE r.organization_id = ${ORG_ID}
          AND rc.cost_source = 'platform'
          AND rc.status IN ('actual', 'provisioned')
      `);
      expect((fromView as any[])[0].projected_spent_cents).toBe((fromInline as any[])[0].spent_cents);
    });
  });
});
