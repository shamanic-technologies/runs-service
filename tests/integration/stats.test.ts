import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders, TEST_ORG_ID } from "../helpers/test-app.js";
import {
  cleanTestData,
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
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        brandId: "brand-a",
      });
      const run2 = await insertTestRun({
        organizationId: TEST_ORG_ID,
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
        .get("/v1/stats/costs?groupBy=brandId")
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
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
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
        .get("/v1/stats/costs?groupBy=brandId,serviceName")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.brandId).toBe("brand-x");
      expect(res.body.groups[0].dimensions.serviceName).toBe("svc-a");
    });

    it("applies filters", async () => {
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc-a",
        taskName: "task",
        brandId: "brand-f",
        workflowName: "wf-1",
      });
      const run2 = await insertTestRun({
        organizationId: TEST_ORG_ID,
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
        .get("/v1/stats/costs?groupBy=brandId&workflowName=wf-1")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].totalCostInUsdCents).toBe("0.1000000000");
    });

    it("returns empty when org has no runs", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";
      const headers = getAuthHeaders({ orgId: otherOrgId });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=brandId")
        .set(headers);

      expect(res.status).toBe(200);
      expect(res.body.groups).toEqual([]);
    });

    it("rejects invalid groupBy", async () => {
      const res = await request(app)
        .get("/v1/stats/costs?groupBy=invalidColumn")
        .set(authHeaders);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid groupBy");
    });

    it("separates actual, provisioned, cancelled costs", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
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
        .get("/v1/stats/costs?groupBy=brandId")
        .set(authHeaders);

      expect(res.status).toBe(200);
      const group = res.body.groups[0];
      expect(group.actualCostInUsdCents).toBe("0.1000000000");
      expect(group.provisionedCostInUsdCents).toBe("0.2000000000");
      expect(group.cancelledCostInUsdCents).toBe("0.0500000000");
      expect(group.totalCostInUsdCents).toBe("0.3000000000");
    });
  });

  describe("GET /v1/stats/costs/by-cost-name", () => {
    it("returns breakdown by cost name", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
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
        .get("/v1/stats/costs/by-cost-name")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.costs).toHaveLength(2);

      expect(res.body.costs[0].costName).toBe("email-send");
      expect(res.body.costs[0].totalCostInUsdCents).toBe("2.5000000000");
      expect(res.body.costs[0].totalQuantity).toBe("5.000000");
      expect(res.body.costs[1].costName).toBe("gpt-4o-input-token");
    });

    it("includes actual/provisioned/cancelled breakdown", async () => {
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
        .get("/v1/stats/costs/by-cost-name")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.costs).toHaveLength(1);
      const cost = res.body.costs[0];
      expect(cost.costName).toBe("email-send");
      expect(cost.actualCostInUsdCents).toBe("0.5000000000");
      expect(cost.provisionedCostInUsdCents).toBe("1.0000000000");
      expect(cost.cancelledCostInUsdCents).toBe("0.5000000000");
      expect(cost.totalCostInUsdCents).toBe("1.5000000000");
      expect(cost.totalQuantity).toBe("4.000000");
    });

    it("returns empty when org has no costs", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";
      const headers = getAuthHeaders({ orgId: otherOrgId });

      const res = await request(app)
        .get("/v1/stats/costs/by-cost-name")
        .set(headers);

      expect(res.status).toBe(200);
      expect(res.body.costs).toEqual([]);
    });
  });

  describe("POST /v1/stats/budget", () => {
    it("returns per-window budget totals", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
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

    it("returns zeros when org has no costs", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";
      const headers = getAuthHeaders({ orgId: otherOrgId });

      const res = await request(app)
        .post("/v1/stats/budget")
        .set(headers)
        .send({
          windows: [{ label: "all-time" }],
        });

      expect(res.status).toBe(200);
      expect(res.body.windows[0].totalCostInUsdCents).toBe("0.0000000000");
    });

    it("handles temporal window with since", async () => {
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

      const farFuture = "2099-01-01T00:00:00.000Z";
      const res = await request(app)
        .post("/v1/stats/budget")
        .set(authHeaders)
        .send({
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
  });

  describe("GET /v1/runs/:id/children-summary", () => {
    it("aggregates costs per child including grandchildren", async () => {
      const parent = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "campaign-svc",
        taskName: "run-campaign",
      });
      const child1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "lead-svc",
        taskName: "process-lead",
        parentRunId: parent.id,
      });
      const grandchild = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "email-svc",
        taskName: "send-email",
        parentRunId: child1.id,
      });
      const child2 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "lead-svc",
        taskName: "process-lead",
        parentRunId: parent.id,
      });

      await insertTestRunCost({
        runId: child1.id,
        costName: "gpt-4o-input-token",
        quantity: "1000",
        unitCostInUsdCents: "0.0003000000",
        totalCostInUsdCents: "0.3000000000",
      });
      await insertTestRunCost({
        runId: grandchild.id,
        costName: "email-send",
        quantity: "1",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "0.5000000000",
      });
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

      expect(c1.totalCostInUsdCents).toBe("0.8000000000");
      expect(c1.costsByName).toHaveLength(2);

      expect(c2.totalCostInUsdCents).toBe("0.1500000000");
      expect(c2.costsByName).toHaveLength(1);
    });

    it("includes costsByName breakdown", async () => {
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
      const leaf = await insertTestRun({
        organizationId: TEST_ORG_ID,
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

  describe("GET /v1/stats/run-ids-by-workflow", () => {
    it("groups run IDs by workflow name", async () => {
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-alpha",
      });
      const run2 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-alpha",
      });
      const run3 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-beta",
      });

      const res = await request(app)
        .get("/v1/stats/run-ids-by-workflow")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.groups)).toHaveLength(2);
      expect(res.body.groups["wf-alpha"]).toHaveLength(2);
      expect(res.body.groups["wf-alpha"]).toContain(run1.id);
      expect(res.body.groups["wf-alpha"]).toContain(run2.id);
      expect(res.body.groups["wf-beta"]).toHaveLength(1);
      expect(res.body.groups["wf-beta"]).toContain(run3.id);
    });

    it("excludes runs with null workflow_name", async () => {
      await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-only",
      });
      await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      const res = await request(app)
        .get("/v1/stats/run-ids-by-workflow")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.groups)).toHaveLength(1);
      expect(res.body.groups["wf-only"]).toHaveLength(1);
    });

    it("returns empty groups when org has no workflow runs", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";
      const headers = getAuthHeaders({ orgId: otherOrgId });

      const res = await request(app)
        .get("/v1/stats/run-ids-by-workflow")
        .set(headers);

      expect(res.status).toBe(200);
      expect(res.body.groups).toEqual({});
    });

    it("requires auth", async () => {
      const res = await request(app)
        .get("/v1/stats/run-ids-by-workflow");

      expect(res.status).toBe(401);
    });

    it("applies filters (brandId)", async () => {
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-filtered",
        brandId: "brand-x",
      });
      await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-filtered",
        brandId: "brand-y",
      });

      const res = await request(app)
        .get("/v1/stats/run-ids-by-workflow?brandId=brand-x")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.groups)).toHaveLength(1);
      expect(res.body.groups["wf-filtered"]).toHaveLength(1);
      expect(res.body.groups["wf-filtered"]).toContain(run1.id);
    });
  });

  describe("GET /v1/stats/public/run-ids-by-workflow", () => {
    it("groups run IDs by workflow name using orgId query param", async () => {
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-pub-alpha",
      });
      const run2 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-pub-alpha",
      });
      const run3 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-pub-beta",
      });

      const res = await request(app)
        .get(`/v1/stats/public/run-ids-by-workflow?orgId=${TEST_ORG_ID}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.groups)).toHaveLength(2);
      expect(res.body.groups["wf-pub-alpha"]).toHaveLength(2);
      expect(res.body.groups["wf-pub-alpha"]).toContain(run1.id);
      expect(res.body.groups["wf-pub-alpha"]).toContain(run2.id);
      expect(res.body.groups["wf-pub-beta"]).toHaveLength(1);
      expect(res.body.groups["wf-pub-beta"]).toContain(run3.id);
    });

    it("returns cross-org results when orgId is omitted", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-cross-org",
      });
      const run2 = await insertTestRun({
        organizationId: otherOrgId,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-cross-org",
      });
      const run3 = await insertTestRun({
        organizationId: otherOrgId,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-other-only",
      });

      const res = await request(app)
        .get("/v1/stats/public/run-ids-by-workflow");

      expect(res.status).toBe(200);
      expect(res.body.groups["wf-cross-org"]).toHaveLength(2);
      expect(res.body.groups["wf-cross-org"]).toContain(run1.id);
      expect(res.body.groups["wf-cross-org"]).toContain(run2.id);
      expect(res.body.groups["wf-other-only"]).toHaveLength(1);
      expect(res.body.groups["wf-other-only"]).toContain(run3.id);
    });

    it("does not require identity headers", async () => {
      await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-no-headers",
      });

      const res = await request(app)
        .get(`/v1/stats/public/run-ids-by-workflow?orgId=${TEST_ORG_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.groups["wf-no-headers"]).toHaveLength(1);
    });

    it("filters by orgId (isolates orgs)", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";
      await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-isolated",
      });
      await insertTestRun({
        organizationId: otherOrgId,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-other",
      });

      const res = await request(app)
        .get(`/v1/stats/public/run-ids-by-workflow?orgId=${TEST_ORG_ID}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.groups)).toHaveLength(1);
      expect(res.body.groups["wf-isolated"]).toBeDefined();
      expect(res.body.groups["wf-other"]).toBeUndefined();
    });

    it("applies filters (brandId)", async () => {
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-pub-filtered",
        brandId: "brand-x",
      });
      await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-pub-filtered",
        brandId: "brand-y",
      });

      const res = await request(app)
        .get(`/v1/stats/public/run-ids-by-workflow?orgId=${TEST_ORG_ID}&brandId=brand-x`);

      expect(res.status).toBe(200);
      expect(res.body.groups["wf-pub-filtered"]).toHaveLength(1);
      expect(res.body.groups["wf-pub-filtered"]).toContain(run1.id);
    });
  });

  describe("GET /v1/stats/public/leaderboard", () => {
    it("groups costs by brandId across all orgs", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        brandId: "brand-shared",
      });
      const run2 = await insertTestRun({
        organizationId: otherOrgId,
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
        .query({ groupBy: "brandId" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.brandId).toBe("brand-shared");
      expect(res.body.groups[0].totalCostInUsdCents).toBe("0.3000000000");
      expect(res.body.groups[0].runCount).toBe(2);
    });

    it("groups costs by workflowName across all orgs", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "sales-cold-email-v1",
      });
      const run2 = await insertTestRun({
        organizationId: otherOrgId,
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
        .query({ groupBy: "workflowName" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.workflowName).toBe("sales-cold-email-v1");
      expect(res.body.groups[0].totalCostInUsdCents).toBe("0.4000000000");
    });

    it("rejects invalid groupBy (campaignId)", async () => {
      const res = await request(app)
        .get("/v1/stats/public/leaderboard")
        .query({ groupBy: "campaignId" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/groupBy/i);
    });

    it("does not require auth", async () => {
      const res = await request(app)
        .get("/v1/stats/public/leaderboard")
        .query({ groupBy: "brandId" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toBeDefined();
    });

    it("returns identical results regardless of x-org-id/x-user-id headers", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";

      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-header-test",
      });
      const run2 = await insertTestRun({
        organizationId: otherOrgId,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-header-test",
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

      const resNoHeaders = await request(app)
        .get("/v1/stats/public/leaderboard")
        .query({ groupBy: "workflowName" });

      const resWithHeaders = await request(app)
        .get("/v1/stats/public/leaderboard")
        .set("x-org-id", TEST_ORG_ID)
        .set("x-user-id", "some-user-id")
        .query({ groupBy: "workflowName" });

      expect(resNoHeaders.status).toBe(200);
      expect(resWithHeaders.status).toBe(200);

      const groupNoHeaders = resNoHeaders.body.groups.find(
        (g: any) => g.dimensions.workflowName === "wf-header-test"
      );
      const groupWithHeaders = resWithHeaders.body.groups.find(
        (g: any) => g.dimensions.workflowName === "wf-header-test"
      );

      expect(groupNoHeaders).toBeDefined();
      expect(groupWithHeaders).toBeDefined();
      expect(groupWithHeaders.totalCostInUsdCents).toBe(groupNoHeaders.totalCostInUsdCents);
      expect(groupWithHeaders.runCount).toBe(groupNoHeaders.runCount);
      expect(groupWithHeaders.totalCostInUsdCents).toBe("0.3000000000");
      expect(groupWithHeaders.runCount).toBe(2);
    });
  });
});
