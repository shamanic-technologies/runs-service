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

    it("filters by workflowNames (comma-separated)", async () => {
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
        workflowName: "wf-beta",
      });
      const run3 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowName: "wf-gamma",
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
      await insertTestRunCost({
        runId: run3.id,
        costName: "token",
        quantity: "300",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.3000000000",
      });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=workflowName&workflowNames=wf-alpha,wf-beta")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);
      const names = res.body.groups.map((g: any) => g.dimensions.workflowName).sort();
      expect(names).toEqual(["wf-alpha", "wf-beta"]);
    });

    it("workflowNames takes precedence over workflowName", async () => {
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
        workflowName: "wf-beta",
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

      // Both workflowName and workflowNames provided — workflowNames wins
      const res = await request(app)
        .get("/v1/stats/costs?groupBy=workflowName&workflowName=wf-alpha&workflowNames=wf-beta")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.workflowName).toBe("wf-beta");
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

    it("groups costs by featureSlug", async () => {
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "cold-email",
      });
      const run2 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "lead-gen",
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
        .get("/v1/stats/costs?groupBy=featureSlug")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);

      const coldEmail = res.body.groups.find((g: any) => g.dimensions.featureSlug === "cold-email");
      const leadGen = res.body.groups.find((g: any) => g.dimensions.featureSlug === "lead-gen");
      expect(coldEmail.totalCostInUsdCents).toBe("1.0000000000");
      expect(leadGen.totalCostInUsdCents).toBe("0.5000000000");
    });

    it("filters by featureSlug", async () => {
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "cold-email",
      });
      const run2 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "lead-gen",
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
        .get("/v1/stats/costs?groupBy=featureSlug&featureSlug=cold-email")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.featureSlug).toBe("cold-email");
    });

    it("rejects invalid groupBy", async () => {
      const res = await request(app)
        .get("/v1/stats/costs?groupBy=invalidColumn")
        .set(authHeaders);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid groupBy");
    });

    it("groups by costName with totalQuantity", async () => {
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
        status: "actual",
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "email-send",
        quantity: "5",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "2.5000000000",
        status: "actual",
      });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=costName")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);

      const emailGroup = res.body.groups.find((g: any) => g.dimensions.costName === "email-send");
      const tokenGroup = res.body.groups.find((g: any) => g.dimensions.costName === "gpt-4o-input-token");

      expect(emailGroup.totalCostInUsdCents).toBe("2.5000000000");
      expect(emailGroup.totalQuantity).toBe("5.000000");
      expect(emailGroup.runCount).toBe(1);

      expect(tokenGroup.totalCostInUsdCents).toBe("0.3000000000");
      expect(tokenGroup.totalQuantity).toBe("1000.000000");
    });

    it("groups by costName combined with other dimensions", async () => {
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc-a",
        taskName: "task",
      });
      const run2 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc-b",
        taskName: "task",
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
        .get("/v1/stats/costs?groupBy=serviceName,costName")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);
      expect(res.body.groups[0].dimensions.serviceName).toBeDefined();
      expect(res.body.groups[0].dimensions.costName).toBe("token");
      expect(res.body.groups[0].totalQuantity).toBeDefined();
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

  describe("GET /v1/stats/public/costs", () => {
    it("groups costs by brandId across all orgs", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        brandId: "brand-pub",
      });
      const run2 = await insertTestRun({
        organizationId: otherOrgId,
        serviceName: "svc",
        taskName: "task",
        brandId: "brand-pub",
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
        .get("/v1/stats/public/costs")
        .query({ groupBy: "brandId" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.brandId).toBe("brand-pub");
      expect(res.body.groups[0].totalCostInUsdCents).toBe("0.3000000000");
      expect(res.body.groups[0].runCount).toBe(2);
    });

    it("supports groupBy=campaignId", async () => {
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        campaignId: "camp-1",
      });

      await insertTestRunCost({
        runId: run1.id,
        costName: "token",
        quantity: "100",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.1000000000",
      });

      const res = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "campaignId" });

      expect(res.status).toBe(200);
      const group = res.body.groups.find((g: any) => g.dimensions.campaignId === "camp-1");
      expect(group).toBeDefined();
      expect(group.totalCostInUsdCents).toBe("0.1000000000");
    });

    it("supports groupBy=costName with totalQuantity", async () => {
      const run = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
      });

      await insertTestRunCost({
        runId: run.id,
        costName: "email-send",
        quantity: "5",
        unitCostInUsdCents: "0.5000000000",
        totalCostInUsdCents: "2.5000000000",
      });

      const res = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "costName" });

      expect(res.status).toBe(200);
      const group = res.body.groups.find((g: any) => g.dimensions.costName === "email-send");
      expect(group).toBeDefined();
      expect(group.totalQuantity).toBe("5.000000");
    });

    it("applies orgId filter", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";
      const run1 = await insertTestRun({
        organizationId: TEST_ORG_ID,
        serviceName: "svc",
        taskName: "task",
        brandId: "brand-filter",
      });
      const run2 = await insertTestRun({
        organizationId: otherOrgId,
        serviceName: "svc",
        taskName: "task",
        brandId: "brand-filter",
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
        .get("/v1/stats/public/costs")
        .query({ groupBy: "brandId", orgId: TEST_ORG_ID });

      expect(res.status).toBe(200);
      const group = res.body.groups.find((g: any) => g.dimensions.brandId === "brand-filter");
      expect(group).toBeDefined();
      expect(group.totalCostInUsdCents).toBe("0.1000000000");
      expect(group.runCount).toBe(1);
    });

    it("rejects invalid groupBy", async () => {
      const res = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "invalidColumn" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/groupBy/i);
    });

    it("does not require auth", async () => {
      const res = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "brandId" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toBeDefined();
    });
  });

});
