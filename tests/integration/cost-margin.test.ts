import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";

// GET /internal/stats/costs/margin — platform billed vs vendor cost and margin,
// per provider, per (provider, cost item) and in total.

const ORG = "3a4b5c6d-7e8f-4a9b-8c0d-1e2f3a4b5c6d";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});

// "tok" moves vendor on 09-15 (via vercel, then direct), as deepseek did in prod.
const VERSIONS = [
  { costName: "tok", provider: "vercel", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "6", vendorUnitCostInUsdCents: "1" },
  { costName: "tok", provider: "deepseek", servedFrom: "2026-09-15T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" },
  { costName: "unknown", provider: "acme", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "2", vendorUnitCostInUsdCents: null },
  { costName: "api", provider: "apollo", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "10", vendorUnitCostInUsdCents: "4" },
];

const API_KEY = { "x-api-key": "test-api-key" };
const PATH = "/internal/stats/costs/margin";

async function cost(runId: string, costName: string, qty: string, unit: string, createdAt: string, opts: { status?: string; costSource?: string; discountPct?: string } = {}) {
  const gross = new Decimal(qty).times(unit);
  await insertTestRunCost({
    runId,
    costName,
    quantity: qty,
    unitCostInUsdCents: unit,
    totalCostInUsdCents: gross.toFixed(10),
    ...(opts.discountPct && {
      netCostInUsdCents: gross.times(new Decimal(1).minus(opts.discountPct)).toFixed(10),
      usageDiscountPct: opts.discountPct,
    }),
    status: opts.status ?? "actual",
    costSource: opts.costSource ?? "platform",
    createdAt: new Date(createdAt),
  });
}

const zero = "0.0000000000";

describe("GET /internal/stats/costs/margin", () => {
  const app = createTestApp();

  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue(VERSIONS);
    const run = await insertTestRun({
      organizationId: ORG,
      serviceName: "svc",
      taskName: "task",
      status: "completed",
      startedAt: new Date("2026-09-10T10:00:00Z"),
    });
    const r = run.id;
    await cost(r, "tok", "10", "6", "2026-09-10T10:00:01Z", { discountPct: "0.1" }); // vercel: 60 (net 54), vendor 10
    await cost(r, "tok", "10", "5", "2026-09-16T10:00:01Z"); // deepseek: 50, vendor 10
    await cost(r, "tok", "3", "7", "2026-09-16T10:00:01Z"); // no version at 7 → unpriced 21, provider by date = deepseek
    await cost(r, "unknown", "1", "2", "2026-09-10T10:00:01Z"); // acme, vendor unknown → unpriced 2
    await cost(r, "api", "2", "10", "2026-09-10T10:00:01Z"); // apollo: 20, vendor 8
    await cost(r, "api", "1", "10", "2026-09-10T10:00:01Z", { status: "refunded" }); // refunded 10, vendor 4
    await cost(r, "api", "1", "10", "2026-09-10T10:00:01Z", { status: "provisioned" }); // hold: in no figure
    await cost(r, "api", "1", "10", "2026-09-10T10:00:01Z", { status: "cancelled" }); // in no figure
    await cost(r, "api", "1", "10", "2026-09-10T10:00:01Z", { costSource: "org" }); // BYOK: in no figure
    await cost(r, "mystery", "1", "3", "2026-09-10T10:00:01Z"); // never listed → provider null, unpriced 3
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("states billed, vendor, margin and unpriced per provider, per cost item and in total", async () => {
    const res = await request(app).get(PATH).query({ orgId: ORG }).set(API_KEY);
    expect(res.status).toBe(200);

    expect(res.body.total).toEqual({
      billedCostInUsdCents: "156.0000000000",
      netBilledCostInUsdCents: "150.0000000000",
      pricedBilledCostInUsdCents: "130.0000000000",
      netPricedBilledCostInUsdCents: "124.0000000000",
      vendorCostInUsdCents: "28.0000000000",
      marginCostInUsdCents: "102.0000000000",
      netMarginCostInUsdCents: "96.0000000000",
      unpricedBilledCostInUsdCents: "26.0000000000",
      netUnpricedBilledCostInUsdCents: "26.0000000000",
      refundedCostInUsdCents: "10.0000000000",
      vendorRefundedCostInUsdCents: "4.0000000000",
      unpricedRefundedCostInUsdCents: zero,
      unpricedCostNames: ["mystery", "tok", "unknown"],
    });

    const p = Object.fromEntries(res.body.providers.map((x: any) => [x.provider, x]));
    expect(res.body.providers.map((x: any) => x.provider)).toEqual(["deepseek", "vercel", "apollo", null, "acme"]);
    expect(p.deepseek).toMatchObject({
      billedCostInUsdCents: "71.0000000000",
      pricedBilledCostInUsdCents: "50.0000000000",
      vendorCostInUsdCents: "10.0000000000",
      marginCostInUsdCents: "40.0000000000",
      unpricedBilledCostInUsdCents: "21.0000000000",
      unpricedCostNames: ["tok"],
    });
    expect(p.vercel).toMatchObject({
      billedCostInUsdCents: "60.0000000000",
      netBilledCostInUsdCents: "54.0000000000",
      vendorCostInUsdCents: "10.0000000000",
      marginCostInUsdCents: "50.0000000000",
      netMarginCostInUsdCents: "44.0000000000",
      unpricedCostNames: [],
    });
    expect(p.apollo).toMatchObject({
      billedCostInUsdCents: "20.0000000000",
      vendorCostInUsdCents: "8.0000000000",
      marginCostInUsdCents: "12.0000000000",
      refundedCostInUsdCents: "10.0000000000",
      vendorRefundedCostInUsdCents: "4.0000000000",
    });
    // Unpriced spend is never margin at zero vendor cost.
    expect(p.acme).toMatchObject({ billedCostInUsdCents: "2.0000000000", marginCostInUsdCents: zero, unpricedBilledCostInUsdCents: "2.0000000000" });
    expect(p.null).toMatchObject({ billedCostInUsdCents: "3.0000000000", marginCostInUsdCents: zero, unpricedCostNames: ["mystery"] });

    const items = res.body.costItems.map((x: any) => [x.provider, x.costName, x.billedCostInUsdCents]);
    expect(items).toEqual([
      ["deepseek", "tok", "71.0000000000"],
      ["vercel", "tok", "60.0000000000"],
      ["apollo", "api", "20.0000000000"],
      [null, "mystery", "3.0000000000"],
      ["acme", "unknown", "2.0000000000"],
    ]);
  });

  it("holds margin + vendor == priced billed, and billed == priced + unpriced, on every row of the fleet read", async () => {
    const res = await request(app).get(PATH).set(API_KEY);
    expect(res.status).toBe(200);
    const all = [res.body.total, ...res.body.providers, ...res.body.costItems];
    for (const row of all) {
      expect(new Decimal(row.marginCostInUsdCents).plus(row.vendorCostInUsdCents).eq(row.pricedBilledCostInUsdCents)).toBe(true);
      expect(new Decimal(row.netMarginCostInUsdCents).plus(row.vendorCostInUsdCents).eq(row.netPricedBilledCostInUsdCents)).toBe(true);
      expect(new Decimal(row.pricedBilledCostInUsdCents).plus(row.unpricedBilledCostInUsdCents).eq(row.billedCostInUsdCents)).toBe(true);
    }
    const sum = (rows: any[]) => rows.reduce((a, x) => a.plus(x.billedCostInUsdCents), new Decimal(0));
    expect(sum(res.body.providers).eq(res.body.total.billedCostInUsdCents)).toBe(true);
    expect(sum(res.body.costItems).eq(res.body.total.billedCostInUsdCents)).toBe(true);
  });

  it("an org with no cost rows gets a zero total and no rows", async () => {
    const res = await request(app).get(PATH).query({ orgId: "4b5c6d7e-8f9a-4b0c-9d1e-2f3a4b5c6d7e" }).set(API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.total.billedCostInUsdCents).toBe(zero);
    expect(res.body.total.unpricedCostNames).toEqual([]);
    expect(res.body.providers).toEqual([]);
    expect(res.body.costItems).toEqual([]);
  });

  it("400 on a malformed orgId, 401 without the service key, 502 when the catalogue is unreadable", async () => {
    expect((await request(app).get(PATH).query({ orgId: "nope" }).set(API_KEY)).status).toBe(400);
    expect((await request(app).get(PATH)).status).toBe(401);
    const { VendorCostCatalogError } = await import("../../src/services/vendor-costs.js");
    catalog.fn.mockRejectedValueOnce(new VendorCostCatalogError("down"));
    expect((await request(app).get(PATH).set(API_KEY)).status).toBe(502);
  });
});
