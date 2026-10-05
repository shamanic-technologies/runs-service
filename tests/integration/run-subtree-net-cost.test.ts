import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";

// GET /v1/runs?include=subtreeCost — each run's subtree cost on the frozen NET
// basis beside the gross figures. features-service sums it over a brand's
// lead-serve runs for "what we paid to source people".

const ORG_ID = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
const H = { "x-api-key": "test-api-key", "x-org-id": ORG_ID };

describe("GET /v1/runs?include=subtreeCost — net subtree cost", () => {
  const app = createTestApp();
  let rootId: string;

  beforeAll(async () => {
    await cleanTestData([ORG_ID]);
    const root = await insertTestRun({ organizationId: ORG_ID, serviceName: "lead-service", taskName: "lead-serve", status: "completed" });
    rootId = root.id;
    const child = await insertTestRun({ organizationId: ORG_ID, serviceName: "apollo-service", taskName: "enrich", status: "completed", parentRunId: root.id });
    const grandchild = await insertTestRun({ organizationId: ORG_ID, serviceName: "chat-service", taskName: "judge", status: "completed", parentRunId: child.id });
    const c = (runId: string, total: string, extra: Record<string, string> = {}) =>
      insertTestRunCost({ runId, costName: "net-subtree-test", quantity: "1", unitCostInUsdCents: total, totalCostInUsdCents: total, ...extra });
    await c(child.id, "10", { netCostInUsdCents: "8", usageDiscountPct: "0.2" }); // discounted actual
    await c(grandchild.id, "5"); // pre-freeze actual: net == gross
    await c(grandchild.id, "4", { status: "provisioned", netCostInUsdCents: "3.2", usageDiscountPct: "0.2" });
    await c(grandchild.id, "100", { status: "cancelled", netCostInUsdCents: "80", usageDiscountPct: "0.2" }); // never counted
    await c(grandchild.id, "50", { status: "refunded", netCostInUsdCents: "40", usageDiscountPct: "0.2" }); // not charged
    // A sibling root with no cost anywhere.
    await insertTestRun({ organizationId: ORG_ID, serviceName: "lead-service", taskName: "lead-serve", status: "completed" });
  });

  afterAll(async () => {
    await cleanTestData([ORG_ID]);
    await closeDb();
  });

  it("states net beside gross, per status, over the whole subtree", async () => {
    const res = await request(app)
      .get("/v1/runs")
      .query({ serviceName: "lead-service", taskName: "lead-serve", limit: "10", include: "subtreeCost" })
      .set(H);
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(2);
    const r = res.body.runs.find((x: { id: string }) => x.id === rootId);
    expect(r).toMatchObject({
      totalCostInUsdCents: "19.0000000000",
      actualCostInUsdCents: "15.0000000000",
      provisionedCostInUsdCents: "4.0000000000",
      netTotalCostInUsdCents: "16.2000000000",
      netActualCostInUsdCents: "13.0000000000",
      netProvisionedCostInUsdCents: "3.2000000000",
    });
    const lone = res.body.runs.find((x: { id: string }) => x.id !== rootId);
    expect(lone).toMatchObject({ netTotalCostInUsdCents: "0.0000000000", netActualCostInUsdCents: "0.0000000000", netProvisionedCostInUsdCents: "0.0000000000" });

    // Gross subtree figures still equal the detail read.
    const detail = await request(app).get(`/v1/runs/${rootId}`).set(H);
    expect(r.totalCostInUsdCents).toBe(detail.body.totalCostInUsdCents);
    expect(r.actualCostInUsdCents).toBe(detail.body.actualCostInUsdCents);
  });

  it("serves no net field without the include", async () => {
    const res = await request(app).get("/v1/runs").query({ serviceName: "lead-service", limit: "10" }).set(H);
    expect(res.status).toBe(200);
    for (const row of res.body.runs) expect("netTotalCostInUsdCents" in row).toBe(false);
  });
});
