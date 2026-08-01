import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { Decimal } from "decimal.js";
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
      // No frozen net on these rows (null) → net == gross via COALESCE fallback.
      expect(res.body.windows[0].netTotalCostInUsdCents).toBe("1.5000000000");
      expect(res.body.windows[0].netActualCostInUsdCents).toBe("1.0000000000");
      expect(res.body.windows[0].netProvisionedCostInUsdCents).toBe("0.5000000000");
    });

    it("returns NET committed ≈ half gross for a 50%-discounted org, using gross for null-net rows", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        campaignId: "campaign-discount",
      });

      // Frozen-net rows: 50% usage discount → net = gross × (1 − 0.5).
      await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "1000",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "1.0000000000",
        netCostInUsdCents: "0.5000000000",
        usageDiscountPct: "0.50000000",
        status: "actual",
      });
      await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "500",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.5000000000",
        netCostInUsdCents: "0.2500000000",
        usageDiscountPct: "0.50000000",
        status: "provisioned",
      });
      // Historical row that predates the freeze (net IS NULL) → net falls back to gross.
      await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "400",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.4000000000",
        status: "actual",
      });

      const res = await request(app)
        .post("/v1/stats/budget")
        .set(authHeaders)
        .send({ campaignId: "campaign-discount", windows: [{ label: "all-time" }] });

      expect(res.status).toBe(200);
      const w = res.body.windows[0];
      // Gross fields unchanged (list price).
      expect(w.totalCostInUsdCents).toBe("1.9000000000"); // 1.0 + 0.5 + 0.4
      expect(w.actualCostInUsdCents).toBe("1.4000000000"); // 1.0 + 0.4
      expect(w.provisionedCostInUsdCents).toBe("0.5000000000");
      // NET: frozen net for discounted rows, gross for the null-net historical row.
      expect(w.netTotalCostInUsdCents).toBe("1.1500000000"); // 0.5 + 0.25 + 0.4
      expect(w.netActualCostInUsdCents).toBe("0.9000000000"); // 0.5 + 0.4 (null-net → gross)
      expect(w.netProvisionedCostInUsdCents).toBe("0.2500000000");
    });

    it("returns NET committed == gross committed for a non-discounted org", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        campaignId: "campaign-nodiscount",
      });

      // No discount: net frozen equal to gross (usageDiscountPct = 0).
      await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "1000",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "1.0000000000",
        netCostInUsdCents: "1.0000000000",
        usageDiscountPct: "0.00000000",
        status: "actual",
      });

      const res = await request(app)
        .post("/v1/stats/budget")
        .set(authHeaders)
        .send({ campaignId: "campaign-nodiscount", windows: [{ label: "all-time" }] });

      expect(res.status).toBe(200);
      const w = res.body.windows[0];
      expect(w.actualCostInUsdCents).toBe("1.0000000000");
      expect(w.netActualCostInUsdCents).toBe(w.actualCostInUsdCents);
      expect(w.netTotalCostInUsdCents).toBe(w.totalCostInUsdCents);
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

    // The runs-side dimensions are served by a split (counts | sums) aggregation
    // rather than one LEFT JOIN (runs-service#206). These pin the two behaviours the
    // split could plausibly change: a group whose runs have NO cost rows at all, and
    // a NULL dimension value.
    it("keeps a group whose runs have no cost rows at all", async () => {
      await insertTestRun({
        organizationId: ORG_ID, serviceName: "svc", taskName: "task", brandIds: ["brand-costless"],
      });
      const paid = await insertTestRun({
        organizationId: ORG_ID, serviceName: "svc", taskName: "task", brandIds: ["brand-paid"],
      });
      await insertTestRunCost({
        runId: paid.id, costName: "token", quantity: "100",
        unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000",
      });

      const res = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "brandId" });

      expect(res.status).toBe(200);
      const costless = res.body.groups.find((g: any) => g.dimensions.brandId === "brand-costless");
      expect(costless).toBeDefined();
      expect(costless.runCount).toBe(1);
      expect(costless.totalCostInUsdCents).toBe("0.0000000000");
      expect(costless.netTotalCostInUsdCents).toBe("0.0000000000");
    });

    it("keeps a NULL dimension as its own group", async () => {
      const noCampaign = await insertTestRun({
        organizationId: ORG_ID, serviceName: "svc", taskName: "task",
      });
      await insertTestRunCost({
        runId: noCampaign.id, costName: "token", quantity: "100",
        unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000",
      });

      const res = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "campaignId" });

      expect(res.status).toBe(200);
      const nullGroup = res.body.groups.find((g: any) => g.dimensions.campaignId === null);
      expect(nullGroup).toBeDefined();
      expect(nullGroup.runCount).toBe(1);
      expect(nullGroup.totalCostInUsdCents).toBe("0.2000000000");
    });

    it("counts a run once per brand even with several cost rows", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID, serviceName: "svc", taskName: "task", brandIds: ["brand-multi"],
      });
      await insertTestRunCost({
        runId: run.id, costName: "token", quantity: "100",
        unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000",
      });
      await insertTestRunCost({
        runId: run.id, costName: "compute", quantity: "10",
        unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000",
      });

      const res = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "brandId" });

      expect(res.status).toBe(200);
      const group = res.body.groups.find((g: any) => g.dimensions.brandId === "brand-multi");
      expect(group.runCount).toBe(1);
      expect(group.totalCostInUsdCents).toBe("0.3000000000");
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

    it("surfaces frozen NET alongside gross; pre-freeze / no-discount rows read net == gross", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        campaignId: "camp-net-pub",
      });
      // Discounted actual row (50% off): gross 1.0, frozen net 0.5.
      await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "1000",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "1.0000000000",
        netCostInUsdCents: "0.5000000000",
        usageDiscountPct: "0.50000000",
        status: "actual",
      });
      // Historical row that predates the freeze (net IS NULL) → net falls back to gross.
      await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "400",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.4000000000",
        status: "actual",
      });

      const res = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "campaignId", campaignId: "camp-net-pub" });

      expect(res.status).toBe(200);
      const g = res.body.groups.find((x: any) => x.dimensions.campaignId === "camp-net-pub");
      expect(g).toBeDefined();
      // Gross unchanged (list price).
      expect(g.totalCostInUsdCents).toBe("1.4000000000");
      expect(g.actualCostInUsdCents).toBe("1.4000000000");
      // NET realized = frozen net for discounted row + gross for null-net historical row.
      expect(g.netTotalCostInUsdCents).toBe("0.9000000000"); // 0.5 + 0.4
      expect(g.netActualCostInUsdCents).toBe("0.9000000000");
      expect(g.netProvisionedCostInUsdCents).toBe("0.0000000000");
    });

  });

  describe("GET /v1/stats/public/costs/timeseries", () => {
    const FEATURE = "ts-cold-email";

    it("splits fleet spend into UTC-day buckets across orgs (default interval=day)", async () => {
      const otherOrgId = "99999999-9999-9999-9999-999999999999";
      // Day 1 — two orgs
      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: FEATURE,
        startedAt: new Date("2026-07-01T03:00:00.000Z"),
      });
      const run2 = await insertTestRun({
        organizationId: otherOrgId,
        serviceName: "svc",
        taskName: "task",
        featureSlug: FEATURE,
        startedAt: new Date("2026-07-01T22:00:00.000Z"),
      });
      // Day 3 — one org (day 2 intentionally has no runs → must be absent, never fabricated)
      const run3 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: FEATURE,
        startedAt: new Date("2026-07-03T10:00:00.000Z"),
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
        quantity: "400",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.4000000000",
      });

      const res = await request(app)
        .get("/v1/stats/public/costs/timeseries")
        .query({ featureSlug: FEATURE });

      expect(res.status).toBe(200);
      expect(res.body.interval).toBe("day");
      expect(res.body.timezone).toBe("UTC");
      // Only days with runs appear — no fabricated 2026-07-02 bucket.
      expect(res.body.buckets).toHaveLength(2);
      const [d1, d3] = res.body.buckets;
      expect(d1.period).toBe("2026-07-01");
      expect(d1.totalCostInUsdCents).toBe("0.3000000000");
      expect(d1.runCount).toBe(2);
      expect(d3.period).toBe("2026-07-03");
      expect(d3.totalCostInUsdCents).toBe("0.4000000000");
      expect(d3.runCount).toBe(1);
    });

    it("reconciles: sum of daily buckets equals the untimed public total for the same filter", async () => {
      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: FEATURE,
        startedAt: new Date("2026-08-01T01:00:00.000Z"),
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: FEATURE,
        startedAt: new Date("2026-08-05T01:00:00.000Z"),
      });
      await insertTestRunCost({
        runId: run1.id,
        costName: "token",
        quantity: "123",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.1230000000",
      });
      await insertTestRunCost({
        runId: run2.id,
        costName: "token",
        quantity: "77",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.0770000000",
        status: "provisioned",
      });

      const timed = await request(app)
        .get("/v1/stats/public/costs/timeseries")
        .query({ featureSlug: FEATURE });
      const untimed = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "featureSlug", featureSlug: FEATURE });

      expect(timed.status).toBe(200);
      expect(untimed.status).toBe(200);

      const sumBuckets = timed.body.buckets.reduce(
        (acc: any, b: any) => ({
          total: acc.total.plus(b.totalCostInUsdCents),
          actual: acc.actual.plus(b.actualCostInUsdCents),
          provisioned: acc.provisioned.plus(b.provisionedCostInUsdCents),
        }),
        { total: new Decimal(0), actual: new Decimal(0), provisioned: new Decimal(0) }
      );

      const grp = untimed.body.groups.find((g: any) => g.dimensions.featureSlug === FEATURE);
      expect(grp).toBeDefined();
      expect(sumBuckets.total.toFixed(10)).toBe(grp.totalCostInUsdCents);
      expect(sumBuckets.actual.toFixed(10)).toBe(grp.actualCostInUsdCents);
      expect(sumBuckets.provisioned.toFixed(10)).toBe(grp.provisionedCostInUsdCents);
    });

    it("surfaces frozen NET per bucket; net realized reconciles with the untimed net total", async () => {
      const NETF = "ts-net-feat";
      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: NETF,
        startedAt: new Date("2026-10-01T01:00:00.000Z"),
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: NETF,
        startedAt: new Date("2026-10-02T01:00:00.000Z"),
      });
      // Day 1 — discounted actual: gross 1.0, frozen net 0.5.
      await insertTestRunCost({
        runId: run1.id,
        costName: "token",
        quantity: "1000",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "1.0000000000",
        netCostInUsdCents: "0.5000000000",
        usageDiscountPct: "0.50000000",
        status: "actual",
      });
      // Day 2 — historical actual with no discount frozen (net IS NULL → net == gross).
      await insertTestRunCost({
        runId: run2.id,
        costName: "token",
        quantity: "400",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.4000000000",
        status: "actual",
      });

      const timed = await request(app)
        .get("/v1/stats/public/costs/timeseries")
        .query({ featureSlug: NETF });
      const untimed = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "featureSlug", featureSlug: NETF });

      expect(timed.status).toBe(200);
      expect(timed.body.buckets).toHaveLength(2);
      const [d1, d2] = timed.body.buckets;
      // Gross unchanged.
      expect(d1.totalCostInUsdCents).toBe("1.0000000000");
      expect(d2.totalCostInUsdCents).toBe("0.4000000000");
      // Frozen net: discounted row → 0.5; null-net historical row → gross 0.4.
      expect(d1.netTotalCostInUsdCents).toBe("0.5000000000");
      expect(d1.netActualCostInUsdCents).toBe("0.5000000000");
      expect(d2.netActualCostInUsdCents).toBe("0.4000000000");

      // Reconcile: sum of net-actual buckets == untimed net-actual total for the same filter.
      const sumNet = timed.body.buckets.reduce(
        (acc: Decimal, b: any) => acc.plus(b.netActualCostInUsdCents),
        new Decimal(0)
      );
      const grp = untimed.body.groups.find((g: any) => g.dimensions.featureSlug === NETF);
      expect(grp).toBeDefined();
      expect(sumNet.toFixed(10)).toBe(grp.netActualCostInUsdCents);
      expect(grp.netActualCostInUsdCents).toBe("0.9000000000"); // 0.5 + 0.4
    });

    it("filters by featureSlugs (comma-separated) and excludes other features", async () => {
      const runA = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "ts-feat-a",
        startedAt: new Date("2026-09-01T01:00:00.000Z"),
      });
      const runB = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "ts-feat-b",
        startedAt: new Date("2026-09-01T02:00:00.000Z"),
      });
      const runOther = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "ts-feat-unrelated",
        startedAt: new Date("2026-09-01T03:00:00.000Z"),
      });
      await insertTestRunCost({
        runId: runA.id,
        costName: "token",
        quantity: "10",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.0100000000",
      });
      await insertTestRunCost({
        runId: runB.id,
        costName: "token",
        quantity: "20",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.0200000000",
      });
      await insertTestRunCost({
        runId: runOther.id,
        costName: "token",
        quantity: "999",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.9990000000",
      });

      const res = await request(app)
        .get("/v1/stats/public/costs/timeseries")
        .query({ featureSlugs: "ts-feat-a,ts-feat-b" });

      expect(res.status).toBe(200);
      expect(res.body.buckets).toHaveLength(1);
      expect(res.body.buckets[0].period).toBe("2026-09-01");
      // 0.01 + 0.02, unrelated 0.999 excluded
      expect(res.body.buckets[0].totalCostInUsdCents).toBe("0.0300000000");
      expect(res.body.buckets[0].runCount).toBe(2);
    });

    it("supports interval=month", async () => {
      const runJan = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "ts-month",
        startedAt: new Date("2026-01-15T01:00:00.000Z"),
      });
      const runFeb = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "ts-month",
        startedAt: new Date("2026-02-20T01:00:00.000Z"),
      });
      await insertTestRunCost({
        runId: runJan.id,
        costName: "token",
        quantity: "10",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.0100000000",
      });
      await insertTestRunCost({
        runId: runFeb.id,
        costName: "token",
        quantity: "20",
        unitCostInUsdCents: "0.0010000000",
        totalCostInUsdCents: "0.0200000000",
      });

      const res = await request(app)
        .get("/v1/stats/public/costs/timeseries")
        .query({ featureSlug: "ts-month", interval: "month" });

      expect(res.status).toBe(200);
      expect(res.body.interval).toBe("month");
      expect(res.body.buckets).toHaveLength(2);
      expect(res.body.buckets[0].period).toBe("2026-01-01");
      expect(res.body.buckets[1].period).toBe("2026-02-01");
    });

    it("rejects an invalid interval", async () => {
      const res = await request(app)
        .get("/v1/stats/public/costs/timeseries")
        .query({ interval: "hour" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid interval");
    });

    it("does not require auth", async () => {
      const res = await request(app).get("/v1/stats/public/costs/timeseries");
      expect(res.status).toBe(200);
      expect(res.body.buckets).toBeDefined();
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

    it("combines workflow dynasty filter with other filters", async () => {
      vi.spyOn(dynastyResolver, "resolveWorkflowDynastySlugs").mockResolvedValue([
        "wf-a",
        "wf-a-v2",
      ]);

      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "wf-a",
        brandIds: ["brand-x"],
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        workflowSlug: "wf-a-v2",
        brandIds: ["brand-y"],
      });

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=workflowSlug&workflowDynastySlug=wf-a&brandId=brand-x")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.workflowSlug).toBe("wf-a");
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

    it("multi-dimension groupBy=audienceId,workflowDynastySlug keeps every audienceId that shares a dynasty (runs-service#174)", async () => {
      vi.spyOn(dynastyResolver, "fetchAllWorkflowDynasties").mockResolvedValue([
        { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
      ]);

      const AUD_A = "aud-a";
      const AUD_B = "aud-b";

      // Two distinct audiences both under the SAME dynasty (cold-email), via
      // different versioned slugs. Pre-fix, regroupByDynasty keyed on dynasty
      // alone and collapsed both into one row, dropping one audience.
      const runA1 = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task", workflowSlug: "cold-email", audienceId: AUD_A });
      const runA2 = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task", workflowSlug: "cold-email-v2", audienceId: AUD_A });
      const runB1 = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task", workflowSlug: "cold-email", audienceId: AUD_B });

      await insertTestRunCost({ runId: runA1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: runA2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });
      await insertTestRunCost({ runId: runB1.id, costName: "token", quantity: "300", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.3000000000" });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=audienceId,workflowDynastySlug")
        .set(authHeaders);

      expect(res.status).toBe(200);

      const audAGroup = res.body.groups.find((g: any) => g.dimensions.audienceId === AUD_A && g.dimensions.workflowDynastySlug === "cold-email");
      const audBGroup = res.body.groups.find((g: any) => g.dimensions.audienceId === AUD_B && g.dimensions.workflowDynastySlug === "cold-email");

      // Both audiences survive as their own (audienceId, dynasty) group.
      expect(audAGroup).toBeDefined();
      expect(audBGroup).toBeDefined();

      // Dynasty rollup applied WITHIN each audience: aud-a's two versioned slugs merge.
      expect(audAGroup.totalCostInUsdCents).toBe("0.3000000000");
      expect(audAGroup.runCount).toBe(2);
      expect(audBGroup.totalCostInUsdCents).toBe("0.3000000000");
      expect(audBGroup.runCount).toBe(1);

      // Conservation: per-audience multi-dim total == single-dim groupBy=audienceId total.
      const single = await request(app)
        .get("/v1/stats/costs?groupBy=audienceId")
        .set(authHeaders);
      expect(single.status).toBe(200);
      const singleA = single.body.groups.find((g: any) => g.dimensions.audienceId === AUD_A);
      const singleB = single.body.groups.find((g: any) => g.dimensions.audienceId === AUD_B);
      expect(singleA.totalCostInUsdCents).toBe(audAGroup.totalCostInUsdCents);
      expect(singleB.totalCostInUsdCents).toBe(audBGroup.totalCostInUsdCents);
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

    describe("weekly bucketing", () => {
      it("returns empty weekly array when no runs exist", async () => {
        const res = await request(app).get("/public/stats/runs");

        expect(res.status).toBe(200);
        expect(res.body.weekly).toEqual([]);
      });

      it("buckets a single run into the Monday-anchored ISO week (UTC)", async () => {
        const wed = new Date("2026-01-07T12:00:00Z");
        await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed", startedAt: wed });

        const res = await request(app).get("/public/stats/runs");

        expect(res.status).toBe(200);
        expect(res.body.weekly).toHaveLength(1);
        expect(res.body.weekly[0].period).toBe("2026-01-05");
        expect(res.body.weekly[0].completed).toBe(1);
        expect(res.body.weekly[0].failed).toBe(0);
        expect(res.body.weekly[0].running).toBe(0);
      });

      it("anchors a Monday-00:00:00Z run to its own week, not the previous one", async () => {
        const mon = new Date("2026-01-12T00:00:00Z");
        await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed", startedAt: mon });

        const res = await request(app).get("/public/stats/runs");

        expect(res.status).toBe(200);
        expect(res.body.weekly).toHaveLength(1);
        expect(res.body.weekly[0].period).toBe("2026-01-12");
      });

      it("splits runs in different weeks into separate buckets, ordered ascending", async () => {
        const wk1 = new Date("2026-01-07T12:00:00Z"); // week of 2026-01-05
        const wk2 = new Date("2026-01-12T12:00:00Z"); // week of 2026-01-12
        const wk3 = new Date("2026-01-21T12:00:00Z"); // week of 2026-01-19
        await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed", startedAt: wk1 });
        await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "failed", startedAt: wk2 });
        await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "running", startedAt: wk3 });

        const res = await request(app).get("/public/stats/runs");

        expect(res.status).toBe(200);
        expect(res.body.weekly).toHaveLength(3);
        expect(res.body.weekly[0].period).toBe("2026-01-05");
        expect(res.body.weekly[0].completed).toBe(1);
        expect(res.body.weekly[1].period).toBe("2026-01-12");
        expect(res.body.weekly[1].failed).toBe(1);
        expect(res.body.weekly[2].period).toBe("2026-01-19");
        expect(res.body.weekly[2].running).toBe(1);
      });

      it("sums totalCostInUsdCents per week, excluding cancelled and BYOK rows", async () => {
        const wk1 = new Date("2026-01-07T12:00:00Z");
        const wk2 = new Date("2026-01-14T12:00:00Z");
        const run1 = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed", startedAt: wk1 });
        const run2 = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed", startedAt: wk2 });

        await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000", costSource: "platform", status: "actual" });
        await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "9.9999999999", costSource: "platform", status: "cancelled" });
        await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "8.0000000000", costSource: "org", status: "actual" });
        await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.3500000000", costSource: "platform", status: "actual" });

        const res = await request(app).get("/public/stats/runs");

        expect(res.status).toBe(200);
        expect(res.body.weekly).toHaveLength(2);
        expect(res.body.weekly[0].period).toBe("2026-01-05");
        expect(res.body.weekly[0].totalCostInUsdCents).toBe("0.1000000000");
        expect(res.body.weekly[1].period).toBe("2026-01-12");
        expect(res.body.weekly[1].totalCostInUsdCents).toBe("0.3500000000");
      });

      it("does not over-count week status when a run has multiple cost rows", async () => {
        const wk = new Date("2026-01-07T12:00:00Z");
        const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed", startedAt: wk });
        await insertTestRunCost({ runId: run.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
        await insertTestRunCost({ runId: run.id, costName: "compute", quantity: "10", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });

        const res = await request(app).get("/public/stats/runs");

        expect(res.status).toBe(200);
        expect(res.body.weekly).toHaveLength(1);
        expect(res.body.weekly[0].completed).toBe(1);
        expect(res.body.weekly[0].totalCostInUsdCents).toBe("0.3000000000");
      });

      it("preserves 10-decimal precision in weekly totalCostInUsdCents", async () => {
        const wk = new Date("2026-01-07T12:00:00Z");
        const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed", startedAt: wk });
        await insertTestRunCost({ runId: run.id, costName: "token", quantity: "1", unitCostInUsdCents: "0.0000000123", totalCostInUsdCents: "0.0000000123" });

        const res = await request(app).get("/public/stats/runs");

        expect(res.status).toBe(200);
        expect(res.body.weekly[0].totalCostInUsdCents).toBe("0.0000000123");
      });
    });

    // The monthly series, the weekly series, byStatus and the untimed total are all
    // derived from ONE de-joined UTC-day pass (runs-service#206). These pin the
    // reconciliation invariant that makes that legal: the dated buckets of either
    // grain must sum to the untimed total for the same (here: unfiltered) filter set.
    describe("reconciliation across grains", () => {
      it("sums monthly and weekly buckets to the same untimed total", async () => {
        // Deliberately spread across a week that straddles a month boundary, so the
        // two grains cut the same days differently and can only agree if both are
        // rolled up from the same daily buckets.
        const days = [
          new Date("2026-01-07T12:00:00Z"),
          new Date("2026-01-29T12:00:00Z"),
          new Date("2026-01-31T23:59:59Z"),
          new Date("2026-02-01T00:00:00Z"),
          new Date("2026-02-16T12:00:00Z"),
        ];
        for (const [i, startedAt] of days.entries()) {
          const run = await insertTestRun({
            organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed", startedAt,
          });
          await insertTestRunCost({
            runId: run.id, costName: "token", quantity: "1",
            unitCostInUsdCents: "0.0000000001", totalCostInUsdCents: `0.000000000${i + 1}`,
          });
        }

        const res = await request(app).get("/public/stats/runs");
        expect(res.status).toBe(200);

        const sum = (rows: Array<{ totalCostInUsdCents: string }>) =>
          rows.reduce((acc, row) => acc.plus(row.totalCostInUsdCents), new Decimal(0)).toFixed(10);

        expect(sum(res.body.monthly)).toBe(res.body.totalCostInUsdCents);
        expect(sum(res.body.weekly)).toBe(res.body.totalCostInUsdCents);
        expect(res.body.totalCostInUsdCents).toBe("0.0000000015");

        // Run counts reconcile the same way, per status.
        const counted = (rows: Array<{ completed: number }>) =>
          rows.reduce((acc, row) => acc + row.completed, 0);
        expect(counted(res.body.monthly)).toBe(res.body.byStatus.completed);
        expect(counted(res.body.weekly)).toBe(res.body.byStatus.completed);
        expect(res.body.byStatus.completed).toBe(days.length);
      });

      it("fails loud when a platform cost row carries no frozen run_started_at", async () => {
        // Simulates the migration-0030 backfill being incomplete. Such a row cannot be
        // placed in any dated bucket, so serving it would silently drop its spend from
        // BOTH the dated series and the untimed total — the reconciliation would still
        // "hold" while under-reporting. Refuse instead.
        const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", status: "completed" });
        await insertTestRunCost({
          runId: run.id, costName: "token", quantity: "100",
          unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "1.0000000000",
          runStartedAt: null,
        });

        const res = await request(app).get("/public/stats/runs");
        expect(res.status).toBe(500);
      });
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

  });

  describe("featureSlugs CSV — GET /v1/stats/costs", () => {
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

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });
      await insertTestRunCost({ runId: run3.id, costName: "token", quantity: "300", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.3000000000" });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=featureSlug&featureSlugs=sales-cold-email,sales-cold-email-v2")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);
      const slugs = res.body.groups.map((g: any) => g.dimensions.featureSlug).sort();
      expect(slugs).toEqual(["sales-cold-email", "sales-cold-email-v2"]);
      const totalRunCount = res.body.groups.reduce((acc: number, g: any) => acc + g.runCount, 0);
      expect(totalRunCount).toBe(2);
    });

    it("featureSlugs takes precedence over featureSlug", async () => {
      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "feat-a",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "feat-b",
      });

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.2000000000" });

      // Both featureSlug and featureSlugs provided — featureSlugs wins
      const res = await request(app)
        .get("/v1/stats/costs?groupBy=featureSlug&featureSlug=feat-a&featureSlugs=feat-b")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.featureSlug).toBe("feat-b");
    });

    it("groupBy=featureDynastySlug returns 400 (eradicated concept)", async () => {
      const res = await request(app)
        .get("/v1/stats/costs?groupBy=featureDynastySlug")
        .set(authHeaders);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("featureDynastySlug");
    });

    it("?featureDynastySlug=foo on GET is silently ignored (does not filter)", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        featureSlug: "feat-a",
      });
      await insertTestRunCost({ runId: run.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "0.1000000000" });

      const res = await request(app)
        .get("/v1/stats/costs?groupBy=featureSlug&featureDynastySlug=should-not-affect-result")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].dimensions.featureSlug).toBe("feat-a");
    });
  });

  describe("POST /v1/stats/costs — batched serviceTasks", () => {
    it("returns K buckets in input order matching K serviceTasks", async () => {
      const runA = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "email-gateway",
        taskName: "send",
        workflowSlug: "wf-1",
      });
      const runB = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "image-service",
        taskName: "generate",
        workflowSlug: "wf-1",
      });

      await insertTestRunCost({ runId: runA.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "1.0000000000" });
      await insertTestRunCost({ runId: runB.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "2.0000000000" });

      const res = await request(app)
        .post("/v1/stats/costs")
        .set(authHeaders)
        .send({
          groupBy: "workflowSlug",
          serviceTasks: [
            { serviceName: "email-gateway", taskName: "send" },
            { serviceName: "image-service", taskName: "generate" },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.buckets).toHaveLength(2);
      expect(res.body.buckets[0].serviceName).toBe("email-gateway");
      expect(res.body.buckets[0].taskName).toBe("send");
      expect(res.body.buckets[0].groups).toHaveLength(1);
      expect(res.body.buckets[0].groups[0].dimensions.workflowSlug).toBe("wf-1");
      expect(res.body.buckets[0].groups[0].runCount).toBe(1);
      expect(res.body.buckets[0].groups[0].totalCostInUsdCents).toBe("1.0000000000");

      expect(res.body.buckets[1].serviceName).toBe("image-service");
      expect(res.body.buckets[1].taskName).toBe("generate");
      expect(res.body.buckets[1].groups[0].totalCostInUsdCents).toBe("2.0000000000");
    });

    it("returns empty bucket when no rows match a serviceTask combo", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "email-gateway",
        taskName: "send",
        workflowSlug: "wf-1",
      });
      await insertTestRunCost({ runId: run.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "1.0000000000" });

      const res = await request(app)
        .post("/v1/stats/costs")
        .set(authHeaders)
        .send({
          groupBy: "workflowSlug",
          serviceTasks: [
            { serviceName: "email-gateway", taskName: "send" },
            { serviceName: "nonexistent-service", taskName: "nonexistent-task" },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.buckets).toHaveLength(2);
      expect(res.body.buckets[0].groups).toHaveLength(1);
      expect(res.body.buckets[1].serviceName).toBe("nonexistent-service");
      expect(res.body.buckets[1].groups).toEqual([]);
    });

    it("combines serviceTasks with featureSlugs filter", async () => {
      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "email-gateway",
        taskName: "send",
        featureSlug: "feat-included",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "email-gateway",
        taskName: "send",
        featureSlug: "feat-excluded",
      });

      await insertTestRunCost({ runId: run1.id, costName: "token", quantity: "100", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "1.0000000000" });
      await insertTestRunCost({ runId: run2.id, costName: "token", quantity: "200", unitCostInUsdCents: "0.0010000000", totalCostInUsdCents: "2.0000000000" });

      const res = await request(app)
        .post("/v1/stats/costs")
        .set(authHeaders)
        .send({
          groupBy: "featureSlug",
          featureSlugs: ["feat-included"],
          serviceTasks: [{ serviceName: "email-gateway", taskName: "send" }],
        });

      expect(res.status).toBe(200);
      expect(res.body.buckets).toHaveLength(1);
      expect(res.body.buckets[0].groups).toHaveLength(1);
      expect(res.body.buckets[0].groups[0].dimensions.featureSlug).toBe("feat-included");
      expect(res.body.buckets[0].groups[0].totalCostInUsdCents).toBe("1.0000000000");
    });

    it("rejects empty serviceTasks with 400", async () => {
      const res = await request(app)
        .post("/v1/stats/costs")
        .set(authHeaders)
        .send({
          groupBy: "workflowSlug",
          serviceTasks: [],
        });

      expect(res.status).toBe(400);
    });

    it("rejects dynasty groupBy with 400", async () => {
      const res = await request(app)
        .post("/v1/stats/costs")
        .set(authHeaders)
        .send({
          groupBy: "workflowDynastySlug",
          serviceTasks: [{ serviceName: "email-gateway", taskName: "send" }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("workflowDynastySlug");
    });
  });

});
