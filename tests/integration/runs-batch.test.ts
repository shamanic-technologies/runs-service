import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestRun,
  insertTestRunCost,
  closeDb,
} from "../helpers/test-db.js";

// POST /v1/runs/batch — full RunWithCosts shape for N runs in one HTTP call.
// File-local org keeps this isolated from other parallel files.
const ORG_ID = "55557777-1111-4555-8555-111111111111";
const OTHER_ORG_ID = "55557777-2222-4555-8555-222222222222";
const CLEANUP_ORG_IDS = [ORG_ID, OTHER_ORG_ID];

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
  notifyUsage: vi.fn().mockResolvedValue(undefined),
}));

describe("POST /v1/runs/batch", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders({ orgId: ORG_ID });

  beforeEach(async () => {
    await cleanTestData(CLEANUP_ORG_IDS);
  });

  afterAll(async () => {
    await cleanTestData(CLEANUP_ORG_IDS);
    await closeDb();
  });

  it("returns one RunWithCosts entry per requested run", async () => {
    const a = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "a" });
    const b = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "b" });
    await insertTestRunCost({
      runId: a.id,
      costName: "gpt-4o",
      quantity: "1",
      unitCostInUsdCents: "0.1000000000",
      totalCostInUsdCents: "0.1000000000",
    });
    await insertTestRunCost({
      runId: b.id,
      costName: "gpt-4o",
      quantity: "1",
      unitCostInUsdCents: "0.2000000000",
      totalCostInUsdCents: "0.2000000000",
    });

    const res = await request(app)
      .post("/v1/runs/batch")
      .set(authHeaders)
      .send({ runIds: [a.id, b.id] });

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(2);
    const byId = new Map<string, any>(res.body.runs.map((r: any) => [r.id, r]));
    expect(byId.get(a.id).totalCostInUsdCents).toBe("0.1000000000");
    expect(byId.get(a.id).ownActualCostInUsdCents).toBe("0.1000000000");
    expect(byId.get(b.id).totalCostInUsdCents).toBe("0.2000000000");
  });

  it("includes descendant runs with their own costs", async () => {
    const parent = await insertTestRun({ organizationId: ORG_ID, serviceName: "p", taskName: "p" });
    const child = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "c",
      taskName: "c",
      parentRunId: parent.id,
    });
    const grand = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "g",
      taskName: "g",
      parentRunId: child.id,
    });
    await insertTestRunCost({
      runId: parent.id,
      costName: "x",
      quantity: "1",
      unitCostInUsdCents: "0.1000000000",
      totalCostInUsdCents: "0.1000000000",
    });
    await insertTestRunCost({
      runId: child.id,
      costName: "x",
      quantity: "1",
      unitCostInUsdCents: "0.2000000000",
      totalCostInUsdCents: "0.2000000000",
    });
    await insertTestRunCost({
      runId: grand.id,
      costName: "x",
      quantity: "1",
      unitCostInUsdCents: "0.3000000000",
      totalCostInUsdCents: "0.3000000000",
    });

    const res = await request(app)
      .post("/v1/runs/batch")
      .set(authHeaders)
      .send({ runIds: [parent.id] });

    expect(res.status).toBe(200);
    const entry = res.body.runs[0];
    expect(entry.id).toBe(parent.id);
    expect(entry.totalCostInUsdCents).toBe("0.6000000000"); // 0.1 + 0.2 + 0.3
    expect(entry.ownCostInUsdCents).toBe("0.1000000000");   // parent only
    expect(entry.childrenCostInUsdCents).toBe("0.5000000000");
    expect(entry.descendantRuns).toHaveLength(2);
    const dIds = entry.descendantRuns.map((d: any) => d.id).sort();
    expect(dIds).toEqual([child.id, grand.id].sort());
    const childDesc = entry.descendantRuns.find((d: any) => d.id === child.id);
    expect(childDesc.ownCostInUsdCents).toBe("0.2000000000");
    expect(childDesc.costs).toHaveLength(1);
  });

  it("omits rows not in caller org (silent isolation)", async () => {
    const a = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "a" });
    const other = await insertTestRun({
      organizationId: OTHER_ORG_ID,
      serviceName: "s",
      taskName: "x",
    });
    const res = await request(app)
      .post("/v1/runs/batch")
      .set(authHeaders)
      .send({ runIds: [a.id, other.id] });

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].id).toBe(a.id);
  });

  it("400 on empty runIds", async () => {
    const res = await request(app).post("/v1/runs/batch").set(authHeaders).send({ runIds: [] });
    expect(res.status).toBe(400);
  });

  it("400 on runIds count > 10000", async () => {
    const huge = Array.from({ length: 10001 }, (_, i) =>
      `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`
    );
    const res = await request(app)
      .post("/v1/runs/batch")
      .set(authHeaders)
      .send({ runIds: huge });
    expect(res.status).toBe(400);
  });

  it("400 on non-UUID entries", async () => {
    const res = await request(app)
      .post("/v1/runs/batch")
      .set(authHeaders)
      .send({ runIds: ["not-a-uuid"] });
    expect(res.status).toBe(400);
  });

  it("returns shape compatible with GET /v1/runs/:id for a single run", async () => {
    const r = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "t" });
    await insertTestRunCost({
      runId: r.id,
      costName: "x",
      quantity: "1",
      unitCostInUsdCents: "0.5000000000",
      totalCostInUsdCents: "0.5000000000",
    });

    const single = await request(app).get(`/v1/runs/${r.id}`).set(authHeaders);
    expect(single.status).toBe(200);

    const batch = await request(app)
      .post("/v1/runs/batch")
      .set(authHeaders)
      .send({ runIds: [r.id] });
    expect(batch.status).toBe(200);
    expect(batch.body.runs).toHaveLength(1);
    const fromBatch = batch.body.runs[0];

    // Every key present on the single response also present in batch entry.
    for (const key of Object.keys(single.body)) {
      expect(fromBatch).toHaveProperty(key);
    }
    // Cost aggregates byte-for-byte equal.
    expect(fromBatch.totalCostInUsdCents).toBe(single.body.totalCostInUsdCents);
    expect(fromBatch.ownCostInUsdCents).toBe(single.body.ownCostInUsdCents);
    expect(fromBatch.actualCostInUsdCents).toBe(single.body.actualCostInUsdCents);
    expect(fromBatch.provisionedCostInUsdCents).toBe(single.body.provisionedCostInUsdCents);
  });

  it("accepts 5000 runIds without 413 or timeout", async () => {
    const ids = Array.from({ length: 5000 }, (_, i) =>
      `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`
    );
    const res = await request(app).post("/v1/runs/batch").set(authHeaders).send({ runIds: ids });
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(0); // none match an existing org+run
  });
});
