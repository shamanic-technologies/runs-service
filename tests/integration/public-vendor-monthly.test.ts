import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { resetPublicVendorMonthlyCache } from "../../src/routes/vendor-costs.js";

// GET /public/stats/runs — vendorMonthly (PUBLIC-VENDOR-COST-1031): the fleet's
// monthly spend at vendor cost, beside the unchanged billed figures. Fleet-wide,
// so this file writes only in 2019 months no other test touches and asserts those.

const ORG = "7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});

const VERSIONS = [
  { costName: "pv-tok", provider: "vercel", servedFrom: "2019-01-01T00:00:00Z", billedUnitCostInUsdCents: "6", vendorUnitCostInUsdCents: "1" },
  { costName: "pv-tok", provider: "vercel", servedFrom: "2019-02-15T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" },
  { costName: "pv-api", provider: "apollo", servedFrom: "2019-01-01T00:00:00Z", billedUnitCostInUsdCents: "10", vendorUnitCostInUsdCents: "4" },
  { costName: "pv-unknown", provider: "acme", servedFrom: "2019-01-01T00:00:00Z", billedUnitCostInUsdCents: "2", vendorUnitCostInUsdCents: null },
];

async function cost(runId: string, costName: string, qty: string, unit: string, createdAt: string, opts: { status?: string; costSource?: string } = {}) {
  await insertTestRunCost({
    runId,
    costName,
    quantity: qty,
    unitCostInUsdCents: unit,
    totalCostInUsdCents: new Decimal(qty).times(unit).toFixed(10),
    status: opts.status ?? "actual",
    costSource: opts.costSource ?? "platform",
    createdAt: new Date(createdAt),
  });
}

describe("GET /public/stats/runs — vendorMonthly", () => {
  const app = createTestApp();

  beforeAll(async () => {
    await cleanTestData([ORG]);
    const run = await insertTestRun({
      organizationId: ORG,
      serviceName: "svc",
      taskName: "task",
      status: "completed",
      startedAt: new Date("2019-01-10T10:00:00Z"),
    });
    const r = run.id;
    // Jan 2019: charged 60 + 20 = 80, vendor 10 + 8 = 18.
    await cost(r, "pv-tok", "10", "6", "2019-01-10T10:00:00Z");
    await cost(r, "pv-api", "2", "10", "2019-01-31T23:59:59Z");
    await cost(r, "pv-api", "1", "10", "2019-01-20T00:00:00Z", { status: "refunded" }); // in no figure
    await cost(r, "pv-api", "1", "10", "2019-01-20T00:00:00Z", { status: "provisioned" }); // in no figure
    await cost(r, "pv-api", "1", "10", "2019-01-20T00:00:00Z", { costSource: "org" }); // BYOK: in no figure
    // Feb 2019: charged 50 + 1000 = 1050, unpriced 2 = 0.19 % → served.
    await cost(r, "pv-tok", "10", "5", "2019-02-20T10:00:00Z");
    await cost(r, "pv-api", "100", "10", "2019-02-20T10:00:00Z");
    await cost(r, "pv-unknown", "1", "2", "2019-02-21T10:00:00Z");
    // Mar 2019: charged 10 + 4 = 14, unpriced 4 = 28.6 % → withheld.
    await cost(r, "pv-api", "1", "10", "2019-03-05T10:00:00Z");
    await cost(r, "pv-unknown", "2", "2", "2019-03-05T10:00:00Z");
  });

  beforeEach(() => {
    resetPublicVendorMonthlyCache();
    catalog.fn.mockReset();
    catalog.fn.mockResolvedValue(VERSIONS);
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("serves vendor cost per UTC month of the charge, withholding a month above 1 % unpriced", async () => {
    const res = await request(app).get("/public/stats/runs");
    expect(res.status).toBe(200);
    expect(res.body.vendorUnavailableReason).toBeNull();
    const by = Object.fromEntries(res.body.vendorMonthly.map((m: any) => [m.month, m]));
    expect(by["2019-01"]).toEqual({
      month: "2019-01",
      chargedCostInUsdCents: "80.0000000000",
      vendorCostInUsdCents: "18.0000000000",
      unpricedChargedCostInUsdCents: "0.0000000000",
      unpricedShare: "0.000000",
      unavailableReason: null,
    });
    expect(by["2019-02"]).toEqual({
      month: "2019-02",
      chargedCostInUsdCents: "1052.0000000000",
      vendorCostInUsdCents: "410.0000000000",
      unpricedChargedCostInUsdCents: "2.0000000000",
      unpricedShare: "0.001901",
      unavailableReason: null,
    });
    expect(by["2019-03"]).toMatchObject({
      chargedCostInUsdCents: "14.0000000000",
      vendorCostInUsdCents: null,
      unpricedChargedCostInUsdCents: "4.0000000000",
      unpricedShare: "0.285714",
    });
    expect(by["2019-03"].unavailableReason).toMatch(/28\.6%/);
    // Oldest first.
    const months = res.body.vendorMonthly.map((m: any) => m.month);
    expect(months).toEqual([...months].sort());
  });

  it("keeps the billed figures unchanged when the vendor catalogue is unreadable", async () => {
    const before = await request(app).get("/public/stats/runs");
    resetPublicVendorMonthlyCache();
    const { VendorCostCatalogError } = await import("../../src/services/vendor-costs.js");
    catalog.fn.mockRejectedValue(new VendorCostCatalogError("down"));
    const res = await request(app).get("/public/stats/runs");
    expect(res.status).toBe(200);
    expect(res.body.vendorMonthly).toBeNull();
    expect(res.body.vendorUnavailableReason).toBe("vendor cost catalogue unreadable");
    const by = (b: any) => b.monthly.find((m: any) => m.month === "2019-01");
    expect(by(res.body)).toEqual(by(before.body));
  });

  it("reads the catalogue once per 5 minutes; a failure is not cached", async () => {
    const { VendorCostCatalogError } = await import("../../src/services/vendor-costs.js");
    catalog.fn.mockRejectedValueOnce(new VendorCostCatalogError("down"));
    expect((await request(app).get("/public/stats/runs")).body.vendorMonthly).toBeNull();
    expect((await request(app).get("/public/stats/runs")).body.vendorMonthly).not.toBeNull();
    expect((await request(app).get("/public/stats/runs")).body.vendorMonthly).not.toBeNull();
    expect(catalog.fn).toHaveBeenCalledTimes(2);
  });
});
