import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";

// VENDOR-UNPRICED-1117: a version offers two prices since costs-service PRICE-X1-1029, the
// grandfathered (x2) billed price and the standard (x1) one. A row billed on the x1 list must
// match its version's vendor cost exactly like a row billed on the x2 list.

const ORG_ID = "5c1d7e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const BRAND_ID = "6d2e8f3a-4b5c-4d6e-9f7a-8b9c0d1e2f3a";
const FEATURE = "vendor-standard-price-test-feature";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});

// "tok": v1 x2 = 4, x1 = 2, vendor 1. v2 from 11-10: vendor 1.5, x2 = 6, x1 = 3.
// "pass": pass-through, both lists = vendor = 3 (one candidate, never counted twice).
// "old": a version stated before the x1 list, no x1 price.
const VERSIONS = [
  { costName: "tok", provider: "p", servedFrom: "2026-11-01T00:00:00Z", billedUnitCostInUsdCents: "4", standardUnitCostInUsdCents: "2", vendorUnitCostInUsdCents: "1" },
  { costName: "tok", provider: "p", servedFrom: "2026-11-10T00:00:00Z", billedUnitCostInUsdCents: "6", standardUnitCostInUsdCents: "3", vendorUnitCostInUsdCents: "1.5" },
  { costName: "pass", provider: "p", servedFrom: "2026-11-01T00:00:00Z", billedUnitCostInUsdCents: "3", standardUnitCostInUsdCents: "3.0000000000", vendorUnitCostInUsdCents: "3" },
  { costName: "old", provider: "p", servedFrom: "2026-11-01T00:00:00Z", billedUnitCostInUsdCents: "5", standardUnitCostInUsdCents: null, vendorUnitCostInUsdCents: "1" },
];

const API_KEY = { "x-api-key": "test-api-key" };
const QUERY = { interval: "day", orgId: ORG_ID, brandId: BRAND_ID, featureSlugs: FEATURE };

async function cost(runId: string, costName: string, qty: string, unit: string, createdAt: string) {
  await insertTestRunCost({
    runId,
    costName,
    quantity: qty,
    unitCostInUsdCents: unit,
    totalCostInUsdCents: new Decimal(qty).times(unit).toFixed(10),
    status: "actual",
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

describe("vendor basis: a row billed on the standard (x1) list", () => {
  const app = createTestApp();

  beforeAll(async () => {
    await cleanTestData([ORG_ID]);
    catalog.fn.mockResolvedValue(VERSIONS);

    const r1 = await run("2026-11-05T10:00:00Z");
    await cost(r1, "tok", "10", "4", "2026-11-05T10:00:01Z"); // x2 row: vendor 10
    await cost(r1, "tok", "10", "2", "2026-11-05T10:00:01Z"); // x1 row: vendor 10
    await cost(r1, "pass", "2", "3", "2026-11-05T10:00:01Z"); // vendor 6, once
    await cost(r1, "old", "1", "5", "2026-11-05T10:00:01Z"); // vendor 1

    const r2 = await run("2026-11-12T10:00:00Z");
    await cost(r2, "tok", "10", "3", "2026-11-12T10:00:01Z"); // x1 of v2: vendor 15
    await cost(r2, "tok", "1", "7", "2026-11-12T10:00:01Z"); // no version at 7: unpriced 7
  });

  afterAll(async () => {
    await cleanTestData([ORG_ID]);
    await closeDb();
  });

  it("prices x1 rows at their version's vendor cost, exactly like x2 rows", async () => {
    const res = await request(app).get("/internal/stats/costs/timeseries/vendor").query(QUERY).set(API_KEY);
    expect(res.status).toBe(200);
    const byDay = Object.fromEntries(res.body.buckets.map((b: any) => [b.period, b]));
    expect(byDay["2026-11-05"]).toMatchObject({
      totalCostInUsdCents: "71.0000000000",
      vendorTotalCostInUsdCents: "27.0000000000",
      unpricedTotalCostInUsdCents: "0.0000000000",
      unpricedCostNames: [],
    });
    expect(byDay["2026-11-12"]).toMatchObject({
      totalCostInUsdCents: "37.0000000000",
      vendorTotalCostInUsdCents: "15.0000000000",
      unpricedTotalCostInUsdCents: "7.0000000000",
      unpricedCostNames: ["tok"],
    });
  });

  it("the grouped vendor read agrees", async () => {
    const res = await request(app)
      .get("/internal/stats/costs/vendor")
      .query({ orgId: ORG_ID, featureSlugs: FEATURE, groupBy: "costName" })
      .set(API_KEY);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.groups.map((g: any) => [g.dimensions.costName, g]));
    expect(byName.tok).toMatchObject({ vendorTotalCostInUsdCents: "35.0000000000", unpricedTotalCostInUsdCents: "7.0000000000" });
    expect(byName.pass).toMatchObject({ vendorTotalCostInUsdCents: "6.0000000000", unpricedTotalCostInUsdCents: "0.0000000000" });
    expect(byName.old).toMatchObject({ vendorTotalCostInUsdCents: "1.0000000000", unpricedTotalCostInUsdCents: "0.0000000000" });
  });
});
