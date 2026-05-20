import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders, TEST_USER_ID, TEST_BRAND_A, TEST_BRAND_B, TEST_BRAND_C } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestRun,
  insertTestRunCost,
  closeDb,
} from "../helpers/test-db.js";

// File-local org id keeps this file isolated from other integration files running in parallel.
const ORG_ID = "aaaaaaaa-1111-4111-aaaa-111111111111";
// A second org used by parent/child cross-org isolation tests; must be cleaned too.
const OTHER_ORG_ID = "99999999-9999-9999-9999-999999999999";
const CLEANUP_ORG_IDS = [ORG_ID, OTHER_ORG_ID];

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

// Mock billing client — notifyUsage is fire-and-forget and never throws.
vi.mock("../../src/services/billing.js", () => ({
  notifyUsage: vi.fn().mockResolvedValue(undefined),
}));

describe("Runs CRUD", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders({ orgId: ORG_ID });

  beforeEach(async () => {
    await cleanTestData(CLEANUP_ORG_IDS);
  });

  afterAll(async () => {
    await cleanTestData(CLEANUP_ORG_IDS);
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
      expect(res.body.organizationId).toBe(ORG_ID);
      expect(res.body.userId).toBe(TEST_USER_ID);
    });

    it("creates run without x-user-id (optional)", async () => {
      const headers = {
        "X-API-Key": "test-api-key",
        "Content-Type": "application/json",
        "x-org-id": ORG_ID,
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
        organizationId: ORG_ID,
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

    it("stores optional brandIds and campaignId", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          brandIds: [TEST_BRAND_A],
          campaignId: "campaign_1",
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandIds).toEqual([TEST_BRAND_A]);
      expect(res.body.campaignId).toBe("campaign_1");
    });

    it("stores workflowSlug when provided", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          workflowSlug: "sales-cold-email-v1",
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.workflowSlug).toBe("sales-cold-email-v1");
    });

    it("workflowSlug defaults to null", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.workflowSlug).toBeNull();
    });

    it("inherits workflowSlug, brandIds, campaignId from parent", async () => {
      const parent = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "parent-svc",
        taskName: "parent-task",
        brandIds: [TEST_BRAND_A],
        campaignId: "inherited-campaign",
        workflowSlug: "inherited-workflow",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set({ ...authHeaders, "x-run-id": parent.id })
        .send({
          serviceName: "child-svc",
          taskName: "child-task",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandIds).toEqual([TEST_BRAND_A]);
      expect(res.body.campaignId).toBe("inherited-campaign");
      expect(res.body.workflowSlug).toBe("inherited-workflow");
    });

    it("returns 409 when body values conflict with parent", async () => {
      const parent = await insertTestRun({
        organizationId: ORG_ID,
        userId: TEST_USER_ID,
        serviceName: "parent-svc",
        taskName: "parent-task",
        brandIds: [TEST_BRAND_A],
        campaignId: "parent-campaign",
        workflowSlug: "parent-workflow",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set({ ...authHeaders, "x-run-id": parent.id })
        .send({
          serviceName: "child-svc",
          taskName: "child-task",
          brandIds: [TEST_BRAND_B],
          campaignId: "child-campaign",
          workflowSlug: "child-workflow",
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Parent-child field conflict");
      expect(res.body.conflicts).toHaveLength(3);
    });

    it("returns 409 when header values conflict with parent", async () => {
      const parent = await insertTestRun({
        organizationId: ORG_ID,
        userId: TEST_USER_ID,
        serviceName: "parent-svc",
        taskName: "parent-task",
        workflowSlug: "parent-workflow",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-run-id": parent.id,
          "x-workflow-slug": "different-workflow",
        })
        .send({
          serviceName: "child-svc",
          taskName: "child-task",
        });

      expect(res.status).toBe(409);
      expect(res.body.conflicts).toEqual(
        expect.arrayContaining([expect.stringContaining("workflowSlug")])
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
        organizationId: ORG_ID,
        userId: TEST_USER_ID,
        serviceName: "parent-svc",
        taskName: "parent-task",
        brandIds: [TEST_BRAND_A],
        campaignId: "same-campaign",
        workflowSlug: "same-workflow",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-run-id": parent.id,
          "x-brand-id": TEST_BRAND_A,
          "x-campaign-id": "same-campaign",
          "x-workflow-slug": "same-workflow",
        })
        .send({
          serviceName: "child-svc",
          taskName: "child-task",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandIds).toEqual([TEST_BRAND_A]);
    });

    it("uses x-brand-id, x-campaign-id, x-workflow-slug headers as fallback", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-brand-id": TEST_BRAND_A,
          "x-campaign-id": "header-campaign",
          "x-workflow-slug": "header-workflow",
        })
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandIds).toEqual([TEST_BRAND_A]);
      expect(res.body.campaignId).toBe("header-campaign");
      expect(res.body.workflowSlug).toBe("header-workflow");
    });

    it("header values take precedence over body values", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-brand-id": TEST_BRAND_A,
          "x-campaign-id": "header-campaign",
          "x-workflow-slug": "header-workflow",
        })
        .send({
          serviceName: "svc",
          taskName: "task",
          brandIds: [TEST_BRAND_B],
          campaignId: "body-campaign",
          workflowSlug: "body-workflow",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandIds).toEqual([TEST_BRAND_A]);
      expect(res.body.campaignId).toBe("header-campaign");
      expect(res.body.workflowSlug).toBe("header-workflow");
    });

    it("body values fill in gaps when header has partial values", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-brand-id": TEST_BRAND_A,
        })
        .send({
          serviceName: "svc",
          taskName: "task",
          brandIds: [TEST_BRAND_B],
          campaignId: "body-campaign",
          workflowSlug: "body-workflow",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandIds).toEqual([TEST_BRAND_A]);
      expect(res.body.campaignId).toBe("body-campaign");
      expect(res.body.workflowSlug).toBe("body-workflow");
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
      expect(res.body.brandIds).toBeNull();
      expect(res.body.campaignId).toBeNull();
      expect(res.body.workflowSlug).toBeNull();
    });

    it("no inheritance when parent has null values", async () => {
      const parent = await insertTestRun({
        organizationId: ORG_ID,
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
      expect(res.body.brandIds).toBeNull();
      expect(res.body.campaignId).toBeNull();
      expect(res.body.workflowSlug).toBeNull();
    });

    it("parses multi-brand CSV from x-brand-id header", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-brand-id": `${TEST_BRAND_A},${TEST_BRAND_B},${TEST_BRAND_C}`,
        })
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandIds).toEqual([TEST_BRAND_A, TEST_BRAND_B, TEST_BRAND_C]);
    });

    it("trims whitespace in multi-brand CSV header", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-brand-id": ` ${TEST_BRAND_A} , ${TEST_BRAND_B} `,
        })
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandIds).toEqual([TEST_BRAND_A, TEST_BRAND_B]);
    });

    it("single brand in x-brand-id header stores as single-element array", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-brand-id": TEST_BRAND_A,
        })
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandIds).toEqual([TEST_BRAND_A]);
    });

    it("rejects non-UUID brand IDs in x-brand-id header", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set({
          ...authHeaders,
          "x-brand-id": "lifecycle",
        })
        .send({
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("invalid UUIDs");
    });

    it("rejects non-UUID brand IDs in body brandIds", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          serviceName: "svc",
          taskName: "task",
          brandIds: ["not-a-uuid"],
        });

      expect(res.status).toBe(400);
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
          "x-org-id": ORG_ID,
        })
        .send({
          items: [{ costName: "gpt-4o-input-token", costSource: "platform", quantity: 1000 }],
        });

      expect(res.status).toBe(201);

      // Verify cost-resolver received identity from the run record
      expect(mockedResolve).toHaveBeenCalledWith(
        ["gpt-4o-input-token"],
        expect.objectContaining({
          orgId: ORG_ID,
          userId: TEST_USER_ID,
          runId: run.id,
        })
      );
    });
  });

  describe("PATCH /v1/runs/:id", () => {
    it("completes a run", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "parent",
      });
      const child = await insertTestRun({
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
        serviceName: "lead-service",
        taskName: "enrich-lead",
      });
      const child = await insertTestRun({
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
        serviceName: "svc-a",
        taskName: "task-a",
      });
      const child = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc-b",
        taskName: "task-b",
        parentRunId: parent.id,
      });
      const grandchild = await insertTestRun({
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
      const run1 = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t1" });
      const run2 = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t2" });
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
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task" });

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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "parent",
      });
      const child = await insertTestRun({
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
        serviceName: "svc-a",
        taskName: "task-1",
      });
      await insertTestRun({
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "parent",
      });
      await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "child-1",
        parentRunId: parent.id,
      });
      await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "child-2",
        parentRunId: parent.id,
      });
      await insertTestRun({
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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

    it("filters by workflowSlug", async () => {
      await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "sales-cold-email-v1",
      });
      await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "journalist-outreach-v2",
      });

      const res = await request(app)
        .get("/v1/runs?workflowSlug=sales-cold-email-v1")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0].workflowSlug).toBe("sales-cold-email-v1");
    });

    it("returns all runs when no limit is specified (no silent truncation)", async () => {
      // Regression: previously defaulted to limit=50 and capped at max=200,
      // silently truncating results without the caller knowing.
      for (let i = 0; i < 5; i++) {
        await insertTestRun({
          organizationId: ORG_ID,
          serviceName: "svc",
          taskName: `no-limit-${i}`,
        });
      }

      const res = await request(app)
        .get("/v1/runs")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs.length).toBeGreaterThanOrEqual(5);
      expect(res.body.limit).toBeUndefined();
    }, 15000);

    it("respects explicit limit without hidden cap", async () => {
      for (let i = 0; i < 5; i++) {
        await insertTestRun({
          organizationId: ORG_ID,
          serviceName: "svc",
          taskName: `task-${i}`,
        });
      }

      const res = await request(app)
        .get("/v1/runs?limit=3")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(3);
      expect(res.body.limit).toBe(3);
    });
  });

  describe("Usage notification (notifyUsage)", () => {
    it("fires notifyUsage after POST with platform actual costs — spent_total_cents reflects org SUM", async () => {
      const { notifyUsage } = await import("../../src/services/billing.js");
      const mockedNotify = vi.mocked(notifyUsage);
      mockedNotify.mockClear();

      const run = await insertTestRun({
        organizationId: ORG_ID,
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
      expect(mockedNotify).toHaveBeenCalledTimes(1);

      // 1000 * 0.0003 + 200 * 0.0012 = 0.3 + 0.24 = 0.54
      const [ctx, payload] = mockedNotify.mock.calls[0];
      expect(ctx.orgId).toBe(ORG_ID);
      expect(ctx.runId).toBe(run.id);
      expect(payload.spentTotalCents).toBe("0.5400000000");
    });

    it("excludes BYOK (cost_source='org') rows from spent_total_cents", async () => {
      const { notifyUsage } = await import("../../src/services/billing.js");
      const mockedNotify = vi.mocked(notifyUsage);
      mockedNotify.mockClear();

      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [
            { costName: "gpt-4o-input-token", costSource: "platform", quantity: 1000 },
            { costName: "gpt-4o-output-token", costSource: "org", quantity: 500 },
          ],
        });

      expect(res.status).toBe(201);
      expect(mockedNotify).toHaveBeenCalledTimes(1);

      // Platform-only sum: 1000 * 0.0003 = 0.3 (org row excluded)
      const [, payload] = mockedNotify.mock.calls[0];
      expect(payload.spentTotalCents).toBe("0.3000000000");
    });

    it("includes provisioned rows in spent_total_cents", async () => {
      const { notifyUsage } = await import("../../src/services/billing.js");
      const mockedNotify = vi.mocked(notifyUsage);
      mockedNotify.mockClear();

      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [
            {
              costName: "gpt-4o-input-token",
              costSource: "platform",
              quantity: 1000,
              status: "provisioned",
            },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.costs[0].status).toBe("provisioned");

      const [, payload] = mockedNotify.mock.calls[0];
      expect(payload.spentTotalCents).toBe("0.3000000000");
    });

    it("PATCH provisioned → actual fires notifyUsage with current SUM", async () => {
      const { notifyUsage } = await import("../../src/services/billing.js");
      const mockedNotify = vi.mocked(notifyUsage);

      const run = await insertTestRun({
        organizationId: ORG_ID,
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
      });

      mockedNotify.mockClear();

      const res = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "actual" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("actual");
      expect(mockedNotify).toHaveBeenCalledTimes(1);

      const [, payload] = mockedNotify.mock.calls[0];
      expect(payload.spentTotalCents).toBe("0.3000000000");
    });

    it("PATCH provisioned → cancelled fires notifyUsage; cancelled row excluded from SUM", async () => {
      const { notifyUsage } = await import("../../src/services/billing.js");
      const mockedNotify = vi.mocked(notifyUsage);

      const run = await insertTestRun({
        organizationId: ORG_ID,
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
      });

      mockedNotify.mockClear();

      const res = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "cancelled" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("cancelled");
      expect(mockedNotify).toHaveBeenCalledTimes(1);

      const [, payload] = mockedNotify.mock.calls[0];
      expect(payload.spentTotalCents).toBe("0.0000000000");
    });

    it("POST succeeds even when no userId available (notifyUsage skipped)", async () => {
      const { notifyUsage } = await import("../../src/services/billing.js");
      const mockedNotify = vi.mocked(notifyUsage);
      mockedNotify.mockClear();

      // Run with no userId; request without x-user-id header
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const headersWithoutUser = { ...authHeaders };
      delete (headersWithoutUser as Record<string, string>)["x-user-id"];

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(headersWithoutUser)
        .send({
          items: [
            { costName: "gpt-4o-input-token", costSource: "platform", quantity: 100 },
          ],
        });

      expect(res.status).toBe(201);
      expect(mockedNotify).not.toHaveBeenCalled();
    });

  });

  describe("idempotencyKey on /v1/runs", () => {
    it("returns 200 with the existing run on replay with same idempotencyKey", async () => {
      const key = "idem-run-1";
      const first = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          serviceName: "test-service",
          taskName: "idem-replay",
          idempotencyKey: key,
        });

      expect(first.status).toBe(201);
      const originalId = first.body.id;

      const second = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          serviceName: "test-service",
          taskName: "idem-replay",
          idempotencyKey: key,
        });

      expect(second.status).toBe(200);
      expect(second.body.id).toBe(originalId);
    });

    it("returns 409 on idempotencyKey reuse with different (serviceName, taskName)", async () => {
      const key = "idem-run-2";
      await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          serviceName: "test-service",
          taskName: "first-task",
          idempotencyKey: key,
        });

      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          serviceName: "test-service",
          taskName: "different-task",
          idempotencyKey: key,
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/idempotencyKey/);
    });

    it("rejects idempotencyKey longer than 256 chars with 400", async () => {
      const tooLong = "x".repeat(257);
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          serviceName: "test-service",
          taskName: "too-long-key",
          idempotencyKey: tooLong,
        });

      expect(res.status).toBe(400);
    });
  });

  describe("idempotencyKey on /v1/runs/:id/costs", () => {
    it("dedupes per-item idempotencyKey within a single run", async () => {
      const createRes = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({ serviceName: "test-service", taskName: "cost-idem" });
      const runId = createRes.body.id;

      const item = {
        costName: "gpt-4o-input-token",
        costSource: "platform" as const,
        quantity: 1000,
        idempotencyKey: "idem-cost-run-1",
      };

      const first = await request(app)
        .post(`/v1/runs/${runId}/costs`)
        .set(authHeaders)
        .send({ items: [item] });
      const second = await request(app)
        .post(`/v1/runs/${runId}/costs`)
        .set(authHeaders)
        .send({ items: [item] });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.costs).toHaveLength(1);
      expect(second.body.costs).toHaveLength(1);
      expect(second.body.costs[0].id).toBe(first.body.costs[0].id);
    });

    it("allows the same idempotencyKey across different runs", async () => {
      const r1 = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({ serviceName: "test-service", taskName: "cost-cross-1" });
      const r2 = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({ serviceName: "test-service", taskName: "cost-cross-2" });

      const item = {
        costName: "gpt-4o-input-token",
        costSource: "platform" as const,
        quantity: 1000,
        idempotencyKey: "idem-cost-run-shared",
      };

      const c1 = await request(app)
        .post(`/v1/runs/${r1.body.id}/costs`)
        .set(authHeaders)
        .send({ items: [item] });
      const c2 = await request(app)
        .post(`/v1/runs/${r2.body.id}/costs`)
        .set(authHeaders)
        .send({ items: [item] });

      expect(c1.status).toBe(201);
      expect(c2.status).toBe(201);
      expect(c1.body.costs[0].id).not.toBe(c2.body.costs[0].id);
    });
  });
});
