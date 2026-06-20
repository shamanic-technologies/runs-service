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
const AUDIENCE_A = "56565656-5656-4456-9456-565656565656";
const AUDIENCE_B = "67676767-6767-4467-9467-676767676767";

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

describe("audience cost attribution", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders({ orgId: ORG_ID, userId: USER_ID });

  beforeEach(async () => {
    await cleanTestData([ORG_ID]);
  });

  afterAll(async () => {
    await cleanTestData([ORG_ID]);
    await closeDb();
  });

  it("inherits audience through child runs and lets cost items override it", async () => {
    const parent = await request(app)
      .post("/v1/runs")
      .set({
        ...authHeaders,
        "x-brand-id": BRAND_ID,
        "x-goal": "signup",
        "x-brand-profile-id": BRAND_PROFILE_ID,
        "x-audience-id": AUDIENCE_A,
        "x-workflow-context": "lead-selection",
      })
      .send({ serviceName: "campaign-service", taskName: "select-workflow", featureSlug: "cold-email" });

    expect(parent.status).toBe(201);
    expect(parent.body.goal).toBe("signup");
    expect(parent.body.brandProfileId).toBe(BRAND_PROFILE_ID);
    expect(parent.body.audienceId).toBe(AUDIENCE_A);
    expect(parent.body.workflowContext).toBe("lead-selection");

    // Child run created with only the parent run id (no audience header) inherits it.
    const child = await request(app)
      .post("/v1/runs")
      .set({ ...authHeaders, "x-run-id": parent.body.id })
      .send({ serviceName: "workflow-service", taskName: "execute-step" });

    expect(child.status).toBe(201);
    expect(child.body.parentRunId).toBe(parent.body.id);
    expect(child.body.goal).toBe("signup");
    expect(child.body.brandProfileId).toBe(BRAND_PROFILE_ID);
    expect(child.body.audienceId).toBe(AUDIENCE_A);
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
            audienceId: AUDIENCE_B,
          },
        ],
      });

    expect(costs.status).toBe(201);
    expect(costs.body.costs).toHaveLength(2);
    const inherited = costs.body.costs[0];
    const overridden = costs.body.costs[1];
    expect(inherited.audienceId).toBe(AUDIENCE_A);
    expect(overridden.audienceId).toBe(AUDIENCE_B);
  });

  it("aggregates tagged samples separately by audience and workflow context", async () => {
    const runA = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "workflow-service",
      taskName: "execute",
      brandIds: [BRAND_ID],
      featureSlug: "cold-email",
      goal: "signup",
      brandProfileId: BRAND_PROFILE_ID,
      audienceId: AUDIENCE_A,
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
      audienceId: AUDIENCE_B,
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
      audienceId: AUDIENCE_A,
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
      audienceId: AUDIENCE_B,
      workflowContext: "lead-selection",
    });

    const res = await request(app)
      .get(
        `/v1/stats/costs?groupBy=audienceId,brandProfileId,goal,workflowContext&brandId=${BRAND_ID}&featureSlug=cold-email&goal=signup&attributionStatus=tagged`
      )
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(2);
    const audienceA = res.body.groups.find((g: any) => g.dimensions.audienceId === AUDIENCE_A);
    const audienceB = res.body.groups.find((g: any) => g.dimensions.audienceId === AUDIENCE_B);
    expect(audienceA.totalCostInUsdCents).toBe("1.0000000000");
    expect(audienceB.totalCostInUsdCents).toBe("2.5000000000");
    expect(audienceA.dimensions.brandProfileId).toBe(BRAND_PROFILE_ID);
    expect(audienceA.dimensions.goal).toBe("signup");
    expect(audienceA.dimensions.workflowContext).toBe("lead-selection");
  });

  it("keeps untagged samples in a null group and excludes them when requested", async () => {
    const tagged = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "workflow-service",
      taskName: "execute",
      brandIds: [BRAND_ID],
      featureSlug: "cold-email",
      audienceId: AUDIENCE_A,
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
      audienceId: AUDIENCE_A,
    });
    await insertTestRunCost({
      runId: untagged.id,
      costName: "token",
      quantity: "500",
      unitCostInUsdCents: "0.0010000000",
      totalCostInUsdCents: "0.5000000000",
    });

    const all = await request(app)
      .get(`/v1/stats/costs?groupBy=audienceId&brandId=${BRAND_ID}&featureSlug=cold-email`)
      .set(authHeaders);

    expect(all.status).toBe(200);
    const taggedGroup = all.body.groups.find((g: any) => g.dimensions.audienceId === AUDIENCE_A);
    const untaggedGroup = all.body.groups.find((g: any) => g.dimensions.audienceId === null);
    expect(taggedGroup.totalCostInUsdCents).toBe("1.0000000000");
    expect(untaggedGroup.totalCostInUsdCents).toBe("0.5000000000");

    const onlyTagged = await request(app)
      .get(`/v1/stats/costs?groupBy=audienceId&brandId=${BRAND_ID}&featureSlug=cold-email&attributionStatus=tagged`)
      .set(authHeaders);

    expect(onlyTagged.status).toBe(200);
    expect(onlyTagged.body.groups).toHaveLength(1);
    expect(onlyTagged.body.groups[0].dimensions.audienceId).toBe(AUDIENCE_A);
  });

  it("keeps existing brandId aggregation compatible", async () => {
    const tagged = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc",
      taskName: "task",
      brandIds: [BRAND_ID],
      audienceId: AUDIENCE_A,
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
      audienceId: AUDIENCE_A,
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

  // --- Backward compatibility during rollout: the deprecated customerProfileId
  // vocabulary must keep working until features-service migrates. ---
  describe("legacy customerProfileId alias (deprecated, additive rollout)", () => {
    it("resolves the legacy x-customer-profile-id header to audienceId on run creation", async () => {
      const run = await request(app)
        .post("/v1/runs")
        .set({ ...authHeaders, "x-customer-profile-id": AUDIENCE_A })
        .send({ serviceName: "svc", taskName: "task" });

      expect(run.status).toBe(201);
      expect(run.body.audienceId).toBe(AUDIENCE_A);
    });

    it("still accepts groupBy=customerProfileId and round-trips the legacy response key", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "workflow-service",
        taskName: "execute",
        brandIds: [BRAND_ID],
        featureSlug: "cold-email",
        audienceId: AUDIENCE_A,
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "1000",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "1.0000000000",
        audienceId: AUDIENCE_A,
      });

      // Legacy groupBy token: response dimension is keyed `customerProfileId`,
      // value is the same audience id, sourced from the renamed column.
      const legacy = await request(app)
        .get(`/v1/stats/costs?groupBy=customerProfileId&brandId=${BRAND_ID}&featureSlug=cold-email`)
        .set(authHeaders);

      expect(legacy.status).toBe(200);
      expect(legacy.body.groups).toHaveLength(1);
      expect(legacy.body.groups[0].dimensions.customerProfileId).toBe(AUDIENCE_A);
      expect(legacy.body.groups[0].totalCostInUsdCents).toBe("1.0000000000");

      // Legacy filter param still narrows to the same column.
      const filtered = await request(app)
        .get(`/v1/stats/costs?groupBy=audienceId&brandId=${BRAND_ID}&customerProfileId=${AUDIENCE_A}`)
        .set(authHeaders);
      expect(filtered.status).toBe(200);
      expect(filtered.body.groups).toHaveLength(1);
      expect(filtered.body.groups[0].dimensions.audienceId).toBe(AUDIENCE_A);
    });
  });
});
