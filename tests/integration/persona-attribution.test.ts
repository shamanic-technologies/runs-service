import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestRun,
  insertTestRunCost,
  closeDb,
} from "../helpers/test-db.js";

const ORG_ID = "12121212-1212-4212-9212-121212121212";
const USER_ID = "23232323-2323-4232-9232-232323232323";
const BRAND_ID = "34343434-3434-4434-9434-343434343434";
const BRAND_PROFILE_ID = "45454545-4545-4454-9454-454545454545";
const CUSTOMER_PROFILE_A = "56565656-5656-4456-9456-565656565656";
const CUSTOMER_PROFILE_B = "67676767-6767-4467-9467-676767676767";

vi.mock("../../src/services/cost-resolver.js", () => ({
  resolveMultipleUnitCosts: vi.fn().mockResolvedValue(new Map([["token", "0.0010000000"]])),
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

describe("persona/profile cost attribution", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders({ orgId: ORG_ID, userId: USER_ID });

  beforeEach(async () => {
    await cleanTestData([ORG_ID]);
  });

  afterAll(async () => {
    await cleanTestData([ORG_ID]);
    await closeDb();
  });

  it("preserves run attribution through child runs and lets cost items override it", async () => {
    const parent = await request(app)
      .post("/v1/runs")
      .set({
        ...authHeaders,
        "x-brand-id": BRAND_ID,
        "x-goal": "signup",
        "x-brand-profile-id": BRAND_PROFILE_ID,
        "x-customer-profile-id": CUSTOMER_PROFILE_A,
        "x-workflow-context": "lead-selection",
      })
      .send({ serviceName: "campaign-service", taskName: "select-workflow", featureSlug: "cold-email" });

    expect(parent.status).toBe(201);
    expect(parent.body.goal).toBe("signup");
    expect(parent.body.brandProfileId).toBe(BRAND_PROFILE_ID);
    expect(parent.body.customerProfileId).toBe(CUSTOMER_PROFILE_A);
    expect(parent.body.workflowContext).toBe("lead-selection");

    const child = await request(app)
      .post("/v1/runs")
      .set({ ...authHeaders, "x-run-id": parent.body.id })
      .send({ serviceName: "workflow-service", taskName: "execute-step" });

    expect(child.status).toBe(201);
    expect(child.body.parentRunId).toBe(parent.body.id);
    expect(child.body.goal).toBe("signup");
    expect(child.body.brandProfileId).toBe(BRAND_PROFILE_ID);
    expect(child.body.customerProfileId).toBe(CUSTOMER_PROFILE_A);
    expect(child.body.workflowContext).toBe("lead-selection");

    const costs = await request(app)
      .post(`/v1/runs/${child.body.id}/costs`)
      .set(authHeaders)
      .send({
        items: [
          { costName: "token", costSource: "platform", quantity: 100 },
          {
            costName: "token",
            costSource: "platform",
            quantity: 250,
            customerProfileId: CUSTOMER_PROFILE_B,
          },
        ],
      });

    expect(costs.status).toBe(201);
    expect(costs.body.costs).toHaveLength(2);
    const inherited = costs.body.costs[0];
    const overridden = costs.body.costs[1];
    expect(inherited.customerProfileId).toBe(CUSTOMER_PROFILE_A);
    expect(overridden.customerProfileId).toBe(CUSTOMER_PROFILE_B);
  });

  it("aggregates tagged samples separately by customer profile and workflow context", async () => {
    const runA = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "workflow-service",
      taskName: "execute",
      brandIds: [BRAND_ID],
      featureSlug: "cold-email",
      goal: "signup",
      brandProfileId: BRAND_PROFILE_ID,
      customerProfileId: CUSTOMER_PROFILE_A,
      workflowContext: "lead-selection",
    });
    const runB = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "workflow-service",
      taskName: "execute",
      brandIds: [BRAND_ID],
      featureSlug: "cold-email",
      goal: "signup",
      brandProfileId: BRAND_PROFILE_ID,
      customerProfileId: CUSTOMER_PROFILE_B,
      workflowContext: "lead-selection",
    });

    await insertTestRunCost({
      runId: runA.id,
      costName: "token",
      quantity: "1000",
      unitCostInUsdCents: "0.0010000000",
      totalCostInUsdCents: "1.0000000000",
      goal: "signup",
      brandProfileId: BRAND_PROFILE_ID,
      customerProfileId: CUSTOMER_PROFILE_A,
      workflowContext: "lead-selection",
    });
    await insertTestRunCost({
      runId: runB.id,
      costName: "token",
      quantity: "2500",
      unitCostInUsdCents: "0.0010000000",
      totalCostInUsdCents: "2.5000000000",
      goal: "signup",
      brandProfileId: BRAND_PROFILE_ID,
      customerProfileId: CUSTOMER_PROFILE_B,
      workflowContext: "lead-selection",
    });

    const res = await request(app)
      .get(
        `/v1/stats/costs?groupBy=customerProfileId,brandProfileId,goal,workflowContext&brandId=${BRAND_ID}&featureSlug=cold-email&goal=signup&attributionStatus=tagged`
      )
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(2);
    const profileA = res.body.groups.find((g: any) => g.dimensions.customerProfileId === CUSTOMER_PROFILE_A);
    const profileB = res.body.groups.find((g: any) => g.dimensions.customerProfileId === CUSTOMER_PROFILE_B);
    expect(profileA.totalCostInUsdCents).toBe("1.0000000000");
    expect(profileB.totalCostInUsdCents).toBe("2.5000000000");
    expect(profileA.dimensions.brandProfileId).toBe(BRAND_PROFILE_ID);
    expect(profileA.dimensions.goal).toBe("signup");
    expect(profileA.dimensions.workflowContext).toBe("lead-selection");
  });

  it("keeps untagged samples in a null group and excludes them when requested", async () => {
    const tagged = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "workflow-service",
      taskName: "execute",
      brandIds: [BRAND_ID],
      featureSlug: "cold-email",
      customerProfileId: CUSTOMER_PROFILE_A,
    });
    const untagged = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "workflow-service",
      taskName: "execute",
      brandIds: [BRAND_ID],
      featureSlug: "cold-email",
    });

    await insertTestRunCost({
      runId: tagged.id,
      costName: "token",
      quantity: "1000",
      unitCostInUsdCents: "0.0010000000",
      totalCostInUsdCents: "1.0000000000",
      customerProfileId: CUSTOMER_PROFILE_A,
    });
    await insertTestRunCost({
      runId: untagged.id,
      costName: "token",
      quantity: "500",
      unitCostInUsdCents: "0.0010000000",
      totalCostInUsdCents: "0.5000000000",
    });

    const all = await request(app)
      .get(`/v1/stats/costs?groupBy=customerProfileId&brandId=${BRAND_ID}&featureSlug=cold-email`)
      .set(authHeaders);

    expect(all.status).toBe(200);
    const taggedGroup = all.body.groups.find((g: any) => g.dimensions.customerProfileId === CUSTOMER_PROFILE_A);
    const untaggedGroup = all.body.groups.find((g: any) => g.dimensions.customerProfileId === null);
    expect(taggedGroup.totalCostInUsdCents).toBe("1.0000000000");
    expect(untaggedGroup.totalCostInUsdCents).toBe("0.5000000000");

    const onlyTagged = await request(app)
      .get(`/v1/stats/costs?groupBy=customerProfileId&brandId=${BRAND_ID}&featureSlug=cold-email&attributionStatus=tagged`)
      .set(authHeaders);

    expect(onlyTagged.status).toBe(200);
    expect(onlyTagged.body.groups).toHaveLength(1);
    expect(onlyTagged.body.groups[0].dimensions.customerProfileId).toBe(CUSTOMER_PROFILE_A);
  });

  it("keeps existing brandId aggregation compatible", async () => {
    const tagged = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc",
      taskName: "task",
      brandIds: [BRAND_ID],
      customerProfileId: CUSTOMER_PROFILE_A,
    });
    const untagged = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc",
      taskName: "task",
      brandIds: [BRAND_ID],
    });

    await insertTestRunCost({
      runId: tagged.id,
      costName: "token",
      quantity: "100",
      unitCostInUsdCents: "0.0010000000",
      totalCostInUsdCents: "0.1000000000",
      customerProfileId: CUSTOMER_PROFILE_A,
    });
    await insertTestRunCost({
      runId: untagged.id,
      costName: "token",
      quantity: "200",
      unitCostInUsdCents: "0.0010000000",
      totalCostInUsdCents: "0.2000000000",
    });

    const res = await request(app)
      .get("/v1/stats/costs?groupBy=brandId")
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].dimensions.brandId).toBe(BRAND_ID);
    expect(res.body.groups[0].totalCostInUsdCents).toBe("0.3000000000");
  });
});
