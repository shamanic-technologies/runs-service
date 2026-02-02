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

  describe("POST /v1/organizations", () => {
    it("creates a new organization", async () => {
      const res = await request(app)
        .post("/v1/organizations")
        .set(authHeaders)
        .send({ externalId: "ext-org-1" });

      expect(res.status).toBe(201);
      expect(res.body.externalId).toBe("ext-org-1");
      expect(res.body.id).toBeDefined();
    });

    it("returns existing org on duplicate externalId", async () => {
      const org = await insertTestOrg("ext-org-dup");

      const res = await request(app)
        .post("/v1/organizations")
        .set(authHeaders)
        .send({ externalId: "ext-org-dup" });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(org.id);
    });

    it("rejects without API key", async () => {
      const res = await request(app)
        .post("/v1/organizations")
        .send({ externalId: "test" });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /v1/users", () => {
    it("creates a new user", async () => {
      const org = await insertTestOrg("org-for-user");

      const res = await request(app)
        .post("/v1/users")
        .set(authHeaders)
        .send({ externalId: "ext-user-1", organizationId: org.id });

      expect(res.status).toBe(201);
      expect(res.body.externalId).toBe("ext-user-1");
      expect(res.body.organizationId).toBe(org.id);
    });

    it("returns 404 for unknown org", async () => {
      const res = await request(app)
        .post("/v1/users")
        .set(authHeaders)
        .send({
          externalId: "ext-user-2",
          organizationId: "00000000-0000-0000-0000-000000000000",
        });

      expect(res.status).toBe(404);
    });
  });

  describe("POST /v1/runs", () => {
    it("creates a new run", async () => {
      const org = await insertTestOrg("org-run");

      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({
          organizationId: org.id,
          serviceName: "chat-service",
          taskName: "agent-run",
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("running");
      expect(res.body.serviceName).toBe("chat-service");
      expect(res.body.taskName).toBe("agent-run");
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
          organizationId: org.id,
          serviceName: "child-svc",
          taskName: "child-task",
          parentRunId: parent.id,
        });

      expect(res.status).toBe(201);
      expect(res.body.parentRunId).toBe(parent.id);
    });

    it("rejects without required fields", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({});
      expect(res.status).toBe(400);
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

      // Add costs to parent
      await insertTestRunCost({
        runId: parent.id,
        costName: "input-token",
        quantity: "1000",
        unitCostInUsdCents: "0.0003000000",
        totalCostInUsdCents: "0.3000000000",
      });

      // Add costs to child
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
  });

  describe("GET /v1/runs", () => {
    it("lists runs filtered by org", async () => {
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
        .get(`/v1/runs?organizationId=${org.id}`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(2);
    });

    it("requires organizationId", async () => {
      const res = await request(app)
        .get("/v1/runs")
        .set(authHeaders);
      expect(res.status).toBe(400);
    });
  });
});
