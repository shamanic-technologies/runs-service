import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";

// GET /internal/stats/costs/vendor — the UNDATED grouped cost aggregation on the
// VENDOR-COST basis, priced per costs-service price version (same rule as the
// vendor timeseries), fleet-wide or org/brand-scoped.

const ORG_A = "5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const ORG_B = "6d2e3f4a-5b6c-4d7e-9f8a-0b1c2d3e4f5a";
const BRAND_A = "7e3f4a5b-6c7d-4e8f-8a9b-1c2d3e4f5a6b";
const BRAND_B = "8f4a5b6c-7d8e-4f9a-9b0c-2d3e4f5a6b7c";
const FEATURE = "vendor-grouped-test-feature";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});
const dynasties = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/dynasty-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/dynasty-resolver.js")>();
  return { ...actual, fetchAllWorkflowDynasties: dynasties.fn };
});

const VERSIONS = [
  { costName: "tok", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "6", vendorUnitCostInUsdCents: "1" },
  { costName: "tok", servedFrom: "2026-09-15T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" },
  { costName: "unknown", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "2", vendorUnitCostInUsdCents: null },
];

const API_KEY = { "x-api-key": "test-api-key" };
const PATH = "/internal/stats/costs/vendor";

async function cost(runId: string, costName: string, qty: string, unit: string, createdAt: string, status = "actual", audienceId?: string) {
  await insertTestRunCost({
    runId,
    costName,
    quantity: qty,
    unitCostInUsdCents: unit,
    totalCostInUsdCents: new Decimal(qty).times(unit).toFixed(10),
    status,
    createdAt: new Date(createdAt),
    audienceId,
  });
}

async function run(org: string, brand: string, workflowSlug: string, audienceId: string, campaignId: string) {
  const r = await insertTestRun({
    organizationId: org,
    serviceName: "svc",
    taskName: "task",
    brandIds: [brand],
    featureSlug: FEATURE,
    workflowSlug,
    audienceId,
    campaignId,
    status: "completed",
    startedAt: new Date("2026-09-10T10:00:00Z"),
  });
  return r.id;
}

const byDim = (groups: any[], key: (d: any) => string) => Object.fromEntries(groups.map((g) => [key(g.dimensions), g]));

describe("GET /internal/stats/costs/vendor", () => {
  const app = createTestApp();
  const CAMP_A = "9a5b6c7d-8e9f-4a0b-8c1d-3e4f5a6b7c8d";
  const CAMP_B = "0b6c7d8e-9f0a-4b1c-9d2e-4f5a6b7c8d9e";

  beforeAll(async () => {
    await cleanTestData([ORG_A, ORG_B]);
    catalog.fn.mockResolvedValue(VERSIONS);
    dynasties.fn.mockResolvedValue([{ dynastySlug: "alpha", slugs: ["alpha", "alpha-v2"] }]);

    // org A, workflow alpha, audience aud-1
    const a1 = await run(ORG_A, BRAND_A, "alpha", "aud-1", CAMP_A);
    await cost(a1, "tok", "10", "6", "2026-09-10T10:00:01Z"); // billed 60, vendor 10
    await cost(a1, "unknown", "1", "2", "2026-09-10T10:00:01Z"); // unpriced 2
    await cost(a1, "tok", "5", "6", "2026-09-10T10:00:01Z", "cancelled"); // never counted
    // org A, workflow alpha-v2 (same dynasty), cost row attributed to aud-2
    const a2 = await run(ORG_A, BRAND_A, "alpha-v2", "aud-1", CAMP_A);
    await cost(a2, "tok", "10", "5", "2026-09-16T10:00:01Z", "actual", "aud-2"); // billed 50, vendor 10
    await cost(a2, "tok", "1", "6", "2026-09-16T10:00:01Z", "refunded", "aud-2"); // no version at 6 after 09-15? -> v1 window still open (per billed price), vendor 1
    // org B, workflow beta
    const b1 = await run(ORG_B, BRAND_B, "beta", "aud-9", CAMP_B);
    await cost(b1, "tok", "3", "7", "2026-09-10T10:00:01Z", "provisioned"); // no version at 7 → unpriced 21
  });

  afterAll(async () => {
    await cleanTestData([ORG_A, ORG_B]);
    await closeDb();
  });

  it("groups the FLEET by workflow slug with vendor and unpriced figures apart", async () => {
    const res = await request(app).get(PATH).query({ groupBy: "workflowSlug", featureSlugs: FEATURE }).set(API_KEY);
    expect(res.status).toBe(200);
    const g = byDim(res.body.groups, (d) => d.workflowSlug);
    expect(Object.keys(g).sort()).toEqual(["alpha", "alpha-v2", "beta"]);
    expect(g.alpha).toMatchObject({
      totalCostInUsdCents: "62.0000000000",
      vendorTotalCostInUsdCents: "10.0000000000",
      unpricedTotalCostInUsdCents: "2.0000000000",
      unpricedCostNames: ["unknown"],
    });
    expect(g["alpha-v2"]).toMatchObject({
      totalCostInUsdCents: "50.0000000000",
      vendorTotalCostInUsdCents: "10.0000000000",
      refundedCostInUsdCents: "6.0000000000",
      vendorRefundedCostInUsdCents: "1.0000000000",
      unpricedTotalCostInUsdCents: "0.0000000000",
      unpricedCostNames: [],
    });
    expect(g.beta).toMatchObject({
      totalCostInUsdCents: "21.0000000000",
      provisionedCostInUsdCents: "21.0000000000",
      vendorTotalCostInUsdCents: "0.0000000000",
      unpricedProvisionedCostInUsdCents: "21.0000000000",
      unpricedCostNames: ["tok"],
    });
    // ordered by billed total desc
    expect(res.body.groups.map((x: any) => x.dimensions.workflowSlug)).toEqual(["alpha", "alpha-v2", "beta"]);
  });

  it("billed totals equal the existing billed reads (public fleet + org-scoped), which carry no vendor figure", async () => {
    const [vendorFleet, pub, vendorOrg, org] = await Promise.all([
      request(app).get(PATH).query({ groupBy: "workflowSlug", featureSlugs: FEATURE }).set(API_KEY),
      request(app).get("/v1/stats/public/costs").query({ groupBy: "workflowSlug", featureSlugs: FEATURE }),
      request(app).get(PATH).query({ groupBy: "workflowSlug", featureSlugs: FEATURE, orgId: ORG_A, brandId: BRAND_A }).set(API_KEY),
      request(app)
        .get("/v1/stats/costs")
        .query({ groupBy: "workflowSlug", featureSlugs: FEATURE, brandId: BRAND_A })
        .set({ ...API_KEY, "x-org-id": ORG_A, "x-user-id": "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f" }),
    ]);
    const pick = (gs: any[]) => Object.fromEntries(gs.map((x) => [x.dimensions.workflowSlug, [x.totalCostInUsdCents, x.refundedCostInUsdCents]]));
    expect(pub.status).toBe(200);
    expect(org.status).toBe(200);
    expect(pick(vendorFleet.body.groups)).toEqual(pick(pub.body.groups));
    expect(pick(vendorOrg.body.groups)).toEqual(pick(org.body.groups));
    expect(Object.keys(pick(vendorOrg.body.groups)).sort()).toEqual(["alpha", "alpha-v2"]);
    expect(JSON.stringify(pub.body) + JSON.stringify(org.body)).not.toMatch(/vendor|unpriced/i);
  });

  it("answers audience x workflow on the cost-row attribution, like the billed read", async () => {
    const q = { groupBy: "audienceId,workflowSlug", featureSlugs: FEATURE, orgId: ORG_A };
    const [res, billed] = await Promise.all([
      request(app).get(PATH).query(q).set(API_KEY),
      request(app)
        .get("/v1/stats/costs")
        .query({ groupBy: "audienceId,workflowSlug", featureSlugs: FEATURE })
        .set({ ...API_KEY, "x-org-id": ORG_A, "x-user-id": "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f" }),
    ]);
    expect(res.status).toBe(200);
    const g = byDim(res.body.groups, (d) => `${d.audienceId}|${d.workflowSlug}`);
    expect(Object.keys(g).sort()).toEqual(["aud-1|alpha", "aud-2|alpha-v2"]);
    expect(g["aud-2|alpha-v2"].vendorTotalCostInUsdCents).toBe("10.0000000000");
    const billedPick = Object.fromEntries(
      billed.body.groups.map((x: any) => [`${x.dimensions.audienceId}|${x.dimensions.workflowSlug}`, x.totalCostInUsdCents]),
    );
    for (const [k, v] of Object.entries(g)) expect((v as any).totalCostInUsdCents).toBe(billedPick[k]);
  });

  it("filters by audience and groups by campaign", async () => {
    const res = await request(app)
      .get(PATH)
      .query({ groupBy: "campaignId", featureSlugs: FEATURE, audienceId: "aud-2" })
      .set(API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0]).toMatchObject({ dimensions: { campaignId: CAMP_A }, totalCostInUsdCents: "50.0000000000" });
  });

  it("rolls versioned slugs into their dynasty, summing every figure", async () => {
    const res = await request(app)
      .get(PATH)
      .query({ groupBy: "workflowDynastySlug", featureSlugs: FEATURE, orgId: ORG_A })
      .set(API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0]).toMatchObject({
      dimensions: { workflowDynastySlug: "alpha" },
      totalCostInUsdCents: "112.0000000000",
      vendorTotalCostInUsdCents: "20.0000000000",
      unpricedTotalCostInUsdCents: "2.0000000000",
      vendorRefundedCostInUsdCents: "1.0000000000",
      unpricedCostNames: ["unknown"],
    });
  });

  it("refuses a caller without the service api key, and bad groupBy", async () => {
    const none = await request(app).get(PATH).query({ groupBy: "workflowSlug" });
    expect(none.status).toBe(401);
    expect(JSON.stringify(none.body)).not.toMatch(/vendor/i);
    const bad = await request(app).get(PATH).query({ groupBy: "goal" }).set(API_KEY);
    expect(bad.status).toBe(400);
    const missing = await request(app).get(PATH).set(API_KEY);
    expect(missing.status).toBe(400);
  });

  it("fails loud (502) when the vendor catalogue cannot be read", async () => {
    const { VendorCostCatalogError } = await import("../../src/services/vendor-costs.js");
    catalog.fn.mockRejectedValueOnce(new VendorCostCatalogError("costs-service vendor catalogue returned 503: down"));
    const res = await request(app).get(PATH).query({ groupBy: "workflowSlug", featureSlugs: FEATURE }).set(API_KEY);
    expect(res.status).toBe(502);
  });
});
