import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";

// GET /internal/stats/costs/margin/timeseries — the margin read per provider per
// UTC month. Pins the invariant the staff dashboard relies on: a provider's months
// sum to its row on GET /internal/stats/costs/margin, field by field.

const ORG = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});

// "tiny" has a vendor unit cost below 1e-10 cent per unit: each month's unrounded
// vendor sum rounds to 0 on its own, while the lifetime sum rounds to 1e-10. The
// months must still add up to the margin read's figure.
const VERSIONS = [
  { costName: "tok", provider: "vercel", servedFrom: "2026-01-01T00:00:00Z", billedUnitCostInUsdCents: "6", vendorUnitCostInUsdCents: "1" },
  { costName: "tok", provider: "deepseek", servedFrom: "2026-03-15T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" },
  { costName: "api", provider: "apollo", servedFrom: "2026-01-01T00:00:00Z", billedUnitCostInUsdCents: "10", vendorUnitCostInUsdCents: "4" },
  { costName: "tiny", provider: "apollo", servedFrom: "2026-01-01T00:00:00Z", billedUnitCostInUsdCents: "0.0000000001", vendorUnitCostInUsdCents: "0.00000000003" },
  { costName: "unknown", provider: "acme", servedFrom: "2026-01-01T00:00:00Z", billedUnitCostInUsdCents: "2", vendorUnitCostInUsdCents: null },
];

const API_KEY = { "x-api-key": "test-api-key" };
const PATH = "/internal/stats/costs/margin/timeseries";
const MARGIN = "/internal/stats/costs/margin";
const zero = "0.0000000000";

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

const MONEY_FIELDS = [
  "billedCostInUsdCents",
  "netBilledCostInUsdCents",
  "pricedBilledCostInUsdCents",
  "netPricedBilledCostInUsdCents",
  "vendorCostInUsdCents",
  "marginCostInUsdCents",
  "netMarginCostInUsdCents",
  "unpricedBilledCostInUsdCents",
  "netUnpricedBilledCostInUsdCents",
  "refundedCostInUsdCents",
  "vendorRefundedCostInUsdCents",
  "unpricedRefundedCostInUsdCents",
];

describe("GET /internal/stats/costs/margin/timeseries", () => {
  const app = createTestApp();

  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue(VERSIONS);
    const run = await insertTestRun({
      organizationId: ORG,
      serviceName: "svc",
      taskName: "task",
      status: "completed",
      startedAt: new Date("2026-01-10T10:00:00Z"),
    });
    const r = run.id;
    await cost(r, "tok", "10", "6", "2026-01-10T10:00:00Z", { discountPct: "0.1" }); // vercel Jan: 60 (net 54), vendor 10
    await cost(r, "tok", "10", "6", "2026-03-10T10:00:00Z"); // vercel Mar: 60, vendor 10
    await cost(r, "tok", "10", "5", "2026-03-20T10:00:00Z"); // deepseek Mar: 50, vendor 10
    await cost(r, "tok", "3", "7", "2026-03-20T10:00:00Z"); // unpriced 21, provider by date = deepseek
    await cost(r, "api", "2", "10", "2026-01-31T23:59:59Z"); // apollo Jan (UTC): 20, vendor 8
    await cost(r, "api", "1", "10", "2026-02-01T00:00:00Z", { status: "refunded" }); // apollo Feb refunded 10, vendor 4
    await cost(r, "api", "1", "10", "2026-02-01T00:00:00Z", { status: "provisioned" }); // in no figure
    await cost(r, "api", "1", "10", "2026-02-01T00:00:00Z", { costSource: "org" }); // BYOK: in no figure
    for (const at of ["2026-01-05T00:00:00Z", "2026-02-05T00:00:00Z", "2026-03-05T00:00:00Z"]) {
      await cost(r, "tiny", "1", "0.0000000001", at); // apollo: vendor 3e-11 a month
    }
    await cost(r, "unknown", "1", "2", "2026-02-10T10:00:00Z"); // acme Feb unpriced 2
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("splits the margin read per provider per UTC month, dense through the current month", async () => {
    const res = await request(app).get(PATH).query({ orgId: ORG }).set(API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.interval).toBe("month");
    expect(res.body.timezone).toBe("UTC");

    const nowMonth = new Date().toISOString().slice(0, 7) + "-01";
    const periods: string[] = res.body.periods;
    expect(periods.slice(0, 3)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(periods[periods.length - 1]).toBe(nowMonth);

    // Same provider order as the margin read.
    const margin = await request(app).get(MARGIN).query({ orgId: ORG }).set(API_KEY);
    expect(res.body.providers.map((p: any) => p.provider)).toEqual(margin.body.providers.map((p: any) => p.provider));

    const byP = Object.fromEntries(res.body.providers.map((p: any) => [p.provider, p.buckets]));
    for (const buckets of Object.values(byP) as any[][]) {
      expect(buckets.map((b) => b.period)).toEqual(periods);
      expect(buckets.map((b) => b.complete)).toEqual(periods.map((p) => p !== nowMonth));
    }

    expect(byP.vercel[0]).toMatchObject({ billedCostInUsdCents: "60.0000000000", netBilledCostInUsdCents: "54.0000000000", vendorCostInUsdCents: "10.0000000000", marginCostInUsdCents: "50.0000000000" });
    expect(byP.vercel[1]).toMatchObject({ billedCostInUsdCents: zero, vendorCostInUsdCents: zero, unpricedCostNames: [] });
    expect(byP.vercel[2]).toMatchObject({ billedCostInUsdCents: "60.0000000000", vendorCostInUsdCents: "10.0000000000" });
    expect(byP.deepseek[2]).toMatchObject({ billedCostInUsdCents: "71.0000000000", vendorCostInUsdCents: "10.0000000000", unpricedBilledCostInUsdCents: "21.0000000000", unpricedCostNames: ["tok"] });
    // 23:59:59 on Jan 31 UTC stays in January.
    expect(byP.apollo[0]).toMatchObject({ billedCostInUsdCents: "20.0000000001", vendorCostInUsdCents: "8.0000000000" });
    expect(byP.apollo[1]).toMatchObject({ refundedCostInUsdCents: "10.0000000000", vendorRefundedCostInUsdCents: "4.0000000000" });
    expect(byP.acme[1]).toMatchObject({ billedCostInUsdCents: "2.0000000000", marginCostInUsdCents: zero, unpricedBilledCostInUsdCents: "2.0000000000" });
  });

  it("for every provider, its months sum to its margin-read row, field by field (org and fleet)", async () => {
    for (const query of [{ orgId: ORG }, {}]) {
      const [series, margin] = await Promise.all([
        request(app).get(PATH).query(query).set(API_KEY),
        request(app).get(MARGIN).query(query).set(API_KEY),
      ]);
      expect(series.status).toBe(200);
      expect(margin.status).toBe(200);
      expect(series.body.providers.length).toBe(margin.body.providers.length);
      const marginBy = new Map(margin.body.providers.map((p: any) => [p.provider, p]));
      for (const p of series.body.providers) {
        const row: any = marginBy.get(p.provider);
        expect(row).toBeDefined();
        for (const f of MONEY_FIELDS) {
          const sum = p.buckets.reduce((a: Decimal, b: any) => a.plus(b[f]), new Decimal(0));
          expect(`${p.provider} ${f} ${sum.toFixed(10)}`).toBe(`${p.provider} ${f} ${new Decimal(row[f]).toFixed(10)}`);
        }
        for (const b of p.buckets) {
          expect(new Decimal(b.marginCostInUsdCents).plus(b.vendorCostInUsdCents).eq(b.pricedBilledCostInUsdCents)).toBe(true);
        }
      }
    }
  });

  it("telescopes sub-1e-10 vendor costs: months add up to the rounded lifetime figure", async () => {
    const res = await request(app).get(PATH).query({ orgId: ORG }).set(API_KEY);
    const apollo = res.body.providers.find((p: any) => p.provider === "apollo");
    // 3e-11 a month: Jan round(3e-11)=0, Feb round(6e-11)-0=1e-10, Mar round(9e-11)-1e-10=0
    expect(apollo.buckets.slice(0, 3).map((b: any) => b.vendorCostInUsdCents)).toEqual(["8.0000000000", "0.0000000001", zero]);
  });

  it("no rows in scope → no periods, no providers", async () => {
    const res = await request(app).get(PATH).query({ orgId: "6d7e8f9a-0b1c-4d2e-9f3a-4b5c6d7e8f9a" }).set(API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ interval: "month", timezone: "UTC", periods: [], providers: [] });
  });

  it("400 on a malformed orgId, 401 without the service key, 502 when the catalogue is unreadable", async () => {
    expect((await request(app).get(PATH).query({ orgId: "nope" }).set(API_KEY)).status).toBe(400);
    expect((await request(app).get(PATH)).status).toBe(401);
    const { VendorCostCatalogError } = await import("../../src/services/vendor-costs.js");
    catalog.fn.mockRejectedValueOnce(new VendorCostCatalogError("down"));
    expect((await request(app).get(PATH).set(API_KEY)).status).toBe(502);
  });
});
