import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

// Migration 0030: the owning run's started_at is frozen onto every cost row at
// write time (via the cost.added payload key `runStartedAt` → the
// project_cost_lifecycle_to_silver trigger), so the dated cross-org platform-spend
// series can read a single indexed table instead of joining runs for the date.
// These tests assert the write-path/trigger populate the column; the read swap
// that consumes it ships in a later PR after the out-of-band backfill.

const ORG_ID = "4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d";
const USER_ID = "5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e";

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

describe("cost run_started_at denormalization (migration 0030)", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders({ orgId: ORG_ID, userId: USER_ID });
  const platformHeaders = getPlatformAuthHeaders();

  beforeEach(async () => {
    await cleanTestData([ORG_ID, null]);
  });

  afterAll(async () => {
    await cleanTestData([ORG_ID, null]);
    await closeDb();
  });

  it("freezes the run's started_at onto each org-run cost row", async () => {
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
    // Frozen from the RUN, not from the cost row's own created_at — the dated
    // spend series must bucket on the same instant the old runs-join used.
    expect(new Date(costs.body.costs[0].runStartedAt as string).toISOString()).toBe(
      new Date(run.body.startedAt as string).toISOString()
    );
  });

  it("freezes the run's started_at onto a platform run cost row", async () => {
    const run = await request(app)
      .post("/v1/platform-runs")
      .set(platformHeaders)
      .send({ serviceName: "workflow-service", taskName: "upgrade" });
    expect(run.status).toBe(201);

    const costs = await request(app)
      .post(`/v1/platform-runs/${run.body.id}/costs`)
      .set(platformHeaders)
      .send({ items: [{ costName: "token", costSource: "platform", quantity: 100 }] });

    expect(costs.status).toBe(201);
    expect(new Date(costs.body.costs[0].runStartedAt as string).toISOString()).toBe(
      new Date(run.body.startedAt as string).toISOString()
    );
  });
});
