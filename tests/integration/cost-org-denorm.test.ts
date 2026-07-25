import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

// Migration 0029: the owning run's organization_id is frozen onto every cost row
// at write time (via the cost.added payload key `runOrganizationId` → the
// project_cost_lifecycle_to_silver trigger), so org-level platform-spend SUMs can
// read a single indexed table instead of joining runs. These tests assert the
// write-path/trigger populate the column; the read swap that consumes it ships in
// a later PR after the out-of-band backfill.

const ORG_ID = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a";
const USER_ID = "2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b";
const PF_ORG_ID = "3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c";

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

vi.mock("../../src/services/usage-discount.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/usage-discount.js")>();
  const { Decimal } = await import("decimal.js");
  return { ...actual, resolveUsageDiscount: vi.fn().mockResolvedValue(new Decimal(0)) };
});

describe("cost organization_id denormalization (migration 0029)", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders({ orgId: ORG_ID, userId: USER_ID });
  const platformHeaders = getPlatformAuthHeaders();

  beforeEach(async () => {
    await cleanTestData([ORG_ID, PF_ORG_ID, null]);
  });

  afterAll(async () => {
    await cleanTestData([ORG_ID, PF_ORG_ID, null]);
    await closeDb();
  });

  it("freezes the run's organization_id onto each org-run cost row", async () => {
    const run = await request(app)
      .post("/v1/runs")
      .set(authHeaders)
      .send({ serviceName: "workflow-service", taskName: "execute", featureSlug: "cold-email" });
    expect(run.status).toBe(201);

    const costs = await request(app)
      .post(`/v1/runs/${run.body.id}/costs`)
      .set(authHeaders)
      .send({ items: [{ costName: "token", costSource: "platform", quantity: 100 }] });

    expect(costs.status).toBe(201);
    expect(costs.body.costs).toHaveLength(1);
    expect(costs.body.costs[0].organizationId).toBe(ORG_ID);
  });

  it("leaves organization_id NULL for an org-less platform run cost", async () => {
    const run = await request(app)
      .post("/v1/platform-runs")
      .set(platformHeaders)
      .send({ serviceName: "workflow-service", taskName: "upgrade" });
    expect(run.status).toBe(201);
    expect(run.body.organizationId).toBeNull();

    const costs = await request(app)
      .post(`/v1/platform-runs/${run.body.id}/costs`)
      .set(platformHeaders)
      .send({ items: [{ costName: "token", costSource: "platform", quantity: 100 }] });

    expect(costs.status).toBe(201);
    expect(costs.body.costs[0].organizationId).toBeNull();
  });

  it("freezes the org onto a platform run cost when the run carries an org", async () => {
    const run = await request(app)
      .post("/v1/platform-runs")
      .set({ ...platformHeaders, "x-org-id": PF_ORG_ID })
      .send({ serviceName: "workflow-service", taskName: "upgrade" });
    expect(run.status).toBe(201);
    expect(run.body.organizationId).toBe(PF_ORG_ID);

    const costs = await request(app)
      .post(`/v1/platform-runs/${run.body.id}/costs`)
      .set({ ...platformHeaders, "x-org-id": PF_ORG_ID })
      .send({ items: [{ costName: "token", costSource: "platform", quantity: 100 }] });

    expect(costs.status).toBe(201);
    expect(costs.body.costs[0].organizationId).toBe(PF_ORG_ID);
  });
});
