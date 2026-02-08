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
          clerkOrgId: "org_clerk_1",
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

    it("reuses existing org on duplicate clerkOrgId", async () => {
      const res1 = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          clerkOrgId: "org_clerk_dup",
          appId: "my-app",
          serviceName: "svc-a",
          taskName: "task-a",
        });

      const res2 = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          clerkOrgId: "org_clerk_dup",
          appId: "my-app",
          serviceName: "svc-b",
          taskName: "task-b",
        });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.organizationId).toBe(res2.body.organizationId);
    });

    it("creates run with clerkUserId get-or-create", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          clerkOrgId: "org_clerk_user",
          clerkUserId: "user_clerk_1",
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
          clerkOrgId: "org-child",
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
          clerkOrgId: "org_orphan",
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
          clerkOrgId: "org_context",
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
            { costName: "gpt-4o-input-token", quantity: 1000 },
            { costName: "gpt-4o-output-token", quantity: 200 },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.costs).toHaveLength(2);
    });

    it("returns 404 for unknown run", async () => {
      const res = await request(app)
        .post("/v1/runs/00000000-0000-0000-0000-000000000000/costs")
        .set(authHeaders)
        .send({ items: [{ costName: "test", quantity: 1 }] });

      expect(res.status).toBe(404);
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

  describe("GET /v1/runs", () => {
    it("lists runs filtered by clerkOrgId", async () => {
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
        .get("/v1/runs?clerkOrgId=org-list")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(2);
    });

    it("requires clerkOrgId", async () => {
      const res = await request(app)
        .get("/v1/runs")
        .set(authHeaders);
      expect(res.status).toBe(400);
    });

    it("returns empty list for unknown clerkOrgId", async () => {
      const res = await request(app)
        .get("/v1/runs?clerkOrgId=nonexistent")
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
        .get("/v1/runs?clerkOrgId=org-list-cost")
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
        .get(`/v1/runs?clerkOrgId=org-parent-filter&parentRunId=${parent.id}`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(2);
      expect(res.body.runs.every((r: any) => r.parentRunId === parent.id)).toBe(true);
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
        .get("/v1/runs?clerkOrgId=org-app-filter&appId=app-a")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0].appId).toBe("app-a");
    });
  });
});
