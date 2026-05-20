import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getPlatformAuthHeaders, TEST_BRAND_A, TEST_BRAND_B } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const PF_ORG_ID = "33333333-1111-4111-aaaa-111111111111";
const PF_USER_ID = "44444444-1111-4111-aaaa-111111111111";

// Mock cost-resolver for integration tests
vi.mock("../../src/services/cost-resolver.js", () => ({
  resolveMultipleUnitCosts: vi.fn().mockResolvedValue(
    new Map([
      ["claude-sonnet-input-token", "0.0003000000"],
      ["claude-sonnet-output-token", "0.0015000000"],
    ])
  ),
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

describe("Platform Runs", () => {
  const app = createTestApp();
  const platformHeaders = getPlatformAuthHeaders();

  // Platform runs have organization_id = NULL; cleanup must target null-org rows.
  // Also clean the test orgs used by identity-passthrough tests.
  beforeEach(async () => {
    await cleanTestData([null, PF_ORG_ID]);
  });

  afterAll(async () => {
    await cleanTestData([null, PF_ORG_ID]);
    await closeDb();
  });

  describe("POST /v1/platform-runs", () => {
    it("creates a platform run with null organizationId and userId", async () => {
      const res = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({
          serviceName: "workflow-service",
          taskName: "upgrade-workflows",
        });

      expect(res.status).toBe(201);
      expect(res.body.organizationId).toBeNull();
      expect(res.body.userId).toBeNull();
      expect(res.body.serviceName).toBe("workflow-service");
      expect(res.body.taskName).toBe("upgrade-workflows");
      expect(res.body.status).toBe("running");
      expect(res.body.id).toBeDefined();
    });

    it("creates a platform run with optional context fields", async () => {
      const res = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({
          serviceName: "workflow-service",
          taskName: "upgrade-workflows",
          workflowSlug: "auto-upgrade",
        });

      expect(res.status).toBe(201);
      expect(res.body.workflowSlug).toBe("auto-upgrade");
    });

    it("rejects request without x-service-name header", async () => {
      const res = await request(app)
        .post("/v1/platform-runs")
        .set({
          "X-API-Key": "test-api-key",
          "Content-Type": "application/json",
        })
        .send({
          serviceName: "workflow-service",
          taskName: "upgrade-workflows",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("x-service-name");
    });

    it("rejects request without API key", async () => {
      const res = await request(app)
        .post("/v1/platform-runs")
        .set({
          "Content-Type": "application/json",
          "x-service-name": "workflow-service",
        })
        .send({
          serviceName: "workflow-service",
          taskName: "upgrade-workflows",
        });

      expect(res.status).toBe(401);
    });

    it("uses workflow tracking headers as fallback", async () => {
      const res = await request(app)
        .post("/v1/platform-runs")
        .set({
          ...platformHeaders,
          "x-brand-id": TEST_BRAND_A,
          "x-campaign-id": "header-campaign",
          "x-workflow-slug": "header-workflow",
        })
        .send({
          serviceName: "workflow-service",
          taskName: "upgrade-workflows",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandIds).toEqual([TEST_BRAND_A]);
      expect(res.body.campaignId).toBe("header-campaign");
      expect(res.body.workflowSlug).toBe("header-workflow");
    });

    it("header values take precedence over body values for platform runs", async () => {
      const res = await request(app)
        .post("/v1/platform-runs")
        .set({
          ...platformHeaders,
          "x-brand-id": TEST_BRAND_A,
          "x-campaign-id": "header-campaign",
          "x-workflow-slug": "header-workflow",
        })
        .send({
          serviceName: "workflow-service",
          taskName: "upgrade-workflows",
          brandIds: [TEST_BRAND_B],
          campaignId: "body-campaign",
          workflowSlug: "body-workflow",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandIds).toEqual([TEST_BRAND_A]);
      expect(res.body.campaignId).toBe("header-campaign");
      expect(res.body.workflowSlug).toBe("header-workflow");
    });

    it("rejects invalid body", async () => {
      const res = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe("POST /v1/platform-runs/:id/costs", () => {
    it("adds costs to a platform run", async () => {
      // Create a platform run first
      const createRes = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({
          serviceName: "workflow-service",
          taskName: "upgrade-workflows",
        });

      const runId = createRes.body.id;

      const res = await request(app)
        .post(`/v1/platform-runs/${runId}/costs`)
        .set(platformHeaders)
        .send({
          items: [
            {
              costName: "claude-sonnet-input-token",
              costSource: "platform",
              quantity: 1000,
            },
            {
              costName: "claude-sonnet-output-token",
              costSource: "platform",
              quantity: 500,
            },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.costs).toHaveLength(2);
      expect(res.body.costs[0].runId).toBe(runId);
      expect(res.body.costs[0].costName).toBe("claude-sonnet-input-token");
    });

    it("returns 404 for non-existent run", async () => {
      const res = await request(app)
        .post("/v1/platform-runs/00000000-0000-0000-0000-000000000000/costs")
        .set(platformHeaders)
        .send({
          items: [
            {
              costName: "claude-sonnet-input-token",
              costSource: "platform",
              quantity: 1000,
            },
          ],
        });

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /v1/platform-runs/:id", () => {
    it("updates platform run status to completed", async () => {
      const createRes = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({
          serviceName: "workflow-service",
          taskName: "upgrade-workflows",
        });

      const runId = createRes.body.id;

      const res = await request(app)
        .patch(`/v1/platform-runs/${runId}`)
        .set(platformHeaders)
        .send({ status: "completed" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("completed");
      expect(res.body.completedAt).toBeDefined();
    });

    it("updates platform run status to failed", async () => {
      const createRes = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({
          serviceName: "workflow-service",
          taskName: "upgrade-workflows",
        });

      const runId = createRes.body.id;

      const res = await request(app)
        .patch(`/v1/platform-runs/${runId}`)
        .set(platformHeaders)
        .send({ status: "failed" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("failed");
    });

    it("returns 404 for non-existent run", async () => {
      const res = await request(app)
        .patch("/v1/platform-runs/00000000-0000-0000-0000-000000000000")
        .set(platformHeaders)
        .send({ status: "completed" });

      expect(res.status).toBe(404);
    });

    it("rejects invalid status", async () => {
      const createRes = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({
          serviceName: "workflow-service",
          taskName: "upgrade-workflows",
        });

      const res = await request(app)
        .patch(`/v1/platform-runs/${createRes.body.id}`)
        .set(platformHeaders)
        .send({ status: "invalid" });

      expect(res.status).toBe(400);
    });
  });

  describe("Optional identity headers on /v1/platform-runs", () => {
    it("stores x-org-id and x-user-id on the row when provided", async () => {
      const res = await request(app)
        .post("/v1/platform-runs")
        .set({
          ...platformHeaders,
          "x-org-id": PF_ORG_ID,
          "x-user-id": PF_USER_ID,
        })
        .send({
          serviceName: "stripe-service",
          taskName: "charge.succeeded",
        });

      expect(res.status).toBe(201);
      expect(res.body.organizationId).toBe(PF_ORG_ID);
      expect(res.body.userId).toBe(PF_USER_ID);
    });

    it("accepts x-org-id without x-user-id", async () => {
      const res = await request(app)
        .post("/v1/platform-runs")
        .set({
          ...platformHeaders,
          "x-org-id": PF_ORG_ID,
        })
        .send({
          serviceName: "stripe-service",
          taskName: "charge.succeeded",
        });

      expect(res.status).toBe(201);
      expect(res.body.organizationId).toBe(PF_ORG_ID);
      expect(res.body.userId).toBeNull();
    });

    it("rejects non-UUID x-org-id with 400", async () => {
      const res = await request(app)
        .post("/v1/platform-runs")
        .set({
          ...platformHeaders,
          "x-org-id": "not-a-uuid",
        })
        .send({
          serviceName: "stripe-service",
          taskName: "charge.succeeded",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/x-org-id/);
    });

    it("rejects non-UUID x-user-id with 400", async () => {
      const res = await request(app)
        .post("/v1/platform-runs")
        .set({
          ...platformHeaders,
          "x-org-id": PF_ORG_ID,
          "x-user-id": "not-a-uuid",
        })
        .send({
          serviceName: "stripe-service",
          taskName: "charge.succeeded",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/x-user-id/);
    });
  });

  describe("idempotencyKey on /v1/platform-runs", () => {
    it("returns 200 with the existing run on replay with same idempotencyKey", async () => {
      const key = "idem-pf-1";
      const first = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({
          serviceName: "stripe-service",
          taskName: "charge.succeeded",
          idempotencyKey: key,
        });

      expect(first.status).toBe(201);
      const originalId = first.body.id;

      const second = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({
          serviceName: "stripe-service",
          taskName: "charge.succeeded",
          idempotencyKey: key,
        });

      expect(second.status).toBe(200);
      expect(second.body.id).toBe(originalId);
    });

    it("returns 409 when the same key is reused with a different (serviceName, taskName)", async () => {
      const key = "idem-pf-2";
      await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({
          serviceName: "stripe-service",
          taskName: "charge.succeeded",
          idempotencyKey: key,
        });

      const res = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({
          serviceName: "stripe-service",
          taskName: "charge.refunded",
          idempotencyKey: key,
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/idempotencyKey/);
    });

    it("rejects idempotencyKey longer than 256 chars with 400", async () => {
      const tooLong = "x".repeat(257);
      const res = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({
          serviceName: "stripe-service",
          taskName: "charge.succeeded",
          idempotencyKey: tooLong,
        });

      expect(res.status).toBe(400);
    });

    it("creates a new run when no idempotencyKey is supplied (dedup off)", async () => {
      const r1 = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({ serviceName: "stripe-service", taskName: "charge.succeeded" });
      const r2 = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({ serviceName: "stripe-service", taskName: "charge.succeeded" });

      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(r1.body.id).not.toBe(r2.body.id);
    });
  });

  describe("idempotencyKey on /v1/platform-runs/:id/costs", () => {
    it("dedupes per-item idempotencyKey within a run", async () => {
      const createRes = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({ serviceName: "stripe-service", taskName: "charge.succeeded" });
      const runId = createRes.body.id;

      const item = {
        costName: "claude-sonnet-input-token",
        costSource: "platform" as const,
        quantity: 1000,
        idempotencyKey: "idem-cost-pf-1",
      };

      const first = await request(app)
        .post(`/v1/platform-runs/${runId}/costs`)
        .set(platformHeaders)
        .send({ items: [item] });
      const second = await request(app)
        .post(`/v1/platform-runs/${runId}/costs`)
        .set(platformHeaders)
        .send({ items: [item] });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.costs).toHaveLength(1);
      expect(second.body.costs).toHaveLength(1);
      expect(second.body.costs[0].id).toBe(first.body.costs[0].id);
    });

    it("allows the same idempotencyKey across different runs (run-scoped uniqueness)", async () => {
      const r1 = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({ serviceName: "stripe-service", taskName: "charge.succeeded" });
      const r2 = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({ serviceName: "stripe-service", taskName: "charge.succeeded" });

      const item = {
        costName: "claude-sonnet-input-token",
        costSource: "platform" as const,
        quantity: 1000,
        idempotencyKey: "idem-cost-pf-shared",
      };

      const c1 = await request(app)
        .post(`/v1/platform-runs/${r1.body.id}/costs`)
        .set(platformHeaders)
        .send({ items: [item] });
      const c2 = await request(app)
        .post(`/v1/platform-runs/${r2.body.id}/costs`)
        .set(platformHeaders)
        .send({ items: [item] });

      expect(c1.status).toBe(201);
      expect(c2.status).toBe(201);
      expect(c1.body.costs[0].id).not.toBe(c2.body.costs[0].id);
    });
  });
});
