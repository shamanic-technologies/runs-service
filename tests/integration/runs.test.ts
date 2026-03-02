import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestOrg,
  insertTestUser,
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
    it("creates a new run with get-or-create org", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          orgId: "org_1",
          appId: "my-app",
          serviceName: "chat-service",
          taskName: "agent-run",
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("running");
      expect(res.body.serviceName).toBe("chat-service");
      expect(res.body.taskName).toBe("agent-run");
      expect(res.body.appId).toBe("my-app");
      expect(res.body.organizationId).toBeDefined();
    });

    it("resolves existing org when orgId is the internal UUID", async () => {
      const org = await insertTestOrg("org_clerk_format");

      // Create a run using the internal UUID instead of external_id
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          orgId: org.id, // internal UUID, not "org_clerk_format"
          appId: "my-app",
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      // Should resolve to the same org, not create a new one
      expect(res.body.organizationId).toBe(org.id);
    });

    it("reuses existing org on duplicate orgId", async () => {
      const res1 = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          orgId: "org_dup",
          appId: "my-app",
          serviceName: "svc-a",
          taskName: "task-a",
        });

      const res2 = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          orgId: "org_dup",
          appId: "my-app",
          serviceName: "svc-b",
          taskName: "task-b",
        });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.organizationId).toBe(res2.body.organizationId);
    });

    it("creates run with userId get-or-create", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          orgId: "org_user",
          userId: "user_1",
          appId: "my-app",
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.userId).toBeDefined();
    });

    it("creates a child run", async () => {
      const org = await insertTestOrg("org-child");
      const parent = await insertTestRun({
        organizationId: org.id,
        serviceName: "parent-svc",
        taskName: "parent-task",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          orgId: "org-child",
          appId: "my-app",
          serviceName: "child-svc",
          taskName: "child-task",
          parentRunId: parent.id,
        });

      expect(res.status).toBe(201);
      expect(res.body.parentRunId).toBe(parent.id);
    });

    it("returns 400 when parentRunId does not exist", async () => {
      const fakeParentId = "00000000-0000-0000-0000-000000000000";

      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          orgId: "org_orphan",
          appId: "my-app",
          serviceName: "orphan-svc",
          taskName: "orphan-task",
          parentRunId: fakeParentId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain(fakeParentId);
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
          orgId: "org_context",
          appId: "my-app",
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
          orgId: "org_wf",
          appId: "my-app",
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
          orgId: "org_wf_null",
          appId: "my-app",
          serviceName: "svc",
          taskName: "task",
        });

      expect(res.status).toBe(201);
      expect(res.body.workflowName).toBeNull();
    });

    it("inherits workflowName, brandId, campaignId from parent", async () => {
      const org = await insertTestOrg("org-inherit");
      const parent = await insertTestRun({
        organizationId: org.id,
        serviceName: "parent-svc",
        taskName: "parent-task",
        brandId: "inherited-brand",
        campaignId: "inherited-campaign",
        workflowName: "inherited-workflow",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          orgId: "org-inherit",
          appId: "my-app",
          serviceName: "child-svc",
          taskName: "child-task",
          parentRunId: parent.id,
        });

      expect(res.status).toBe(201);
      expect(res.body.brandId).toBe("inherited-brand");
      expect(res.body.campaignId).toBe("inherited-campaign");
      expect(res.body.workflowName).toBe("inherited-workflow");
    });

    it("child values take precedence over parent", async () => {
      const org = await insertTestOrg("org-override");
      const parent = await insertTestRun({
        organizationId: org.id,
        serviceName: "parent-svc",
        taskName: "parent-task",
        brandId: "parent-brand",
        campaignId: "parent-campaign",
        workflowName: "parent-workflow",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          orgId: "org-override",
          appId: "my-app",
          serviceName: "child-svc",
          taskName: "child-task",
          parentRunId: parent.id,
          brandId: "child-brand",
          campaignId: "child-campaign",
          workflowName: "child-workflow",
        });

      expect(res.status).toBe(201);
      expect(res.body.brandId).toBe("child-brand");
      expect(res.body.campaignId).toBe("child-campaign");
      expect(res.body.workflowName).toBe("child-workflow");
    });

    it("no inheritance when parent has null values", async () => {
      const org = await insertTestOrg("org-inherit-null");
      const parent = await insertTestRun({
        organizationId: org.id,
        serviceName: "parent-svc",
        taskName: "parent-task",
      });

      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          orgId: "org-inherit-null",
          appId: "my-app",
          serviceName: "child-svc",
          taskName: "child-task",
          parentRunId: parent.id,
        });

      expect(res.status).toBe(201);
      expect(res.body.brandId).toBeNull();
      expect(res.body.campaignId).toBeNull();
      expect(res.body.workflowName).toBeNull();
    });
  });

  describe("POST /v1/runs/:id/costs", () => {
    it("adds cost line items to a run", async () => {
      const org = await insertTestOrg("org-costs");
      const run = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [
            { costName: "gpt-4o-input-token", costBearer: "platform", quantity: 1000 },
            { costName: "gpt-4o-output-token", costBearer: "org", quantity: 200 },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.costs).toHaveLength(2);
      expect(res.body.costs[0].costBearer).toBe("platform");
      expect(res.body.costs[1].costBearer).toBe("org");
    });

    it("returns 400 when costBearer is missing", async () => {
      const org = await insertTestOrg("org-no-bearer");
      const run = await insertTestRun({
        organizationId: org.id,
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

    it("returns 400 when costBearer has invalid value", async () => {
      const org = await insertTestOrg("org-bad-bearer");
      const run = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [{ costName: "gpt-4o-input-token", costBearer: "invalid", quantity: 1000 }],
        });

      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown run", async () => {
      const res = await request(app)
        .post("/v1/runs/00000000-0000-0000-0000-000000000000/costs")
        .set(authHeaders)
        .send({ items: [{ costName: "test", costBearer: "platform", quantity: 1 }] });

      expect(res.status).toBe(404);
    });

    it("returns 502 when costs-service is unavailable", async () => {
      const { resolveMultipleUnitCosts } = await import("../../src/services/cost-resolver.js");
      const { UpstreamError } = await import("../../src/services/cost-resolver.js");
      const mockedResolve = vi.mocked(resolveMultipleUnitCosts);

      const org = await insertTestOrg("org-upstream");
      const run = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
      });

      mockedResolve.mockRejectedValueOnce(new UpstreamError(502, "costs-service returned 502"));

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({ items: [{ costName: "gpt-4o-input-token", costBearer: "platform", quantity: 1000 }] });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain("costs-service");
    });
  });

  describe("PATCH /v1/runs/:id", () => {
    it("completes a run", async () => {
      const org = await insertTestOrg("org-patch");
      const run = await insertTestRun({
        organizationId: org.id,
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
      const org = await insertTestOrg("org-patch-bad");
      const run = await insertTestRun({
        organizationId: org.id,
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
      const org = await insertTestOrg("org-get");
      const parent = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "parent",
      });
      const child = await insertTestRun({
        organizationId: org.id,
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
      const org = await insertTestOrg("org-descendants");
      const parent = await insertTestRun({
        organizationId: org.id,
        serviceName: "lead-service",
        taskName: "enrich-lead",
      });
      const child = await insertTestRun({
        organizationId: org.id,
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
      const org = await insertTestOrg("org-grandchild");
      const parent = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc-a",
        taskName: "task-a",
      });
      const child = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc-b",
        taskName: "task-b",
        parentRunId: parent.id,
      });
      const grandchild = await insertTestRun({
        organizationId: org.id,
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
      const org = await insertTestOrg("org-no-children");
      const run = await insertTestRun({
        organizationId: org.id,
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
      const org = await insertTestOrg("org-prov");
      const run = await insertTestRun({
        organizationId: org.id,
        serviceName: "email-svc",
        taskName: "send-sequence",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [
            { costName: "gpt-4o-input-token", costBearer: "platform", quantity: 1000, status: "provisioned" },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.costs[0].status).toBe("provisioned");
    });

    it("defaults status to actual when omitted", async () => {
      const org = await insertTestOrg("org-prov-default");
      const run = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({
          items: [{ costName: "gpt-4o-input-token", costBearer: "platform", quantity: 1000 }],
        });

      expect(res.status).toBe(201);
      expect(res.body.costs[0].status).toBe("actual");
    });
  });

  describe("PATCH /v1/runs/:id/costs/:costId", () => {
    it("realizes a provisioned cost", async () => {
      const org = await insertTestOrg("org-realize");
      const run = await insertTestRun({
        organizationId: org.id,
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
      const org = await insertTestOrg("org-cancel");
      const run = await insertTestRun({
        organizationId: org.id,
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
      const org = await insertTestOrg("org-cancel-totals");
      const run = await insertTestRun({
        organizationId: org.id,
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
      const org = await insertTestOrg("org-realize-404");
      const run = await insertTestRun({
        organizationId: org.id,
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
      const org = await insertTestOrg("org-realize-wrong");
      const run1 = await insertTestRun({ organizationId: org.id, serviceName: "svc", taskName: "t1" });
      const run2 = await insertTestRun({ organizationId: org.id, serviceName: "svc", taskName: "t2" });
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
      const org = await insertTestOrg("org-realize-bad");
      const run = await insertTestRun({ organizationId: org.id, serviceName: "svc", taskName: "task" });

      const res = await request(app)
        .patch(`/v1/runs/${run.id}/costs/00000000-0000-0000-0000-000000000000`)
        .set(authHeaders)
        .send({ status: "maybe" });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /v1/runs/:id (cost status breakdown)", () => {
    it("returns actual vs provisioned cost breakdown", async () => {
      const org = await insertTestOrg("org-breakdown");
      const run = await insertTestRun({
        organizationId: org.id,
        serviceName: "email-svc",
        taskName: "send-sequence",
      });

      // Actual cost (email 1 sent)
      await insertTestRunCost({
        runId: run.id,
        costName: "email-send",
        quantity: "1",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "0.5000000000",
        status: "actual",
      });

      // Provisioned costs (emails 2 and 3 scheduled)
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
      const org = await insertTestOrg("org-desc-prov");
      const parent = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "parent",
      });
      const child = await insertTestRun({
        organizationId: org.id,
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
    it("lists runs filtered by orgId", async () => {
      const org = await insertTestOrg("org-list");
      await insertTestRun({
        organizationId: org.id,
        serviceName: "svc-a",
        taskName: "task-1",
      });
      await insertTestRun({
        organizationId: org.id,
        serviceName: "svc-b",
        taskName: "task-2",
      });

      const res = await request(app)
        .get("/v1/runs?orgId=org-list")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(2);
    });

    it("requires orgId", async () => {
      const res = await request(app)
        .get("/v1/runs")
        .set(authHeaders);
      expect(res.status).toBe(400);
    });

    it("lists runs when orgId is the internal UUID", async () => {
      const org = await insertTestOrg("org-list-by-uuid");
      await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
      });

      // Query using internal UUID
      const res = await request(app)
        .get(`/v1/runs?orgId=${org.id}`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
    });

    it("returns empty list for unknown orgId", async () => {
      const res = await request(app)
        .get("/v1/runs?orgId=nonexistent")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toEqual([]);
    });

    it("includes ownCostInUsdCents per run", async () => {
      const org = await insertTestOrg("org-list-cost");
      const run = await insertTestRun({
        organizationId: org.id,
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
        .get("/v1/runs?orgId=org-list-cost")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0].ownCostInUsdCents).toBe("0.3000000000");
    });

    it("filters by parentRunId", async () => {
      const org = await insertTestOrg("org-parent-filter");
      const parent = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "parent",
      });
      await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "child-1",
        parentRunId: parent.id,
      });
      await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "child-2",
        parentRunId: parent.id,
      });
      await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "unrelated",
      });

      const res = await request(app)
        .get(`/v1/runs?orgId=org-parent-filter&parentRunId=${parent.id}`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(2);
      expect(res.body.runs.every((r: any) => r.parentRunId === parent.id)).toBe(true);
    });

    it("includes own actual and provisioned cost per run", async () => {
      const org = await insertTestOrg("org-list-prov");
      const run = await insertTestRun({
        organizationId: org.id,
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
        .get("/v1/runs?orgId=org-list-prov")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs[0].ownCostInUsdCents).toBe("0.3000000000");
      expect(res.body.runs[0].ownActualCostInUsdCents).toBe("0.1000000000");
      expect(res.body.runs[0].ownProvisionedCostInUsdCents).toBe("0.2000000000");
    });

    it("filters by workflowName", async () => {
      const org = await insertTestOrg("org-wf-filter");
      await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
        workflowName: "sales-cold-email-v1",
      });
      await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
        workflowName: "journalist-outreach-v2",
      });

      const res = await request(app)
        .get("/v1/runs?orgId=org-wf-filter&workflowName=sales-cold-email-v1")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0].workflowName).toBe("sales-cold-email-v1");
    });

    it("filters by appId", async () => {
      const org = await insertTestOrg("org-app-filter");
      await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
        appId: "app-a",
      });
      await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
        appId: "app-b",
      });

      const res = await request(app)
        .get("/v1/runs?orgId=org-app-filter&appId=app-a")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0].appId).toBe("app-a");
    });
  });
});
