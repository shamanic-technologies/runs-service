import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

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

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
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
          workflowName: "auto-upgrade",
        });

      expect(res.status).toBe(201);
      expect(res.body.workflowName).toBe("auto-upgrade");
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
          "x-brand-id": "header-brand",
          "x-campaign-id": "header-campaign",
          "x-workflow-name": "header-workflow",
        })
        .send({
          serviceName: "workflow-service",
          taskName: "upgrade-workflows",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandId).toBe("header-brand");
      expect(res.body.campaignId).toBe("header-campaign");
      expect(res.body.workflowName).toBe("header-workflow");
    });

    it("header values take precedence over body values for platform runs", async () => {
      const res = await request(app)
        .post("/v1/platform-runs")
        .set({
          ...platformHeaders,
          "x-brand-id": "header-brand",
          "x-campaign-id": "header-campaign",
          "x-workflow-name": "header-workflow",
        })
        .send({
          serviceName: "workflow-service",
          taskName: "upgrade-workflows",
          brandId: "body-brand",
          campaignId: "body-campaign",
          workflowName: "body-workflow",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandId).toBe("header-brand");
      expect(res.body.campaignId).toBe("header-campaign");
      expect(res.body.workflowName).toBe("header-workflow");
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
});
