import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders, TEST_ORG_ID, TEST_USER_ID } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestRun,
  insertTestRunCost,
  closeDb,
} from "../helpers/test-db.js";

// Mock cost-resolver for integration tests
vi.mock("../../src/services/cost-resolver.js", () => ({
  resolveMultipleUnitCosts: vi.fn().mockResolvedValue(
    new Map([
      ["gpt-4o-input-token", "0.0003000000"],
      ["gpt-4o-output-token", "0.0012000000"],
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

// Mock billing client for integration tests
vi.mock("../../src/services/billing.js", () => ({
  deductCredits: vi.fn().mockResolvedValue({
    success: true,
    balance_cents: 5000,
    billing_mode: "payg",
    depleted: false,
  }),
  provisionCredits: vi.fn().mockResolvedValue({
    provision_id: "prov_test_123",
    balance_cents: 4500,
  }),
  confirmProvision: vi.fn().mockResolvedValue({
    success: true,
    balance_cents: 4500,
  }),
  cancelProvision: vi.fn().mockResolvedValue({
    success: true,
    balance_cents: 5500,
  }),
  BillingError: class BillingError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

describe("Runs CRUD", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("POST /v1/runs", () => {
    it("creates a new run using x-org-id and x-user-id headers", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          serviceName: "chat-service",
          taskName: "agent-run",
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("running");
      expect(res.body.serviceName).toBe("chat-service");
      expect(res.body.taskName).toBe("agent-run");
      expect(res.body.organizationId).toBe(TEST_ORG_ID);
      expect(res.body.userId).toBe(TEST_USER_ID);
    });

    it("creates run without x-user-id (optional)", async () => {
      const headers = {
        "X-API-Key": "test-api-key",
        "Content-Type": "application/json",
        "x-org-id": TEST_ORG_ID,
      };

      const res = await request(app)
        .post("/v1/runs")
        .set(headers)
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.userId).toBeNull();
    });

    it("returns 400 when x-org-id is missing", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({
          "X-API-Key": "test-api-key",
          "Content-Type": "application/json",
        })
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("x-org-id");
    });

    it("returns 400 when x-org-id is not a valid UUID", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({
          "X-API-Key": "test-api-key",
          "Content-Type": "application/json",
          "x-org-id": "not-a-uuid",
        })
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("x-org-id");
    });

    it("creates a child run via x-run-id header", async () => {
      const parent = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "parent-svc",
        taskName: "parent-task",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set({ ...authHeaders, "x-run-id": parent.id })
        .send({
          serviceName: "child-svc",
          taskName: "child-task",
        });

      expect(res.status).toBe(201);
      expect(res.body.parentRunId).toBe(parent.id);
    });

    it("returns 400 when x-run-id does not exist in runs table", async () => {
      const fakeParentId = "00000000-0000-0000-0000-000000000000";

      const res = await request(app)
        .post("/v1/runs")
        .set({ ...authHeaders, "x-run-id": fakeParentId })
        .send({
          serviceName: "orphan-svc",
          taskName: "orphan-task",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain(fakeParentId);
    });

    it("returns 400 when x-run-id is not a valid UUID", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({ ...authHeaders, "x-run-id": "not-a-uuid" })
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("x-run-id");
    });

    it("rejects without required fields", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({});
      expect(res.status).toBe(400);
    });

    it("stores optional brandId and campaignId", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          brandId: "brand_1",
          campaignId: "campaign_1",
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandId).toBe("brand_1");
      expect(res.body.campaignId).toBe("campaign_1");
    });

    it("stores workflowName when provided", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          workflowName: "sales-cold-email-v1",
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.workflowName).toBe("sales-cold-email-v1");
    });

    it("workflowName defaults to null", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.workflowName).toBeNull();
    });

    it("inherits workflowName, brandId, campaignId from parent", async () => {
      const parent = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "parent-svc",
        taskName: "parent-task",
        brandId: "inherited-brand",
        campaignId: "inherited-campaign",
        workflowName: "inherited-workflow",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set({ ...authHeaders, "x-run-id": parent.id })
        .send({
          serviceName: "child-svc",
          taskName: "child-task",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandId).toBe("inherited-brand");
      expect(res.body.campaignId).toBe("inherited-campaign");
      expect(res.body.workflowName).toBe("inherited-workflow");
    });

    it("returns 409 when body values conflict with parent", async () => {
      const parent = await insertTestRun({
        organizationId: TEST_ORG_ID,
        userId: TEST_USER_ID,
        serviceName: "parent-svc",
        taskName: "parent-task",
        brandId: "parent-brand",
        campaignId: "parent-campaign",
        workflowName: "parent-workflow",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set({ ...authHeaders, "x-run-id": parent.id })
        .send({
          serviceName: "child-svc",
          taskName: "child-task",
          brandId: "child-brand",
          campaignId: "child-campaign",
          workflowName: "child-workflow",
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Parent-child field conflict");
      expect(res.body.conflicts).toHaveLength(3);
    });

    it("returns 409 when header values conflict with parent", async () => {
      const parent = await insertTestRun({
        organizationId: TEST_ORG_ID,
        userId: TEST_USER_ID,
        serviceName: "parent-svc",
        taskName: "parent-task",
        workflowName: "parent-workflow",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-run-id": parent.id,
          "x-workflow-name": "different-workflow",
        })
        .send({
          serviceName: "child-svc",
          taskName: "child-task",
        });

      expect(res.status).toBe(409);
      expect(res.body.conflicts).toEqual(
        expect.arrayContaining([expect.stringContaining("workflowName")])
      );
    });

    it("returns 409 when orgId conflicts with parent", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";
      const parent = await insertTestRun({
        organizationId: otherOrgId,
        serviceName: "parent-svc",
        taskName: "parent-task",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set({ ...authHeaders, "x-run-id": parent.id })
        .send({
          serviceName: "child-svc",
          taskName: "child-task",
        });

      expect(res.status).toBe(409);
      expect(res.body.conflicts).toEqual(
        expect.arrayContaining([expect.stringContaining("orgId")])
      );
    });

    it("allows same values as parent (no conflict)", async () => {
      const parent = await insertTestRun({
        organizationId: TEST_ORG_ID,
        userId: TEST_USER_ID,
        serviceName: "parent-svc",
        taskName: "parent-task",
        brandId: "same-brand",
        campaignId: "same-campaign",
        workflowName: "same-workflow",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-run-id": parent.id,
          "x-brand-id": "same-brand",
          "x-campaign-id": "same-campaign",
          "x-workflow-name": "same-workflow",
        })
        .send({
          serviceName: "child-svc",
          taskName: "child-task",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandId).toBe("same-brand");
    });

    it("uses x-brand-id, x-campaign-id, x-workflow-name headers as fallback", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-brand-id": "header-brand",
          "x-campaign-id": "header-campaign",
          "x-workflow-name": "header-workflow",
        })
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandId).toBe("header-brand");
      expect(res.body.campaignId).toBe("header-campaign");
      expect(res.body.workflowName).toBe("header-workflow");
    });

    it("header values take precedence over body values", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-brand-id": "header-brand",
          "x-campaign-id": "header-campaign",
          "x-workflow-name": "header-workflow",
        })
        .send({
          serviceName: "svc",
          taskName: "task",
          brandId: "body-brand",
          campaignId: "body-campaign",
          workflowName: "body-workflow",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandId).toBe("header-brand");
      expect(res.body.campaignId).toBe("header-campaign");
      expect(res.body.workflowName).toBe("header-workflow");
    });

    it("body values fill in gaps when header has partial values", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-brand-id": "header-brand",
        })
        .send({
          serviceName: "svc",
          taskName: "task",
          brandId: "body-brand",
          campaignId: "body-campaign",
          workflowName: "body-workflow",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandId).toBe("header-brand");
      expect(res.body.campaignId).toBe("body-campaign");
      expect(res.body.workflowName).toBe("body-workflow");
    });

    it("headers do not break existing behavior when absent", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandId).toBeNull();
      expect(res.body.campaignId).toBeNull();
      expect(res.body.workflowName).toBeNull();
    });

    it("no inheritance when parent has null values", async () => {
      const parent = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "parent-svc",
        taskName: "parent-task",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set({ ...authHeaders, "x-run-id": parent.id })
        .send({
          serviceName: "child-svc",
          taskName: "child-task",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandId).toBeNull();
      expect(res.body.campaignId).toBeNull();
      expect(res.body.workflowName).toBeNull();
    });

    it("stores featureSlug from x-feature-slug header", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-feature-slug": "cold-email-v2",
        })
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.featureSlug).toBe("cold-email-v2");
    });

    it("x-feature-slug header takes precedence over body featureSlug", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-feature-slug": "header-feature",
        })
        .send({
          serviceName: "svc",
          taskName: "task",
          featureSlug: "body-feature",
        });

      expect(res.status).toBe(201);
      expect(res.body.featureSlug).toBe("header-feature");
    });

    it("featureSlug defaults to null when not provided", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.featureSlug).toBeNull();
    });

    it("inherits featureSlug from parent", async () => {
      const parent = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "parent-svc",
        taskName: "parent-task",
        featureSlug: "inherited-feature",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set({ ...authHeaders, "x-run-id": parent.id })
        .send({
          serviceName: "child-svc",
          taskName: "child-task",
        });

      expect(res.status).toBe(201);
      expect(res.body.featureSlug).toBe("inherited-feature");
    });

    it("returns 409 when featureSlug conflicts with parent", async () => {
      const parent = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "parent-svc",
        taskName: "parent-task",
        featureSlug: "parent-feature",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-run-id": parent.id,
          "x-feature-slug": "different-feature",
        })
        .send({
          serviceName: "child-svc",
          taskName: "child-task",
        });

      expect(res.status).toBe(409);
      expect(res.body.conflicts).toEqual(
        expect.arrayContaining([expect.stringContaining("featureSlug")])
      );
    });
  });

  describe("POST /v1/runs/:id/costs", () => {
    it("adds cost line items to a run", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [
            { costName: "gpt-4o-input-token", costSource: "platform", quantity: 1000 },
            { costName: "gpt-4o-output-token", costSource: "org", quantity: 200 },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.costs).toHaveLength(2);
      expect(res.body.costs[0].costSource).toBe("platform");
      expect(res.body.costs[1].costSource).toBe("org");
    });

    it("returns 400 when costSource is missing", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [{ costName: "gpt-4o-input-token", quantity: 1000 }],
        });

      expect(res.status).toBe(400);
    });

    it("returns 400 when costSource has invalid value", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [{ costName: "gpt-4o-input-token", costSource: "invalid", quantity: 1000 }],
        });

      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown run", async () => {
      const res = await request(app)
        .post("/v1/runs/00000000-0000-0000-0000-000000000000/costs")
        .set(authHeaders)
        .send({ items: [{ costName: "test", costSource: "platform", quantity: 1 }] });

      expect(res.status).toBe(404);
    });

    it("returns 502 when costs-service is unavailable", async () => {
      const { resolveMultipleUnitCosts } = await import("../../src/services/cost-resolver.js");
      const { UpstreamError } = await import("../../src/services/cost-resolver.js");
      const mockedResolve = vi.mocked(resolveMultipleUnitCosts);

      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      mockedResolve.mockRejectedValueOnce(new UpstreamError(502, "costs-service returned 502"));

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({ items: [{ costName: "gpt-4o-input-token", costSource: "platform", quantity: 1000 }] });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain("costs-service");
    });

    it("forwards run identity to cost-resolver even without x-user-id and x-run-id headers", async () => {
      const { resolveMultipleUnitCosts } = await import("../../src/services/cost-resolver.js");
      const mockedResolve = vi.mocked(resolveMultipleUnitCosts);
      mockedResolve.mockResolvedValueOnce(
        new Map([["gpt-4o-input-token", "0.0003000000"]])
      );

      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        userId: TEST_USER_ID,
        serviceName: "svc",
        taskName: "task",
      });

      // Send only x-org-id, omit x-user-id and x-run-id
      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set({
          "X-API-Key": "test-api-key",
          "Content-Type": "application/json",
          "x-org-id": TEST_ORG_ID,
        })
        .send({
          items: [{ costName: "gpt-4o-input-token", costSource: "platform", quantity: 1000 }],
        });

      expect(res.status).toBe(201);

      // Verify cost-resolver received identity from the run record
      expect(mockedResolve).toHaveBeenCalledWith(
        ["gpt-4o-input-token"],
        expect.objectContaining({
          orgId: TEST_ORG_ID,
          userId: TEST_USER_ID,
          runId: run.id,
        })
      );
    });
  });

  describe("PATCH /v1/runs/:id", () => {
    it("completes a run", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .patch(`/v1/runs/${run.id}`)
        .set(authHeaders)
        .send({ status: "completed" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("completed");
      expect(res.body.completedAt).toBeDefined();
    });

    it("rejects invalid status", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .patch(`/v1/runs/${run.id}`)
        .set(authHeaders)
        .send({ status: "invalid" });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /v1/runs/:id", () => {
    it("returns run with costs and computes total including children", async () => {
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

      await insertTestRunCost({
        runId: parent.id,
        costName: "input-token",
        quantity: "1000",
        unitCostInUsdCents: "0.0003000000",
        totalCostInUsdCents: "0.3000000000",
      });

      await insertTestRunCost({
        runId: child.id,
        costName: "input-token",
        quantity: "500",
        unitCostInUsdCents: "0.0003000000",
        totalCostInUsdCents: "0.1500000000",
      });

      const res = await request(app)
        .get(`/v1/runs/${parent.id}`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.ownCostInUsdCents).toBe("0.3000000000");
      expect(res.body.childrenCostInUsdCents).toBe("0.1500000000");
      expect(res.body.totalCostInUsdCents).toBe("0.4500000000");
    });

    it("returns descendantRuns with costs", async () => {
      const parent = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "lead-service",
        taskName: "enrich-lead",
      });
      const child = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "apollo-service",
        taskName: "search-people",
        parentRunId: parent.id,
      });

      await insertTestRunCost({
        runId: child.id,
        costName: "apollo-credit",
        quantity: "1",
        unitCostInUsdCents: "34.0000000000",
        totalCostInUsdCents: "34.0000000000",
      });

      const res = await request(app)
        .get(`/v1/runs/${parent.id}`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.descendantRuns).toHaveLength(1);
      expect(res.body.descendantRuns[0].id).toBe(child.id);
      expect(res.body.descendantRuns[0].parentRunId).toBe(parent.id);
      expect(res.body.descendantRuns[0].serviceName).toBe("apollo-service");
      expect(res.body.descendantRuns[0].costs).toHaveLength(1);
      expect(res.body.descendantRuns[0].ownCostInUsdCents).toBe("34.0000000000");
    });

    it("returns multi-level descendants (grandchildren)", async () => {
      const parent = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc-a",
        taskName: "task-a",
      });
      const child = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc-b",
        taskName: "task-b",
        parentRunId: parent.id,
      });
      const grandchild = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc-c",
        taskName: "task-c",
        parentRunId: child.id,
      });

      await insertTestRunCost({
        runId: grandchild.id,
        costName: "token",
        quantity: "100",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.1000000000",
      });

      const res = await request(app)
        .get(`/v1/runs/${parent.id}`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.descendantRuns).toHaveLength(2);
      expect(res.body.childrenCostInUsdCents).toBe("0.1000000000");

      const gcRun = res.body.descendantRuns.find((r: any) => r.id === grandchild.id);
      expect(gcRun).toBeDefined();
      expect(gcRun.parentRunId).toBe(child.id);
    });

    it("returns empty descendantRuns when no children", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .get(`/v1/runs/${run.id}`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.descendantRuns).toEqual([]);
    });
  });

  describe("POST /v1/runs/:id/costs (cost status)", () => {
    it("creates provisioned cost items", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "email-svc",
        taskName: "send-sequence",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [
            { costName: "gpt-4o-input-token", costSource: "platform", quantity: 1000, status: "provisioned" },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.costs[0].status).toBe("provisioned");
    });

    it("defaults status to actual when omitted", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [{ costName: "gpt-4o-input-token", costSource: "platform", quantity: 1000 }],
        });

      expect(res.status).toBe(201);
      expect(res.body.costs[0].status).toBe("actual");
    });
  });

  describe("PATCH /v1/runs/:id/costs/:costId", () => {
    it("realizes a provisioned cost", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });
      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "email-send",
        quantity: "1",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "0.5000000000",
        status: "provisioned",
      });

      const res = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "actual" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("actual");
      expect(res.body.id).toBe(cost.id);
    });

    it("cancels a provisioned cost", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });
      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "email-send",
        quantity: "1",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "0.5000000000",
        status: "provisioned",
      });

      const res = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "cancelled" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("cancelled");
    });

    it("cancelled costs are excluded from totals", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      await insertTestRunCost({
        runId: run.id,
        costName: "email-send",
        quantity: "1",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "0.5000000000",
        status: "actual",
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "email-send",
        quantity: "1",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "0.5000000000",
        status: "cancelled",
      });

      const res = await request(app)
        .get(`/v1/runs/${run.id}`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.costs).toHaveLength(2);
      expect(res.body.ownCostInUsdCents).toBe("0.5000000000");
      expect(res.body.ownActualCostInUsdCents).toBe("0.5000000000");
      expect(res.body.ownProvisionedCostInUsdCents).toBe("0.0000000000");
    });

    it("returns 404 for non-existent cost", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .patch(`/v1/runs/${run.id}/costs/00000000-0000-0000-0000-000000000000`)
        .set(authHeaders)
        .send({ status: "actual" });

      expect(res.status).toBe(404);
    });

    it("returns 404 for cost belonging to different run", async () => {
      const run1 = await insertTestRun({ organizationId: TEST_ORG_ID, serviceName: "svc", taskName: "t1" });
      const run2 = await insertTestRun({ organizationId: TEST_ORG_ID, serviceName: "svc", taskName: "t2" });
      const cost = await insertTestRunCost({
        runId: run1.id,
        costName: "token",
        quantity: "1",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.0010000000",
        status: "provisioned",
      });

      const res = await request(app)
        .patch(`/v1/runs/${run2.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "actual" });

      expect(res.status).toBe(404);
    });

    it("rejects invalid status value", async () => {
      const run = await insertTestRun({ organizationId: TEST_ORG_ID, serviceName: "svc", taskName: "task" });

      const res = await request(app)
        .patch(`/v1/runs/${run.id}/costs/00000000-0000-0000-0000-000000000000`)
        .set(authHeaders)
        .send({ status: "maybe" });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /v1/runs/:id (cost status breakdown)", () => {
    it("returns actual vs provisioned cost breakdown", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "email-svc",
        taskName: "send-sequence",
      });

      await insertTestRunCost({
        runId: run.id,
        costName: "email-send",
        quantity: "1",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "0.5000000000",
        status: "actual",
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "email-send",
        quantity: "1",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "0.5000000000",
        status: "provisioned",
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "email-send",
        quantity: "1",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "0.5000000000",
        status: "provisioned",
      });

      const res = await request(app)
        .get(`/v1/runs/${run.id}`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.ownCostInUsdCents).toBe("1.5000000000");
      expect(res.body.ownActualCostInUsdCents).toBe("0.5000000000");
      expect(res.body.ownProvisionedCostInUsdCents).toBe("1.0000000000");
      expect(res.body.totalCostInUsdCents).toBe("1.5000000000");
      expect(res.body.actualCostInUsdCents).toBe("0.5000000000");
      expect(res.body.provisionedCostInUsdCents).toBe("1.0000000000");
    });

    it("includes provisioned breakdown for descendant runs", async () => {
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

      await insertTestRunCost({
        runId: child.id,
        costName: "email-send",
        quantity: "1",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "0.5000000000",
        status: "provisioned",
      });

      const res = await request(app)
        .get(`/v1/runs/${parent.id}`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.childrenProvisionedCostInUsdCents).toBe("0.5000000000");
      expect(res.body.childrenActualCostInUsdCents).toBe("0.0000000000");
      expect(res.body.descendantRuns[0].ownProvisionedCostInUsdCents).toBe("0.5000000000");
      expect(res.body.descendantRuns[0].ownActualCostInUsdCents).toBe("0.0000000000");
    });
  });

  describe("GET /v1/runs", () => {
    it("lists runs for the org from x-org-id header", async () => {
      await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc-a",
        taskName: "task-1",
      });
      await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc-b",
        taskName: "task-2",
      });

      const res = await request(app)
        .get("/v1/runs")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(2);
    });

    it("does not return runs from other orgs", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";
      await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "mine",
      });
      await insertTestRun({
        organizationId: otherOrgId,
        serviceName: "svc",
        taskName: "theirs",
      });

      const res = await request(app)
        .get("/v1/runs")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0].taskName).toBe("mine");
    });

    it("includes ownCostInUsdCents per run", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "1000",
        unitCostInUsdCents: "0.0003000000",
        totalCostInUsdCents: "0.3000000000",
      });

      const res = await request(app)
        .get("/v1/runs")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0].ownCostInUsdCents).toBe("0.3000000000");
    });

    it("filters by parentRunId", async () => {
      const parent = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "parent",
      });
      await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "child-1",
        parentRunId: parent.id,
      });
      await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "child-2",
        parentRunId: parent.id,
      });
      await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "unrelated",
      });

      const res = await request(app)
        .get(`/v1/runs?parentRunId=${parent.id}`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(2);
      expect(res.body.runs.every((r: any) => r.parentRunId === parent.id)).toBe(true);
    });

    it("includes own actual and provisioned cost per run", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "100",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.1000000000",
        status: "actual",
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "200",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.2000000000",
        status: "provisioned",
      });

      const res = await request(app)
        .get("/v1/runs")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs[0].ownCostInUsdCents).toBe("0.3000000000");
      expect(res.body.runs[0].ownActualCostInUsdCents).toBe("0.1000000000");
      expect(res.body.runs[0].ownProvisionedCostInUsdCents).toBe("0.2000000000");
    });

    it("filters by workflowName", async () => {
      await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "sales-cold-email-v1",
      });
      await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "journalist-outreach-v2",
      });

      const res = await request(app)
        .get("/v1/runs?workflowName=sales-cold-email-v1")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0].workflowName).toBe("sales-cold-email-v1");
    });
  });

  describe("Billing integration", () => {
    it("calls deductCredits for actual + platform cost items", async () => {
      const { deductCredits } = await import("../../src/services/billing.js");
      const mockedDeduct = vi.mocked(deductCredits);
      mockedDeduct.mockClear();

      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [
            { costName: "gpt-4o-input-token", costSource: "platform", quantity: 1000 },
            { costName: "gpt-4o-output-token", costSource: "platform", quantity: 200 },
          ],
        });

      expect(res.status).toBe(201);
      expect(mockedDeduct).toHaveBeenCalledTimes(1);
      expect(mockedDeduct).toHaveBeenCalledWith(
        expect.any(Number),
        expect.stringContaining(`run:${run.id}`),
        expect.objectContaining({ orgId: TEST_ORG_ID }),
      );
    });

    it("does NOT call deductCredits for org (BYOK) cost items", async () => {
      const { deductCredits } = await import("../../src/services/billing.js");
      const mockedDeduct = vi.mocked(deductCredits);
      mockedDeduct.mockClear();

      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [
            { costName: "gpt-4o-input-token", costSource: "org", quantity: 1000 },
          ],
        });

      expect(res.status).toBe(201);
      expect(mockedDeduct).not.toHaveBeenCalled();
    });

    it("calls provisionCredits for provisioned + platform items and stores provision_id", async () => {
      const { provisionCredits } = await import("../../src/services/billing.js");
      const mockedProvision = vi.mocked(provisionCredits);
      mockedProvision.mockClear();

      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [
            { costName: "gpt-4o-input-token", costSource: "platform", quantity: 1000, status: "provisioned" },
          ],
        });

      expect(res.status).toBe(201);
      expect(mockedProvision).toHaveBeenCalledTimes(1);
      expect(res.body.costs[0].billingProvisionId).toBe("prov_test_123");
    });

    it("returns 402 when deduction fails (success: false)", async () => {
      const { deductCredits } = await import("../../src/services/billing.js");
      const mockedDeduct = vi.mocked(deductCredits);
      mockedDeduct.mockResolvedValueOnce({
        success: false,
        balance_cents: 0,
        billing_mode: "payg",
        depleted: true,
      });

      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [
            { costName: "gpt-4o-input-token", costSource: "platform", quantity: 1000 },
          ],
        });

      expect(res.status).toBe(402);
      expect(res.body.error).toContain("Credit deduction failed");
      // Costs should still be in the response (persisted in DB)
      expect(res.body.costs).toHaveLength(1);
    });

    it("returns 502 when billing-service is down", async () => {
      const { deductCredits, BillingError } = await import("../../src/services/billing.js");
      const mockedDeduct = vi.mocked(deductCredits);
      mockedDeduct.mockRejectedValueOnce(new BillingError(502, "billing-service returned 502"));

      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [
            { costName: "gpt-4o-input-token", costSource: "platform", quantity: 1000 },
          ],
        });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain("billing-service");
    });

    it("calls confirmProvision when PATCH changes provisioned → actual", async () => {
      const { confirmProvision } = await import("../../src/services/billing.js");
      const mockedConfirm = vi.mocked(confirmProvision);
      mockedConfirm.mockClear();

      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "gpt-4o-input-token",
        costSource: "platform",
        quantity: "1000",
        unitCostInUsdCents: "0.0003000000",
        totalCostInUsdCents: "0.3000000000",
        status: "provisioned",
        billingProvisionId: "prov_xyz",
      });

      const res = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "actual" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("actual");
      expect(mockedConfirm).toHaveBeenCalledTimes(1);
      expect(mockedConfirm).toHaveBeenCalledWith(
        "prov_xyz",
        expect.any(Number),
        expect.objectContaining({ orgId: TEST_ORG_ID }),
      );
    });

    it("calls cancelProvision when PATCH changes provisioned → cancelled", async () => {
      const { cancelProvision } = await import("../../src/services/billing.js");
      const mockedCancel = vi.mocked(cancelProvision);
      mockedCancel.mockClear();

      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "gpt-4o-input-token",
        costSource: "platform",
        quantity: "1000",
        unitCostInUsdCents: "0.0003000000",
        totalCostInUsdCents: "0.3000000000",
        status: "provisioned",
        billingProvisionId: "prov_xyz",
      });

      const res = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "cancelled" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("cancelled");
      expect(mockedCancel).toHaveBeenCalledTimes(1);
      expect(mockedCancel).toHaveBeenCalledWith(
        "prov_xyz",
        expect.objectContaining({ orgId: TEST_ORG_ID }),
      );
    });

    it("does NOT call billing when PATCH updates a non-platform cost", async () => {
      const { confirmProvision, cancelProvision } = await import("../../src/services/billing.js");
      vi.mocked(confirmProvision).mockClear();
      vi.mocked(cancelProvision).mockClear();

      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "gpt-4o-input-token",
        costSource: "org",
        quantity: "1000",
        unitCostInUsdCents: "0.0003000000",
        totalCostInUsdCents: "0.3000000000",
        status: "provisioned",
      });

      const res = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "actual" });

      expect(res.status).toBe(200);
      expect(vi.mocked(confirmProvision)).not.toHaveBeenCalled();
      expect(vi.mocked(cancelProvision)).not.toHaveBeenCalled();
    });
  });
});
