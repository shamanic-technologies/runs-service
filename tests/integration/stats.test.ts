import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestOrg,
  insertTestRun,
  insertTestRunCost,
  closeDb,
} from "../helpers/test-db.js";

describe("Stats endpoints", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("GET /v1/stats/costs", () => {
    it("groups costs by brandId", async () => {
      const org = await insertTestOrg("org-stats-brand");
      const run1 = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
        brandId: "brand-a",
      });
      const run2 = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
        brandId: "brand-b",
      });

      await insertTestRunCost({
        runId: run1.id,
        costName: "token",
        quantity: "1000",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "1.0000000000",
      });
      await insertTestRunCost({
        runId: run2.id,
        costName: "token",
        quantity: "500",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.5000000000",
      });

      const res = await request(app)
        .get("/v1/stats/costs?clerkOrgId=org-stats-brand&appId=test-app&groupBy=brandId")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);

      const brandA = res.body.groups.find((g: any) => g.dimensions.brandId === "brand-a");
      const brandB = res.body.groups.find((g: any) => g.dimensions.brandId === "brand-b");
      expect(brandA.totalCostInUsdCents).toBe("1.0000000000");
      expect(brandA.runCount).toBe(1);
      expect(brandB.totalCostInUsdCents).toBe("0.5000000000");
      expect(brandB.runCount).toBe(1);
    });

    it("groups by multiple dimensions", async () => {
      const org = await insertTestOrg("org-stats-multi");
      const run1 = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc-a",
        taskName: "task",
        brandId: "brand-x",
      });

      await insertTestRunCost({
        runId: run1.id,
        costName: "token",
        quantity: "100",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.1000000000",
      });

      const res = await request(app)
        .get("/v1/stats/costs?clerkOrgId=org-stats-multi&appId=test-app&groupBy=brandId,serviceName")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.brandId).toBe("brand-x");
      expect(res.body.groups[0].dimensions.serviceName).toBe("svc-a");
    });

    it("applies filters", async () => {
      const org = await insertTestOrg("org-stats-filter");
      const run1 = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc-a",
        taskName: "task",
        brandId: "brand-f",
        workflowName: "wf-1",
      });
      const run2 = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc-b",
        taskName: "task",
        brandId: "brand-f",
        workflowName: "wf-2",
      });

      await insertTestRunCost({
        runId: run1.id,
        costName: "token",
        quantity: "100",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.1000000000",
      });
      await insertTestRunCost({
        runId: run2.id,
        costName: "token",
        quantity: "200",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.2000000000",
      });

      const res = await request(app)
        .get("/v1/stats/costs?clerkOrgId=org-stats-filter&appId=test-app&groupBy=brandId&workflowName=wf-1")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].totalCostInUsdCents).toBe("0.1000000000");
    });

    it("returns empty for unknown org", async () => {
      const res = await request(app)
        .get("/v1/stats/costs?clerkOrgId=nonexistent&appId=test-app&groupBy=brandId")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toEqual([]);
    });

    it("rejects missing appId", async () => {
      const res = await request(app)
        .get("/v1/stats/costs?clerkOrgId=org1&groupBy=brandId")
        .set(authHeaders);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("appId");
    });

    it("rejects invalid groupBy", async () => {
      const res = await request(app)
        .get("/v1/stats/costs?clerkOrgId=org1&appId=test-app&groupBy=invalidColumn")
        .set(authHeaders);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid groupBy");
    });

    it("separates actual, provisioned, cancelled costs", async () => {
      const org = await insertTestOrg("org-stats-status");
      const run = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
        brandId: "brand-s",
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
      await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "50",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.0500000000",
        status: "cancelled",
      });

      const res = await request(app)
        .get("/v1/stats/costs?clerkOrgId=org-stats-status&appId=test-app&groupBy=brandId")
        .set(authHeaders);

      expect(res.status).toBe(200);
      const group = res.body.groups[0];
      expect(group.actualCostInUsdCents).toBe("0.1000000000");
      expect(group.provisionedCostInUsdCents).toBe("0.2000000000");
      expect(group.cancelledCostInUsdCents).toBe("0.0500000000");
      expect(group.totalCostInUsdCents).toBe("0.3000000000"); // actual + provisioned, no cancelled
    });
  });

  describe("GET /v1/stats/costs/by-cost-name", () => {
    it("returns breakdown by cost name", async () => {
      const org = await insertTestOrg("org-by-name");
      const run = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
      });

      await insertTestRunCost({
        runId: run.id,
        costName: "gpt-4o-input-token",
        quantity: "1000",
        unitCostInUsdCents: "0.0003000000",
        totalCostInUsdCents: "0.3000000000",
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "email-send",
        quantity: "5",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "2.5000000000",
      });

      const res = await request(app)
        .get("/v1/stats/costs/by-cost-name?clerkOrgId=org-by-name&appId=test-app")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.costs).toHaveLength(2);

      // Ordered by total_cost DESC
      expect(res.body.costs[0].costName).toBe("email-send");
      expect(res.body.costs[0].totalCostInUsdCents).toBe("2.5000000000");
      expect(res.body.costs[0].totalQuantity).toBe("5.000000");
      expect(res.body.costs[1].costName).toBe("gpt-4o-input-token");
    });

    it("includes actual/provisioned/cancelled breakdown", async () => {
      const org = await insertTestOrg("org-by-name-status");
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
        quantity: "2",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "1.0000000000",
        status: "provisioned",
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
        .get("/v1/stats/costs/by-cost-name?clerkOrgId=org-by-name-status&appId=test-app")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.costs).toHaveLength(1);
      const cost = res.body.costs[0];
      expect(cost.costName).toBe("email-send");
      expect(cost.actualCostInUsdCents).toBe("0.5000000000");
      expect(cost.provisionedCostInUsdCents).toBe("1.0000000000");
      expect(cost.cancelledCostInUsdCents).toBe("0.5000000000");
      expect(cost.totalCostInUsdCents).toBe("1.5000000000"); // actual + provisioned
      expect(cost.totalQuantity).toBe("4.000000"); // all statuses included in quantity
    });

    it("returns empty for unknown org", async () => {
      const res = await request(app)
        .get("/v1/stats/costs/by-cost-name?clerkOrgId=nonexistent&appId=test-app")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.costs).toEqual([]);
    });

    it("rejects missing appId", async () => {
      const res = await request(app)
        .get("/v1/stats/costs/by-cost-name?clerkOrgId=org1")
        .set(authHeaders);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("appId");
    });
  });

  describe("POST /v1/stats/budget", () => {
    it("returns per-window budget totals", async () => {
      const org = await insertTestOrg("org-budget");
      const run = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
        campaignId: "campaign-1",
      });

      await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "1000",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "1.0000000000",
        status: "actual",
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "500",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.5000000000",
        status: "provisioned",
      });

      const res = await request(app)
        .post("/v1/stats/budget")
        .set(authHeaders)
        .send({
          clerkOrgId: "org-budget",
          appId: "test-app",
          campaignId: "campaign-1",
          windows: [
            { label: "all-time" },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.windows).toHaveLength(1);
      expect(res.body.windows[0].label).toBe("all-time");
      expect(res.body.windows[0].totalCostInUsdCents).toBe("1.5000000000");
      expect(res.body.windows[0].actualCostInUsdCents).toBe("1.0000000000");
      expect(res.body.windows[0].provisionedCostInUsdCents).toBe("0.5000000000");
    });

    it("returns zeros for unknown org", async () => {
      const res = await request(app)
        .post("/v1/stats/budget")
        .set(authHeaders)
        .send({
          clerkOrgId: "nonexistent",
          appId: "test-app",
          windows: [{ label: "all-time" }],
        });

      expect(res.status).toBe(200);
      expect(res.body.windows[0].totalCostInUsdCents).toBe("0.0000000000");
    });

    it("handles temporal window with since", async () => {
      const org = await insertTestOrg("org-budget-window");
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

      const farFuture = "2099-01-01T00:00:00.000Z";
      const res = await request(app)
        .post("/v1/stats/budget")
        .set(authHeaders)
        .send({
          clerkOrgId: "org-budget-window",
          appId: "test-app",
          windows: [
            { label: "all-time" },
            { label: "future-only", since: farFuture },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.windows).toHaveLength(2);
      expect(res.body.windows[0].label).toBe("all-time");
      expect(res.body.windows[0].totalCostInUsdCents).toBe("0.1000000000");
      expect(res.body.windows[1].label).toBe("future-only");
      expect(res.body.windows[1].totalCostInUsdCents).toBe("0.0000000000");
    });

    it("rejects missing appId", async () => {
      const res = await request(app)
        .post("/v1/stats/budget")
        .set(authHeaders)
        .send({
          clerkOrgId: "org1",
          windows: [{ label: "all-time" }],
        });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /v1/runs/:id/children-summary", () => {
    it("aggregates costs per child including grandchildren", async () => {
      const org = await insertTestOrg("org-children-summary");
      const parent = await insertTestRun({
        organizationId: org.id,
        serviceName: "campaign-svc",
        taskName: "run-campaign",
      });
      const child1 = await insertTestRun({
        organizationId: org.id,
        serviceName: "lead-svc",
        taskName: "process-lead",
        parentRunId: parent.id,
      });
      const grandchild = await insertTestRun({
        organizationId: org.id,
        serviceName: "email-svc",
        taskName: "send-email",
        parentRunId: child1.id,
      });
      const child2 = await insertTestRun({
        organizationId: org.id,
        serviceName: "lead-svc",
        taskName: "process-lead",
        parentRunId: parent.id,
      });

      // child1's own cost
      await insertTestRunCost({
        runId: child1.id,
        costName: "gpt-4o-input-token",
        quantity: "1000",
        unitCostInUsdCents: "0.0003000000",
        totalCostInUsdCents: "0.3000000000",
      });
      // grandchild's cost (should roll up to child1)
      await insertTestRunCost({
        runId: grandchild.id,
        costName: "email-send",
        quantity: "1",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "0.5000000000",
      });
      // child2's cost
      await insertTestRunCost({
        runId: child2.id,
        costName: "gpt-4o-input-token",
        quantity: "500",
        unitCostInUsdCents: "0.0003000000",
        totalCostInUsdCents: "0.1500000000",
      });

      const res = await request(app)
        .get(`/v1/runs/${parent.id}/children-summary`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.parentRunId).toBe(parent.id);
      expect(res.body.children).toHaveLength(2);

      const c1 = res.body.children.find((c: any) => c.id === child1.id);
      const c2 = res.body.children.find((c: any) => c.id === child2.id);

      // child1 total = own (0.3) + grandchild (0.5) = 0.8
      expect(c1.totalCostInUsdCents).toBe("0.8000000000");
      expect(c1.costsByName).toHaveLength(2);

      // child2 total = 0.15
      expect(c2.totalCostInUsdCents).toBe("0.1500000000");
      expect(c2.costsByName).toHaveLength(1);
    });

    it("includes costsByName breakdown", async () => {
      const org = await insertTestOrg("org-by-name-drill");
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
        costName: "gpt-4o-input-token",
        quantity: "1000",
        unitCostInUsdCents: "0.0003000000",
        totalCostInUsdCents: "0.3000000000",
        status: "actual",
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
        .get(`/v1/runs/${parent.id}/children-summary`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      const c = res.body.children[0];
      expect(c.actualCostInUsdCents).toBe("0.3000000000");
      expect(c.provisionedCostInUsdCents).toBe("0.5000000000");
      expect(c.totalCostInUsdCents).toBe("0.8000000000");

      const token = c.costsByName.find((n: any) => n.costName === "gpt-4o-input-token");
      expect(token.actualCostInUsdCents).toBe("0.3000000000");
      expect(token.provisionedCostInUsdCents).toBe("0.0000000000");

      const email = c.costsByName.find((n: any) => n.costName === "email-send");
      expect(email.actualCostInUsdCents).toBe("0.0000000000");
      expect(email.provisionedCostInUsdCents).toBe("0.5000000000");
    });

    it("returns empty children for leaf run", async () => {
      const org = await insertTestOrg("org-leaf");
      const leaf = await insertTestRun({
        organizationId: org.id,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .get(`/v1/runs/${leaf.id}/children-summary`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.parentRunId).toBe(leaf.id);
      expect(res.body.children).toEqual([]);
    });

    it("returns 404 for non-existent run", async () => {
      const res = await request(app)
        .get("/v1/runs/00000000-0000-0000-0000-000000000000/children-summary")
        .set(authHeaders);

      expect(res.status).toBe(404);
    });
  });

  describe("GET /v1/stats/public/leaderboard", () => {
    it("groups costs by brandId across all orgs", async () => {
      const org1 = await insertTestOrg("org-public-1");
      const org2 = await insertTestOrg("org-public-2");
      const run1 = await insertTestRun({
        organizationId: org1.id,
        serviceName: "svc",
        taskName: "task",
        brandId: "brand-shared",
      });
      const run2 = await insertTestRun({
        organizationId: org2.id,
        serviceName: "svc",
        taskName: "task",
        brandId: "brand-shared",
      });

      await insertTestRunCost({
        runId: run1.id,
        costName: "token",
        quantity: "100",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.1000000000",
      });
      await insertTestRunCost({
        runId: run2.id,
        costName: "token",
        quantity: "200",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.2000000000",
      });

      const res = await request(app)
        .get("/v1/stats/public/leaderboard")
        .query({ appId: "test-app", groupBy: "brandId" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.brandId).toBe("brand-shared");
      // 0.1 + 0.2 = 0.3 across both orgs
      expect(res.body.groups[0].totalCostInUsdCents).toBe("0.3000000000");
      expect(res.body.groups[0].runCount).toBe(2);
    });

    it("groups costs by workflowName across all orgs", async () => {
      const org1 = await insertTestOrg("org-public-wf-1");
      const org2 = await insertTestOrg("org-public-wf-2");
      const run1 = await insertTestRun({
        organizationId: org1.id,
        serviceName: "svc",
        taskName: "task",
        workflowName: "sales-cold-email-v1",
      });
      const run2 = await insertTestRun({
        organizationId: org2.id,
        serviceName: "svc",
        taskName: "task",
        workflowName: "sales-cold-email-v1",
      });

      await insertTestRunCost({
        runId: run1.id,
        costName: "token",
        quantity: "100",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.1000000000",
      });
      await insertTestRunCost({
        runId: run2.id,
        costName: "token",
        quantity: "300",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.3000000000",
      });

      const res = await request(app)
        .get("/v1/stats/public/leaderboard")
        .query({ appId: "test-app", groupBy: "workflowName" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.workflowName).toBe("sales-cold-email-v1");
      expect(res.body.groups[0].totalCostInUsdCents).toBe("0.4000000000");
    });

    it("rejects missing appId", async () => {
      const res = await request(app)
        .get("/v1/stats/public/leaderboard")
        .query({ groupBy: "brandId" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/appId/);
    });

    it("rejects invalid groupBy (campaignId)", async () => {
      const res = await request(app)
        .get("/v1/stats/public/leaderboard")
        .query({ appId: "test-app", groupBy: "campaignId" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/groupBy/i);
    });

    it("does not require auth", async () => {
      // No authHeaders — should still succeed
      const res = await request(app)
        .get("/v1/stats/public/leaderboard")
        .query({ appId: "test-app", groupBy: "brandId" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toBeDefined();
    });

    it("returns empty groups for unknown appId", async () => {
      const res = await request(app)
        .get("/v1/stats/public/leaderboard")
        .query({ appId: "nonexistent-app", groupBy: "brandId" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toEqual([]);
    });
  });
});
