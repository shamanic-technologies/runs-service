import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestRun,
  insertTestRunCost,
  closeDb,
} from "../helpers/test-db.js";
import * as dynastyResolver from "../../src/services/dynasty-resolver.js";

// File-local org id keeps this file isolated from other integration files running in parallel.
const ORG_ID = "bbbbbbbb-2222-4222-abbb-222222222222";
// Some tests insert into a second org to assert cross-org filtering/aggregation;
// it must be cleaned between tests so /public/* tests don't see leftovers.
const OTHER_ORG_ID = "99999999-9999-9999-9999-999999999999";
const CLEANUP_ORG_IDS = [ORG_ID, OTHER_ORG_ID];

describe("Stats endpoints", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders({ orgId: ORG_ID });

  beforeEach(async () => {
    await cleanTestData(CLEANUP_ORG_IDS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanTestData(CLEANUP_ORG_IDS);
    await closeDb();
  });

  describe("GET /v1/stats/costs", () => {
    it("groups costs by brandId", async () => {
      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        brandIds: ["brand-a"],
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        brandIds: ["brand-b"],
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

    it("unnests multi-brand runs when grouping by brandId", async () => {
      // A run with two brands should appear in both brand groups
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        brandIds: ["brand-m1", "brand-m2"],
      });

      await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "100",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.1000000000",
      });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=brandId")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);

      const m1 = res.body.groups.find((g: any) => g.dimensions.brandId === "brand-m1");
      const m2 = res.body.groups.find((g: any) => g.dimensions.brandId === "brand-m2");
      expect(m1).toBeDefined();
      expect(m2).toBeDefined();
      // Each brand group gets the full cost (the run belongs to both brands)
      expect(m1.totalCostInUsdCents).toBe("0.1000000000");
      expect(m2.totalCostInUsdCents).toBe("0.1000000000");
    });

    it("groups by multiple dimensions", async () => {
      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc-a",
        taskName: "task",
        brandIds: ["brand-x"],
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
        organizationId: ORG_ID,
        serviceName: "svc-a",
        taskName: "task",
        brandIds: ["brand-f"],
        workflowSlug: "wf-1",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc-b",
        taskName: "task",
        brandIds: ["brand-f"],
        workflowSlug: "wf-2",
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
        .get("/v1/stats/costs?groupBy=brandId&workflowSlug=wf-1")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].totalCostInUsdCents).toBe("0.1000000000");
    });

    it("filters by workflowSlugs (comma-separated)", async () => {
      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "wf-alpha",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "wf-beta",
      });
      const run3 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "wf-gamma",
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
        .get("/v1/stats/costs?groupBy=workflowSlug&workflowSlugs=wf-alpha,wf-beta")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);
      const names = res.body.groups.map((g: any) => g.dimensions.workflowSlug).sort();
      expect(names).toEqual(["wf-alpha", "wf-beta"]);
    });

    it("workflowSlugs takes precedence over workflowSlug", async () => {
      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "wf-alpha",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "wf-beta",
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

      // Both workflowSlug and workflowSlugs provided — workflowSlugs wins
      const res = await request(app)
        .get("/v1/stats/costs?groupBy=workflowSlug&workflowSlug=wf-alpha&workflowSlugs=wf-beta")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.workflowSlug).toBe("wf-beta");
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
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "cold-email",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "cold-email",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
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

    it("returns minStartedAt and maxStartedAt", async () => {
      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        brandIds: ["brand-ts"],
        startedAt: new Date("2025-01-01T00:00:00.000Z"),
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        brandIds: ["brand-ts"],
        startedAt: new Date("2025-06-15T12:00:00.000Z"),
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
        .get("/v1/stats/costs?groupBy=brandId")
        .set(authHeaders);

      expect(res.status).toBe(200);
      const group = res.body.groups.find((g: any) => g.dimensions.brandId === "brand-ts");
      expect(group.minStartedAt).toBe("2025-01-01T00:00:00.000Z");
      expect(group.maxStartedAt).toBe("2025-06-15T12:00:00.000Z");
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
        serviceName: "svc-a",
        taskName: "task",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        brandIds: ["brand-s"],
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
        serviceName: "campaign-svc",
        taskName: "run-campaign",
      });
      const child1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "lead-svc",
        taskName: "process-lead",
        parentRunId: parent.id,
      });
      const grandchild = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "email-svc",
        taskName: "send-email",
        parentRunId: child1.id,
      });
      const child2 = await insertTestRun({
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        brandIds: ["brand-pub"],
      });
      const run2 = await insertTestRun({
        organizationId: otherOrgId,
        serviceName: "svc",
        taskName: "task",
        brandIds: ["brand-pub"],
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
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
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        brandIds: ["brand-filter"],
      });
      const run2 = await insertTestRun({
        organizationId: otherOrgId,
        serviceName: "svc",
        taskName: "task",
        brandIds: ["brand-filter"],
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
        .query({ groupBy: "brandId", orgId: ORG_ID });

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

    it("filters by featureSlugs (comma-separated)", async () => {
      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "sales-cold-email",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "sales-cold-email-v2",
      });
      const run3 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "unrelated-feature",
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
        .get("/v1/stats/public/costs")
        .query({ groupBy: "workflowSlug", featureSlugs: "sales-cold-email,sales-cold-email-v2" });

      expect(res.status).toBe(200);
      // Should only include runs with the two feature slugs, not the unrelated one
      const totalRunCount = res.body.groups.reduce((acc: number, g: any) => acc + g.runCount, 0);
      expect(totalRunCount).toBe(2);
    });

    it("featureDynastySlug takes precedence over featureSlugs", async () => {
      vi.spyOn(dynastyResolver, "resolveFeatureDynastySlugs").mockResolvedValue([
        "dynasty-resolved-slug",
      ]);

      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "dynasty-resolved-slug",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "direct-slug",
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

      // When both featureDynastySlug and featureSlugs are provided, dynasty wins
      const res = await request(app)
        .get("/v1/stats/public/costs")
        .query({
          groupBy: "workflowSlug",
          featureSlugs: "direct-slug",
          featureDynastySlug: "some-dynasty",
        });

      expect(res.status).toBe(200);
      const totalRunCount = res.body.groups.reduce((acc: number, g: any) => acc + g.runCount, 0);
      expect(totalRunCount).toBe(1); // Only dynasty-resolved-slug matched
    });
  });

  describe("Dynasty slug filtering — GET /v1/stats/costs", () => {
    it("filters by workflowDynastySlug (resolved to versioned slugs)", async () => {
      vi.spyOn(dynastyResolver, "resolveWorkflowDynastySlugs").mockResolvedValue([
        "cold-email",
        "cold-email-v2",
      ]);

      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "cold-email",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "cold-email-v2",
      });
      const run3 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "unrelated-workflow",
      });

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });
      await insertTestRunCost({ runId: run3.id, costName: "token", quantity: "300", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.3000000000" });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=workflowSlug&workflowDynastySlug=cold-email")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);
      const slugs = res.body.groups.map((g: any) => g.dimensions.workflowSlug).sort();
      expect(slugs).toEqual(["cold-email", "cold-email-v2"]);
    });

    it("filters by featureDynastySlug (resolved to versioned slugs)", async () => {
      vi.spyOn(dynastyResolver, "resolveFeatureDynastySlugs").mockResolvedValue([
        "feat-alpha",
        "feat-alpha-v2",
      ]);

      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "feat-alpha",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "feat-alpha-v2",
      });
      const run3 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "unrelated-feature",
      });

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });
      await insertTestRunCost({ runId: run3.id, costName: "token", quantity: "300", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.3000000000" });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=featureSlug&featureDynastySlug=feat-alpha")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);
      const slugs = res.body.groups.map((g: any) => g.dimensions.featureSlug).sort();
      expect(slugs).toEqual(["feat-alpha", "feat-alpha-v2"]);
    });

    it("returns empty stats when dynasty resolves to empty list", async () => {
      vi.spyOn(dynastyResolver, "resolveWorkflowDynastySlugs").mockResolvedValue([]);

      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "some-wf",
      });
      await insertTestRunCost({ runId: run.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=workflowSlug&workflowDynastySlug=nonexistent-dynasty")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toEqual([]);
    });

    it("workflowDynastySlug takes precedence over workflowSlug and workflowSlugs", async () => {
      vi.spyOn(dynastyResolver, "resolveWorkflowDynastySlugs").mockResolvedValue([
        "dynasty-wf",
      ]);

      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "dynasty-wf",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "other-wf",
      });

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=workflowSlug&workflowDynastySlug=dynasty-wf&workflowSlug=other-wf&workflowSlugs=other-wf")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.workflowSlug).toBe("dynasty-wf");
    });

    it("combines dynasty filter with other filters", async () => {
      vi.spyOn(dynastyResolver, "resolveFeatureDynastySlugs").mockResolvedValue([
        "feat-a",
        "feat-a-v2",
      ]);

      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "feat-a",
        brandIds: ["brand-x"],
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "feat-a-v2",
        brandIds: ["brand-y"],
      });

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=featureSlug&featureDynastySlug=feat-a&brandId=brand-x")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.featureSlug).toBe("feat-a");
    });
  });

  describe("Dynasty slug groupBy — GET /v1/stats/costs", () => {
    it("groups by workflowDynastySlug (merges versioned slugs)", async () => {
      vi.spyOn(dynastyResolver, "fetchAllWorkflowDynasties").mockResolvedValue([
        { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
        { dynastySlug: "warm-intro", slugs: ["warm-intro"] },
      ]);

      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "cold-email",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "cold-email-v2",
      });
      const run3 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "warm-intro",
      });

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });
      await insertTestRunCost({ runId: run3.id, costName: "token", quantity: "300", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.3000000000" });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=workflowDynastySlug")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);

      const coldEmail = res.body.groups.find((g: any) => g.dimensions.workflowDynastySlug === "cold-email");
      const warmIntro = res.body.groups.find((g: any) => g.dimensions.workflowDynastySlug === "warm-intro");

      expect(coldEmail).toBeDefined();
      expect(coldEmail.totalCostInUsdCents).toBe("0.3000000000");
      expect(coldEmail.runCount).toBe(2);

      expect(warmIntro).toBeDefined();
      expect(warmIntro.totalCostInUsdCents).toBe("0.3000000000");
      expect(warmIntro.runCount).toBe(1);
    });

    it("groups by featureDynastySlug (merges versioned slugs)", async () => {
      vi.spyOn(dynastyResolver, "fetchAllFeatureDynasties").mockResolvedValue([
        { dynastySlug: "feat-alpha", slugs: ["feat-alpha", "feat-alpha-v2"] },
      ]);

      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "feat-alpha",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "feat-alpha-v2",
      });

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=featureDynastySlug")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.featureDynastySlug).toBe("feat-alpha");
      expect(res.body.groups[0].totalCostInUsdCents).toBe("0.3000000000");
      expect(res.body.groups[0].runCount).toBe(2);
    });

    it("orphan slugs (not in any dynasty) fall back to raw slug value", async () => {
      vi.spyOn(dynastyResolver, "fetchAllWorkflowDynasties").mockResolvedValue([
        { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
      ]);

      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "cold-email",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "orphan-workflow",
      });

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=workflowDynastySlug")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);

      const coldEmail = res.body.groups.find((g: any) => g.dimensions.workflowDynastySlug === "cold-email");
      const orphan = res.body.groups.find((g: any) => g.dimensions.workflowDynastySlug === "orphan-workflow");

      expect(coldEmail).toBeDefined();
      expect(orphan).toBeDefined();
      expect(orphan.totalCostInUsdCents).toBe("0.2000000000");
    });
  });

  describe("GET /public/stats/runs", () => {
    it("returns byStatus breakdown and monthly array", async () => {
      await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed" });
      await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed" });
      await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "failed" });
      await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "running" });

      const res = await request(app).get("/public/stats/runs");

      expect(res.status).toBe(200);
      expect(res.body.byStatus.completed).toBe(2);
      expect(res.body.byStatus.failed).toBe(1);
      expect(res.body.byStatus.running).toBe(1);
      expect(res.body.monthly).toHaveLength(1);
      expect(res.body.monthly[0].completed).toBe(2);
      expect(res.body.monthly[0].failed).toBe(1);
      expect(res.body.monthly[0].running).toBe(1);
    });

    it("does not require auth", async () => {
      const res = await request(app).get("/public/stats/runs");

      expect(res.status).toBe(200);
      expect(res.body.byStatus).toBeDefined();
      expect(res.body.monthly).toBeDefined();
    });

    it("returns zeros when no runs exist", async () => {
      const res = await request(app).get("/public/stats/runs");

      expect(res.status).toBe(200);
      expect(res.body.byStatus).toEqual({ completed: 0, failed: 0, running: 0 });
      expect(res.body.monthly).toEqual([]);
    });

    it("aggregates across orgs", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";
      await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed" });
      await insertTestRun({ organizationId: otherOrgId, serviceName: "svc", taskName: "t", status: "completed" });

      const res = await request(app).get("/public/stats/runs");

      expect(res.status).toBe(200);
      expect(res.body.byStatus.completed).toBe(2);
    });

    it("returns monthly breakdown sorted ascending", async () => {
      const jan = new Date("2026-01-15T12:00:00Z");
      const feb = new Date("2026-02-15T12:00:00Z");
      await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed", startedAt: jan });
      await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "failed", startedAt: feb });
      await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed", startedAt: feb });

      const res = await request(app).get("/public/stats/runs");

      expect(res.status).toBe(200);
      expect(res.body.monthly).toHaveLength(2);
      expect(res.body.monthly[0].month).toBe("2026-01");
      expect(res.body.monthly[0].completed).toBe(1);
      expect(res.body.monthly[0].failed).toBe(0);
      expect(res.body.monthly[1].month).toBe("2026-02");
      expect(res.body.monthly[1].completed).toBe(1);
      expect(res.body.monthly[1].failed).toBe(1);
    });

    it("returns top-level totalCostInUsdCents summing platform non-cancelled rows", async () => {
      const run1 = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed" });
      const run2 = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed" });

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "1.0000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.5000000000" });

      const res = await request(app).get("/public/stats/runs");

      expect(res.status).toBe(200);
      expect(res.body.totalCostInUsdCents).toBe("1.5000000000");
    });

    it("excludes cancelled cost rows from totalCostInUsdCents", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed" });
      await insertTestRunCost({ runId: run.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "1.0000000000", status: "actual" });
      await insertTestRunCost({ runId: run.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "9.9999999999", status: "cancelled" });

      const res = await request(app).get("/public/stats/runs");

      expect(res.status).toBe(200);
      expect(res.body.totalCostInUsdCents).toBe("1.0000000000");
    });

    it("excludes BYOK (cost_source='org') rows from totalCostInUsdCents", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed" });
      await insertTestRunCost({ runId: run.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "1.0000000000", costSource: "platform" });
      await insertTestRunCost({ runId: run.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "8.0000000000", costSource: "org" });

      const res = await request(app).get("/public/stats/runs");

      expect(res.status).toBe(200);
      expect(res.body.totalCostInUsdCents).toBe("1.0000000000");
    });

    it("includes provisioned platform rows in totalCostInUsdCents", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "running" });
      await insertTestRunCost({ runId: run.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.5000000000", status: "actual" });
      await insertTestRunCost({ runId: run.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2500000000", status: "provisioned" });

      const res = await request(app).get("/public/stats/runs");

      expect(res.status).toBe(200);
      expect(res.body.totalCostInUsdCents).toBe("0.7500000000");
    });

    it("returns totalCostInUsdCents per monthly entry", async () => {
      const jan = new Date("2026-01-15T12:00:00Z");
      const feb = new Date("2026-02-15T12:00:00Z");
      const runJan = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed", startedAt: jan });
      const runFeb = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed", startedAt: feb });

      await insertTestRunCost({ runId: runJan.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: runFeb.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.3000000000" });
      await insertTestRunCost({ runId: runFeb.id, costName: "token", quantity: "300", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.0500000000" });

      const res = await request(app).get("/public/stats/runs");

      expect(res.status).toBe(200);
      expect(res.body.monthly).toHaveLength(2);
      expect(res.body.monthly[0].month).toBe("2026-01");
      expect(res.body.monthly[0].totalCostInUsdCents).toBe("0.1000000000");
      expect(res.body.monthly[1].month).toBe("2026-02");
      expect(res.body.monthly[1].totalCostInUsdCents).toBe("0.3500000000");
      expect(res.body.totalCostInUsdCents).toBe("0.4500000000");
    });

    it("returns zero totalCostInUsdCents when no runs exist", async () => {
      const res = await request(app).get("/public/stats/runs");

      expect(res.status).toBe(200);
      expect(res.body.totalCostInUsdCents).toBe("0.0000000000");
      expect(res.body.monthly).toEqual([]);
    });

    it("does not over-count monthly run statuses when a run has multiple cost rows", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed" });
      await insertTestRunCost({ runId: run.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: run.id, costName: "compute", quantity: "10", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });
      await insertTestRunCost({ runId: run.id, costName: "bandwidth", quantity: "5", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1500000000" });

      const res = await request(app).get("/public/stats/runs");

      expect(res.status).toBe(200);
      expect(res.body.byStatus.completed).toBe(1);
      expect(res.body.monthly).toHaveLength(1);
      expect(res.body.monthly[0].completed).toBe(1);
      expect(res.body.monthly[0].totalCostInUsdCents).toBe("0.4500000000");
      expect(res.body.totalCostInUsdCents).toBe("0.4500000000");
    });

    it("preserves 10-decimal precision in totalCostInUsdCents", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed" });
      await insertTestRunCost({ runId: run.id, costName: "token", quantity: "1", unitCostInUsdCents: "0.0000000123", totalCostInUsdCents: "0.0000000123" });

      const res = await request(app).get("/public/stats/runs");

      expect(res.status).toBe(200);
      expect(res.body.totalCostInUsdCents).toBe("0.0000000123");
      expect(res.body.monthly[0].totalCostInUsdCents).toBe("0.0000000123");
    });
  });

  describe("Dynasty slug — GET /v1/stats/public/costs", () => {
    it("groups by workflowDynastySlug", async () => {
      vi.spyOn(dynastyResolver, "fetchAllWorkflowDynasties").mockResolvedValue([
        { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
      ]);

      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "cold-email",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "cold-email-v2",
      });

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });

      const res = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "workflowDynastySlug" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.workflowDynastySlug).toBe("cold-email");
      expect(res.body.groups[0].totalCostInUsdCents).toBe("0.3000000000");
      expect(res.body.groups[0].runCount).toBe(2);
    });

    it("groups by featureDynastySlug", async () => {
      vi.spyOn(dynastyResolver, "fetchAllFeatureDynasties").mockResolvedValue([
        { dynastySlug: "feat-alpha", slugs: ["feat-alpha", "feat-alpha-v2"] },
      ]);

      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "feat-alpha",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "feat-alpha-v2",
      });

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });

      const res = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "featureDynastySlug" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.featureDynastySlug).toBe("feat-alpha");
      expect(res.body.groups[0].totalCostInUsdCents).toBe("0.3000000000");
    });

    it("filters by featureDynastySlug", async () => {
      vi.spyOn(dynastyResolver, "resolveFeatureDynastySlugs").mockResolvedValue([
        "feat-a",
        "feat-a-v2",
      ]);

      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "feat-a",
        brandIds: ["brand-x"],
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "feat-a-v2",
        brandIds: ["brand-x"],
      });
      const run3 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "unrelated",
        brandIds: ["brand-x"],
      });

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });
      await insertTestRunCost({ runId: run3.id, costName: "token", quantity: "300", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.3000000000" });

      const res = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "brandId", featureDynastySlug: "feat-a" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].totalCostInUsdCents).toBe("0.3000000000");
      expect(res.body.groups[0].runCount).toBe(2);
    });

    it("returns empty when dynasty resolves to empty list (public)", async () => {
      vi.spyOn(dynastyResolver, "resolveFeatureDynastySlugs").mockResolvedValue([]);

      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "something",
      });
      await insertTestRunCost({ runId: run.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });

      const res = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "brandId", featureDynastySlug: "nonexistent" });

      expect(res.status).toBe(200);
      expect(res.body.groups).toEqual([]);
    });
  });

});
