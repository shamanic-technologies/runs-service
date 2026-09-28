import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";

// GET /internal/stats/costs/timeseries/vendor — the dated spend of the public
// timeseries on the VENDOR-COST basis, priced per costs-service price version.

const ORG_ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const BRAND_ID = "8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";
const FEATURE = "vendor-basis-test-feature";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});

// "tok": marked up 6x, then 5x from 09-15, then a new vendor price (1.2) whose
// billed figure lands back on 6 from 09-20 — the same billed price as v1 with a
// DIFFERENT vendor cost, so pricing by billed price alone would be wrong.
const VERSIONS = [
  { costName: "tok", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "6", vendorUnitCostInUsdCents: "1" },
  { costName: "tok", servedFrom: "2026-09-15T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" },
  { costName: "tok", servedFrom: "2026-09-20T00:00:00Z", billedUnitCostInUsdCents: "6", vendorUnitCostInUsdCents: "1.2" },
  // pass-through: billed == vendor
  { costName: "passthru", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "3", vendorUnitCostInUsdCents: "3" },
  // a version whose vendor cost costs-service cannot state
  { costName: "unknown", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "2", vendorUnitCostInUsdCents: null },
  // delisted: no billable price — never matches a row
  { costName: "passthru", servedFrom: "2026-09-25T00:00:00Z", billedUnitCostInUsdCents: null, vendorUnitCostInUsdCents: null },
];

const API_KEY = { "x-api-key": "test-api-key" };
const QUERY = { interval: "day", orgId: ORG_ID, brandId: BRAND_ID, featureSlugs: FEATURE };

async function cost(runId: string, costName: string, qty: string, unit: string, createdAt: string, status = "actual") {
  await insertTestRunCost({
    runId,
    costName,
    quantity: qty,
    unitCostInUsdCents: unit,
    totalCostInUsdCents: new Decimal(qty).times(unit).toFixed(10),
    status,
    createdAt: new Date(createdAt),
  });
}

async function run(startedAt: string) {
  const r = await insertTestRun({
    organizationId: ORG_ID,
    serviceName: "svc",
    taskName: "task",
    brandIds: [BRAND_ID],
    featureSlug: FEATURE,
    status: "completed",
    startedAt: new Date(startedAt),
  });
  return r.id;
}

describe("GET /internal/stats/costs/timeseries/vendor", () => {
  const app = createTestApp();

  beforeAll(async () => {
    await cleanTestData([ORG_ID]);
    catalog.fn.mockResolvedValue(VERSIONS);

    const r1 = await run("2026-09-10T10:00:00Z");
    await cost(r1, "tok", "10", "6", "2026-09-10T10:00:01Z"); // vendor 10
    await cost(r1, "passthru", "2", "3", "2026-09-10T10:00:01Z"); // vendor 6
    await cost(r1, "unknown", "1", "2", "2026-09-10T10:00:01Z"); // unpriced 2
    await cost(r1, "tok", "5", "6", "2026-09-10T10:00:01Z", "cancelled"); // never counted

    const r2 = await run("2026-09-16T10:00:00Z");
    await cost(r2, "tok", "10", "5", "2026-09-16T10:00:01Z"); // vendor 10 (5x era)

    const r3 = await run("2026-09-21T10:00:00Z");
    await cost(r3, "tok", "10", "6", "2026-09-21T10:00:01Z"); // vendor 12 (v3, not v1)
    await cost(r3, "tok", "1", "7", "2026-09-21T10:00:01Z", "provisioned"); // no version at 7 → unpriced 7
    await cost(r3, "tok", "1", "6", "2026-09-21T10:00:01Z", "refunded"); // vendor refunded 1.2
  });

  afterAll(async () => {
    await cleanTestData([ORG_ID]);
    await closeDb();
  });

  it("prices each row by the version in force for its billed price, and states unpriced spend", async () => {
    const res = await request(app).get("/internal/stats/costs/timeseries/vendor").query(QUERY).set(API_KEY);
    expect(res.status).toBe(200);
    const byDay = Object.fromEntries(res.body.buckets.map((b: any) => [b.period, b]));
    expect(Object.keys(byDay)).toEqual(["2026-09-10", "2026-09-16", "2026-09-21"]);

    expect(byDay["2026-09-10"]).toMatchObject({
      totalCostInUsdCents: "68.0000000000",
      vendorTotalCostInUsdCents: "16.0000000000",
      unpricedTotalCostInUsdCents: "2.0000000000",
      unpricedCostNames: ["unknown"],
      runCount: 1,
    });
    expect(byDay["2026-09-16"]).toMatchObject({
      totalCostInUsdCents: "50.0000000000",
      vendorTotalCostInUsdCents: "10.0000000000",
      unpricedTotalCostInUsdCents: "0.0000000000",
      unpricedCostNames: [],
    });
    expect(byDay["2026-09-21"]).toMatchObject({
      totalCostInUsdCents: "67.0000000000",
      actualCostInUsdCents: "60.0000000000",
      vendorTotalCostInUsdCents: "12.0000000000",
      vendorActualCostInUsdCents: "12.0000000000",
      vendorProvisionedCostInUsdCents: "0.0000000000",
      unpricedTotalCostInUsdCents: "7.0000000000",
      unpricedProvisionedCostInUsdCents: "7.0000000000",
      vendorRefundedCostInUsdCents: "1.2000000000",
      unpricedCostNames: ["tok"],
    });
  });

  it("billed totals equal the public timeseries byte-for-byte, which carries no vendor figure", async () => {
    const [vendor, pub] = await Promise.all([
      request(app).get("/internal/stats/costs/timeseries/vendor").query(QUERY).set(API_KEY),
      request(app).get("/v1/stats/public/costs/timeseries").query(QUERY),
    ]);
    expect(pub.status).toBe(200);
    expect(vendor.body.buckets.map((b: any) => [b.period, b.totalCostInUsdCents, b.runCount])).toEqual(
      pub.body.buckets.map((b: any) => [b.period, b.totalCostInUsdCents, b.runCount]),
    );
    expect(JSON.stringify(pub.body)).not.toMatch(/vendor|unpriced/i);
    // priced billed + unpriced billed == billed, per bucket
    for (const b of vendor.body.buckets) {
      expect(new Decimal(b.totalCostInUsdCents).minus(b.unpricedTotalCostInUsdCents).gte(0)).toBe(true);
    }
  });

  it("refuses a caller without the service api key", async () => {
    const none = await request(app).get("/internal/stats/costs/timeseries/vendor").query(QUERY);
    expect(none.status).toBe(401);
    expect(JSON.stringify(none.body)).not.toMatch(/vendor/i);
    const wrong = await request(app)
      .get("/internal/stats/costs/timeseries/vendor")
      .query(QUERY)
      .set({ "x-api-key": "not-the-key" });
    expect(wrong.status).toBe(401);
  });

  it("groups by campaign when asked, like the public twin", async () => {
    const res = await request(app)
      .get("/internal/stats/costs/timeseries/vendor")
      .query({ ...QUERY, groupBy: "campaignId" })
      .set(API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.buckets.every((b: any) => "campaignId" in b)).toBe(true);
  });

  describe("GET /internal/runs/vendor", () => {
    const RUNS_QUERY = { orgId: ORG_ID, brandId: BRAND_ID, featureSlug: FEATURE, taskName: "task" };

    it("states each run's own cost on the vendor basis, with unpriced spend named", async () => {
      const res = await request(app).get("/internal/runs/vendor").query(RUNS_QUERY).set(API_KEY);
      expect(res.status).toBe(200);
      const rows = res.body.runs.map((r: any) => [
        r.startedAt.slice(0, 10),
        r.ownCostInUsdCents,
        r.vendorOwnCostInUsdCents,
        r.vendorOwnActualCostInUsdCents,
        r.vendorOwnProvisionedCostInUsdCents,
        r.unpricedOwnCostInUsdCents,
        r.unpricedCostNames,
      ]);
      expect(rows).toEqual([
        ["2026-09-21", "67.0000000000", "12.0000000000", "12.0000000000", "0.0000000000", "7.0000000000", ["tok"]],
        ["2026-09-16", "50.0000000000", "10.0000000000", "10.0000000000", "0.0000000000", "0.0000000000", []],
        ["2026-09-10", "68.0000000000", "16.0000000000", "16.0000000000", "0.0000000000", "2.0000000000", ["unknown"]],
      ]);
    });

    it("serves GET /v1/runs' runs, order, page and billed fields byte-for-byte; the billed list carries no vendor figure", async () => {
      const { orgId: _o, ...listQuery } = RUNS_QUERY;
      for (const extra of [{}, { limit: "2" }, { limit: "1", offset: "1" }]) {
        const [vendor, billed] = await Promise.all([
          request(app).get("/internal/runs/vendor").query({ ...RUNS_QUERY, ...extra }).set(API_KEY),
          request(app).get("/v1/runs").query({ ...listQuery, ...extra }).set({ ...API_KEY, "x-org-id": ORG_ID }),
        ]);
        expect(billed.status).toBe(200);
        expect(vendor.status).toBe(200);
        for (const r of billed.body.runs) expect(Object.keys(r).filter((k) => /vendor|unpriced/i.test(k))).toEqual([]);
        const strip = (r: any) => {
          const { vendorOwnCostInUsdCents, vendorOwnActualCostInUsdCents, vendorOwnProvisionedCostInUsdCents,
            unpricedOwnCostInUsdCents, unpricedOwnActualCostInUsdCents, unpricedOwnProvisionedCostInUsdCents,
            unpricedCostNames, ...rest } = r;
          return rest;
        };
        expect({ ...vendor.body, runs: vendor.body.runs.map(strip) }).toEqual(billed.body);
      }
    });

    it("a run with no cost rows reads 0 on both bases", async () => {
      const empty = await run("2026-09-22T10:00:00Z");
      const res = await request(app).get("/internal/runs/vendor").query({ ...RUNS_QUERY, limit: "1" }).set(API_KEY);
      expect(res.body.runs[0]).toMatchObject({
        id: empty,
        ownCostInUsdCents: "0.0000000000",
        vendorOwnCostInUsdCents: "0.0000000000",
        unpricedOwnCostInUsdCents: "0.0000000000",
        unpricedCostNames: [],
      });
    });

    it("requires orgId and the service api key", async () => {
      const noOrg = await request(app).get("/internal/runs/vendor").query({ brandId: BRAND_ID }).set(API_KEY);
      expect(noOrg.status).toBe(400);
      const noKey = await request(app).get("/internal/runs/vendor").query(RUNS_QUERY);
      expect(noKey.status).toBe(401);
      expect(JSON.stringify(noKey.body)).not.toMatch(/vendor/i);
    });

    it("fails loud (502) when the vendor catalogue cannot be read", async () => {
      const { VendorCostCatalogError } = await import("../../src/services/vendor-costs.js");
      catalog.fn.mockRejectedValueOnce(new VendorCostCatalogError("costs-service vendor catalogue returned 503: down"));
      const res = await request(app).get("/internal/runs/vendor").query(RUNS_QUERY).set(API_KEY);
      expect(res.status).toBe(502);
    });
  });

  it("fails loud (502) when the vendor catalogue cannot be read — never serves it all as unpriced", async () => {
    const { VendorCostCatalogError } = await import("../../src/services/vendor-costs.js");
    catalog.fn.mockRejectedValueOnce(new VendorCostCatalogError("costs-service vendor catalogue returned 503: down"));
    const res = await request(app).get("/internal/stats/costs/timeseries/vendor").query(QUERY).set(API_KEY);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/503/);
  });
});
