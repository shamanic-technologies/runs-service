import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";

const ORG_ID = "77777777-7777-4777-a777-777777777777";
const OTHER_ORG_ID = "88888888-8888-4888-a888-888888888888";
const ORG_IDS = [ORG_ID, OTHER_ORG_ID];

describe("GET /internal/org-usage-total", () => {
  const app = createTestApp();
  const headers = getInternalAuthHeaders();

  beforeEach(async () => {
    await cleanTestData(ORG_IDS);
  });

  afterAll(async () => {
    await cleanTestData(ORG_IDS);
    await closeDb();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .get("/internal/org-usage-total")
      .query({ org_id: ORG_ID });

    expect(res.status).toBe(401);
  });

  it("returns 400 when org_id is missing", async () => {
    const res = await request(app)
      .get("/internal/org-usage-total")
      .set(headers);

    expect(res.status).toBe(400);
  });

  it("returns 400 when org_id is invalid", async () => {
    const res = await request(app)
      .get("/internal/org-usage-total")
      .set(headers)
      .query({ org_id: "not-a-uuid" });

    expect(res.status).toBe(400);
  });

  it("returns exact zero for org with no usage", async () => {
    const res = await request(app)
      .get("/internal/org-usage-total")
      .set(headers)
      .query({ org_id: ORG_ID });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["as_of", "org_id", "spent_cents"]);
    expect(res.body.org_id).toBe(ORG_ID);
    expect(res.body.spent_cents).toBe("0.0000000000");
    expect(Date.parse(res.body.as_of)).not.toBeNaN();
  });

  it("includes actual and provisioned platform costs with fractional precision", async () => {
    const actualRun = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc-a",
      taskName: "task-actual",
      status: "completed",
    });
    await insertTestRunCost({
      runId: actualRun.id,
      costName: "tokens-actual",
      quantity: "1",
      unitCostInUsdCents: "1.2345678901",
      totalCostInUsdCents: "1.2345678901",
      status: "actual",
    });

    const provisionedRun = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc-a",
      taskName: "task-provisioned",
      status: "running",
    });
    await insertTestRunCost({
      runId: provisionedRun.id,
      costName: "tokens-provisioned",
      quantity: "1",
      unitCostInUsdCents: "2.0000000002",
      totalCostInUsdCents: "2.0000000002",
      status: "provisioned",
    });

    const res = await request(app)
      .get("/internal/org-usage-total")
      .set(headers)
      .query({ org_id: ORG_ID });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["as_of", "org_id", "spent_cents"]);
    expect(res.body.org_id).toBe(ORG_ID);
    expect(res.body.spent_cents).toBe("3.2345678903");
    expect(Date.parse(res.body.as_of)).not.toBeNaN();
  });

  it("excludes cancelled, org/BYOK, and other-org costs", async () => {
    const run = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc-a",
      taskName: "task-exclusions",
      status: "completed",
    });
    await insertTestRunCost({
      runId: run.id,
      costName: "tokens-counted",
      quantity: "1",
      unitCostInUsdCents: "0.1000000000",
      totalCostInUsdCents: "0.1000000000",
      status: "actual",
    });
    await insertTestRunCost({
      runId: run.id,
      costName: "tokens-cancelled",
      quantity: "1",
      unitCostInUsdCents: "9.0000000000",
      totalCostInUsdCents: "9.0000000000",
      status: "cancelled",
    });
    await insertTestRunCost({
      runId: run.id,
      costName: "tokens-byok",
      costSource: "org",
      quantity: "1",
      unitCostInUsdCents: "7.0000000000",
      totalCostInUsdCents: "7.0000000000",
      status: "actual",
    });

    const otherRun = await insertTestRun({
      organizationId: OTHER_ORG_ID,
      serviceName: "svc-a",
      taskName: "task-other-org",
      status: "completed",
    });
    await insertTestRunCost({
      runId: otherRun.id,
      costName: "tokens-other-org",
      quantity: "1",
      unitCostInUsdCents: "5.0000000000",
      totalCostInUsdCents: "5.0000000000",
      status: "actual",
    });

    const res = await request(app)
      .get("/internal/org-usage-total")
      .set(headers)
      .query({ org_id: ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.spent_cents).toBe("0.1000000000");
  });
});
