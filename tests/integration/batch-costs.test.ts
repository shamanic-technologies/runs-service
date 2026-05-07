import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders, TEST_ORG_ID } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestRun,
  insertTestRunCost,
  closeDb,
} from "../helpers/test-db.js";

// Mock cost-resolver for integration tests
vi.mock("../../src/services/cost-resolver.js", () => ({
  resolveMultipleUnitCosts: vi.fn().mockResolvedValue(new Map()),
  CostNotFoundError: class CostNotFoundError extends Error {
    costName: string;
    constructor(costName: string) {
      super(`Cost not found: ${costName}`);
      this.costName = costName;
    }
  },
  UpstreamError: class UpstreamError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

vi.mock("../../src/services/billing.js", () => ({
  deductCredits: vi.fn().mockResolvedValue({ success: true }),
  provisionCredits: vi.fn().mockResolvedValue({ provision_id: "prov_test" }),
  confirmProvision: vi.fn().mockResolvedValue({ success: true }),
  cancelProvision: vi.fn().mockResolvedValue({ success: true }),
  BillingError: class BillingError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

describe("POST /v1/runs/costs/batch", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("returns cost totals for multiple runs", async () => {
    const run1 = await insertTestRun({
      organizationId: TEST_ORG_ID,
      serviceName: "press-kits",
      taskName: "generate",
    });
    const run2 = await insertTestRun({
      organizationId: TEST_ORG_ID,
      serviceName: "press-kits",
      taskName: "edit",
    });

    await insertTestRunCost({
      runId: run1.id,
      costName: "gpt-4o",
      quantity: "1000",
      unitCostInUsdCents: "0.0010000000",
      totalCostInUsdCents: "1.0000000000",
    });
    await insertTestRunCost({
      runId: run2.id,
      costName: "gpt-4o",
      quantity: "500",
      unitCostInUsdCents: "0.0010000000",
      totalCostInUsdCents: "0.5000000000",
    });

    const res = await request(app)
      .post("/v1/runs/costs/batch")
      .set(authHeaders)
      .send({ runIds: [run1.id, run2.id] });

    expect(res.status).toBe(200);
    expect(res.body.costs).toHaveLength(2);

    const cost1 = res.body.costs.find((c: any) => c.runId === run1.id);
    const cost2 = res.body.costs.find((c: any) => c.runId === run2.id);
    expect(cost1.totalCostInUsdCents).toBe("1.0000000000");
    expect(cost1.actualCostInUsdCents).toBe("1.0000000000");
    expect(cost1.provisionedCostInUsdCents).toBe("0.0000000000");
    expect(cost2.totalCostInUsdCents).toBe("0.5000000000");
  });

  it("includes descendant costs in totals", async () => {
    const parent = await insertTestRun({
      organizationId: TEST_ORG_ID,
      serviceName: "press-kits",
      taskName: "generate",
    });
    const child = await insertTestRun({
      organizationId: TEST_ORG_ID,
      serviceName: "brand-service",
      taskName: "extract",
      parentRunId: parent.id,
    });
    const grandchild = await insertTestRun({
      organizationId: TEST_ORG_ID,
      serviceName: "llm-service",
      taskName: "completion",
      parentRunId: child.id,
    });

    // Cost on parent
    await insertTestRunCost({
      runId: parent.id,
      costName: "gpt-4o",
      quantity: "100",
      unitCostInUsdCents: "0.0010000000",
      totalCostInUsdCents: "0.1000000000",
    });
    // Cost on child
    await insertTestRunCost({
      runId: child.id,
      costName: "gpt-4o",
      quantity: "200",
      unitCostInUsdCents: "0.0010000000",
      totalCostInUsdCents: "0.2000000000",
    });
    // Cost on grandchild
    await insertTestRunCost({
      runId: grandchild.id,
      costName: "gpt-4o",
      quantity: "300",
      unitCostInUsdCents: "0.0010000000",
      totalCostInUsdCents: "0.3000000000",
    });

    const res = await request(app)
      .post("/v1/runs/costs/batch")
      .set(authHeaders)
      .send({ runIds: [parent.id] });

    expect(res.status).toBe(200);
    expect(res.body.costs).toHaveLength(1);
    // 0.1 + 0.2 + 0.3 = 0.6
    expect(res.body.costs[0].totalCostInUsdCents).toBe("0.6000000000");
  });

  it("omits unknown run IDs silently", async () => {
    const run = await insertTestRun({
      organizationId: TEST_ORG_ID,
      serviceName: "press-kits",
      taskName: "generate",
    });
    await insertTestRunCost({
      runId: run.id,
      costName: "gpt-4o",
      quantity: "100",
      unitCostInUsdCents: "0.0010000000",
      totalCostInUsdCents: "0.1000000000",
    });

    const fakeId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const res = await request(app)
      .post("/v1/runs/costs/batch")
      .set(authHeaders)
      .send({ runIds: [run.id, fakeId] });

    expect(res.status).toBe(200);
    expect(res.body.costs).toHaveLength(1);
    expect(res.body.costs[0].runId).toBe(run.id);
  });

  it("separates actual vs provisioned costs", async () => {
    const run = await insertTestRun({
      organizationId: TEST_ORG_ID,
      serviceName: "press-kits",
      taskName: "generate",
    });

    await insertTestRunCost({
      runId: run.id,
      costName: "gpt-4o",
      quantity: "100",
      unitCostInUsdCents: "0.0100000000",
      totalCostInUsdCents: "1.0000000000",
      status: "actual",
    });
    await insertTestRunCost({
      runId: run.id,
      costName: "gpt-4o",
      quantity: "50",
      unitCostInUsdCents: "0.0100000000",
      totalCostInUsdCents: "0.5000000000",
      status: "provisioned",
    });
    await insertTestRunCost({
      runId: run.id,
      costName: "gpt-4o",
      quantity: "25",
      unitCostInUsdCents: "0.0100000000",
      totalCostInUsdCents: "0.2500000000",
      status: "cancelled",
    });

    const res = await request(app)
      .post("/v1/runs/costs/batch")
      .set(authHeaders)
      .send({ runIds: [run.id] });

    expect(res.status).toBe(200);
    const entry = res.body.costs[0];
    expect(entry.totalCostInUsdCents).toBe("1.5000000000"); // actual + provisioned, not cancelled
    expect(entry.actualCostInUsdCents).toBe("1.0000000000");
    expect(entry.provisionedCostInUsdCents).toBe("0.5000000000");
  });

  it("returns empty array for empty runIds", async () => {
    const res = await request(app)
      .post("/v1/runs/costs/batch")
      .set(authHeaders)
      .send({ runIds: [] });

    expect(res.status).toBe(400);
  });

  it("enforces org isolation", async () => {
    const otherOrgId = "33333333-3333-3333-3333-333333333333";
    const run = await insertTestRun({
      organizationId: otherOrgId,
      serviceName: "press-kits",
      taskName: "generate",
    });
    await insertTestRunCost({
      runId: run.id,
      costName: "gpt-4o",
      quantity: "100",
      unitCostInUsdCents: "0.0010000000",
      totalCostInUsdCents: "0.1000000000",
    });

    const res = await request(app)
      .post("/v1/runs/costs/batch")
      .set(authHeaders) // uses TEST_ORG_ID
      .send({ runIds: [run.id] });

    expect(res.status).toBe(200);
    expect(res.body.costs).toHaveLength(0); // other org's run is invisible
  });

  it("returns zero costs for runs with no cost items", async () => {
    const run = await insertTestRun({
      organizationId: TEST_ORG_ID,
      serviceName: "press-kits",
      taskName: "generate",
    });

    const res = await request(app)
      .post("/v1/runs/costs/batch")
      .set(authHeaders)
      .send({ runIds: [run.id] });

    expect(res.status).toBe(200);
    expect(res.body.costs).toHaveLength(1);
    expect(res.body.costs[0].totalCostInUsdCents).toBe("0.0000000000");
    expect(res.body.costs[0].actualCostInUsdCents).toBe("0.0000000000");
    expect(res.body.costs[0].provisionedCostInUsdCents).toBe("0.0000000000");
  });

  it("validates runIds are UUIDs", async () => {
    const res = await request(app)
      .post("/v1/runs/costs/batch")
      .set(authHeaders)
      .send({ runIds: ["not-a-uuid"] });

    expect(res.status).toBe(400);
  });

  it("accepts large payloads without 413 error", async () => {
    // Regression: press-kits-service was getting 413 PayloadTooLargeError
    // when sending large batches of run IDs
    const largeRunIds = Array.from({ length: 5000 }, (_, i) =>
      `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`
    );

    const res = await request(app)
      .post("/v1/runs/costs/batch")
      .set(authHeaders)
      .send({ runIds: largeRunIds });

    // Should get 200 (no matching runs) rather than 413
    expect(res.status).toBe(200);
    expect(res.body.costs).toHaveLength(0);
  });

  describe("platform-split fields (own-run only)", () => {
    it("returns ownActualPlatformCostInUsdCents for platform actuals only (excludes org)", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });
      // Platform actual — billable
      await insertTestRunCost({
        runId: run.id,
        costName: "platform-token",
        costSource: "platform",
        quantity: "100",
        unitCostInUsdCents: "0.0030000000",
        totalCostInUsdCents: "0.3000000000",
        status: "actual",
      });
      // Org actual — NOT billable, must be excluded from platform field
      await insertTestRunCost({
        runId: run.id,
        costName: "org-token",
        costSource: "org",
        quantity: "100",
        unitCostInUsdCents: "0.0050000000",
        totalCostInUsdCents: "0.5000000000",
        status: "actual",
      });

      const res = await request(app)
        .post("/v1/runs/costs/batch")
        .set(authHeaders)
        .send({ runIds: [run.id] });

      expect(res.status).toBe(200);
      const entry = res.body.costs[0];
      // Platform-only filter: 0.3 (excludes the 0.5 org row)
      expect(entry.ownActualPlatformCostInUsdCents).toBe("0.3000000000");
      expect(entry.ownProvisionedPlatformCostInUsdCents).toBe("0.0000000000");
      // Existing fields preserved (sum of both sources)
      expect(entry.actualCostInUsdCents).toBe("0.8000000000");
    });

    it("returns ownProvisionedPlatformCostInUsdCents for provisioned platform rows", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "platform-token",
        costSource: "platform",
        quantity: "100",
        unitCostInUsdCents: "0.0070000000",
        totalCostInUsdCents: "0.7000000000",
        status: "provisioned",
      });

      const res = await request(app)
        .post("/v1/runs/costs/batch")
        .set(authHeaders)
        .send({ runIds: [run.id] });

      expect(res.status).toBe(200);
      const entry = res.body.costs[0];
      expect(entry.ownActualPlatformCostInUsdCents).toBe("0.0000000000");
      expect(entry.ownProvisionedPlatformCostInUsdCents).toBe("0.7000000000");
    });

    it("excludes cancelled platform rows from platform fields", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "platform-token",
        costSource: "platform",
        quantity: "100",
        unitCostInUsdCents: "0.0040000000",
        totalCostInUsdCents: "0.4000000000",
        status: "actual",
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "platform-token",
        costSource: "platform",
        quantity: "100",
        unitCostInUsdCents: "0.0040000000",
        totalCostInUsdCents: "0.4000000000",
        status: "cancelled",
      });

      const res = await request(app)
        .post("/v1/runs/costs/batch")
        .set(authHeaders)
        .send({ runIds: [run.id] });

      expect(res.status).toBe(200);
      const entry = res.body.costs[0];
      expect(entry.ownActualPlatformCostInUsdCents).toBe("0.4000000000");
    });

    it("returns 0.0000000000 platform fields for runs with no platform rows", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "org-only",
        costSource: "org",
        quantity: "100",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.1000000000",
        status: "actual",
      });

      const res = await request(app)
        .post("/v1/runs/costs/batch")
        .set(authHeaders)
        .send({ runIds: [run.id] });

      expect(res.status).toBe(200);
      const entry = res.body.costs[0];
      expect(entry.ownActualPlatformCostInUsdCents).toBe("0.0000000000");
      expect(entry.ownProvisionedPlatformCostInUsdCents).toBe("0.0000000000");
    });

    it("platform fields exclude descendants (own-run only)", async () => {
      const parent = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "parent",
      });
      const child = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "child",
        parentRunId: parent.id,
      });
      // Cost on parent (own — must count)
      await insertTestRunCost({
        runId: parent.id,
        costName: "parent-cost",
        costSource: "platform",
        quantity: "1",
        unitCostInUsdCents: "0.2000000000",
        totalCostInUsdCents: "0.2000000000",
        status: "actual",
      });
      // Cost on child (descendant — must NOT count toward parent's own platform field)
      await insertTestRunCost({
        runId: child.id,
        costName: "child-cost",
        costSource: "platform",
        quantity: "1",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "0.5000000000",
        status: "actual",
      });

      const res = await request(app)
        .post("/v1/runs/costs/batch")
        .set(authHeaders)
        .send({ runIds: [parent.id] });

      expect(res.status).toBe(200);
      const entry = res.body.costs[0];
      // Own-only: 0.2 (NOT 0.7 which would include the descendant)
      expect(entry.ownActualPlatformCostInUsdCents).toBe("0.2000000000");
      // Existing rolled-up field still includes descendants
      expect(entry.actualCostInUsdCents).toBe("0.7000000000");
    });

    it("returns platform fields per row across multiple runs in one batch", async () => {
      const runA = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "a",
      });
      const runB = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "b",
      });
      await insertTestRunCost({
        runId: runA.id,
        costName: "x",
        costSource: "platform",
        quantity: "1",
        unitCostInUsdCents: "0.1100000000",
        totalCostInUsdCents: "0.1100000000",
        status: "actual",
      });
      await insertTestRunCost({
        runId: runB.id,
        costName: "y",
        costSource: "platform",
        quantity: "1",
        unitCostInUsdCents: "0.2200000000",
        totalCostInUsdCents: "0.2200000000",
        status: "provisioned",
      });
      // Org row on B — must not leak into platform field
      await insertTestRunCost({
        runId: runB.id,
        costName: "z",
        costSource: "org",
        quantity: "1",
        unitCostInUsdCents: "0.9900000000",
        totalCostInUsdCents: "0.9900000000",
        status: "actual",
      });

      const res = await request(app)
        .post("/v1/runs/costs/batch")
        .set(authHeaders)
        .send({ runIds: [runA.id, runB.id] });

      expect(res.status).toBe(200);
      const a = res.body.costs.find((c: any) => c.runId === runA.id);
      const b = res.body.costs.find((c: any) => c.runId === runB.id);
      expect(a.ownActualPlatformCostInUsdCents).toBe("0.1100000000");
      expect(a.ownProvisionedPlatformCostInUsdCents).toBe("0.0000000000");
      expect(b.ownActualPlatformCostInUsdCents).toBe("0.0000000000");
      expect(b.ownProvisionedPlatformCostInUsdCents).toBe("0.2200000000");
    });
  });
});
