import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { sql } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db, statsDb } from "../../src/db/index.js";
import { vendorTimeseriesSql } from "../../src/routes/vendor-costs.js";
import { buildPublicFilterSql } from "../../src/routes/stats.js";

// GET /internal/stats/costs/timeseries/vendor, fleet read by run-start window
// only (the admin cash forecast's call): the money comes from the cost ledger
// alone by runs_costs.run_started_at (the run's started_at frozen through a JS
// Date, i.e. truncated to the millisecond). It must serve exactly what the
// joined read serves, including runs started within a millisecond of a bound.
//
// Fleet-wide, so everything lives in a window (2031-03) no other test writes.

const ORG_ID = "5c0e8f3a-7b21-4d9e-a6c4-1f2e3d4c5b6a";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});

const VERSIONS = [
  { costName: "ltok", provider: null, servedFrom: "2031-01-01T00:00:00Z", billedUnitCostInUsdCents: "6", vendorUnitCostInUsdCents: "1" },
  { costName: "lunknown", provider: null, servedFrom: "2031-01-01T00:00:00Z", billedUnitCostInUsdCents: "2", vendorUnitCostInUsdCents: null },
];

const API_KEY = { "x-api-key": "test-api-key" };
const A = "2031-03-10T00:00:00.000Z";
const B = "2031-03-12T00:00:00.000Z";

/** A run started at a MICROSECOND instant, then a cost frozen from it the way prod freezes it. */
async function runWithCost(startedAt: string, qty: string, opts: { costName?: string; status?: string; runStartedAt?: null; costSource?: string } = {}) {
  const r = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task", status: "completed" });
  await db.execute(sql`UPDATE runs SET started_at = ${startedAt}::timestamptz WHERE id = ${r.id}`);
  const unit = opts.costName === "lunknown" ? "2" : "6";
  await insertTestRunCost({
    runId: r.id,
    costName: opts.costName ?? "ltok",
    quantity: qty,
    unitCostInUsdCents: unit,
    totalCostInUsdCents: new Decimal(qty).times(unit).toFixed(10),
    status: opts.status ?? "actual",
    costSource: opts.costSource,
    createdAt: new Date("2031-03-13T00:00:00Z"),
    ...(opts.runStartedAt === null ? { runStartedAt: null } : {}),
  });
  return r.id;
}

async function joinedRows(q: { startedAfter?: string; startedBefore?: string; interval: string; tz: string; costSource?: string }) {
  const filterSql = buildPublicFilterSql({ startedAfter: q.startedAfter, startedBefore: q.startedBefore });
  return (await statsDb.execute(
    vendorTimeseriesSql(
      { filterSql, interval: q.interval, timezone: q.tz, groupByCampaign: false, costSource: q.costSource },
      VERSIONS as any,
    ),
  )) as any[];
}

describe("GET /internal/stats/costs/timeseries/vendor — ledger-only fleet read", () => {
  const app = createTestApp();

  beforeAll(async () => {
    await cleanTestData([ORG_ID]);
    catalog.fn.mockResolvedValue(VERSIONS);

    await runWithCost("2031-03-09T23:59:59.999500Z", "1"); // before A, frozen 23:59:59.999 → out
    await runWithCost("2031-03-10T00:00:00.000000Z", "2"); // exactly A → in
    await runWithCost("2031-03-10T00:00:00.300000Z", "4"); // inside A's band → in
    await runWithCost("2031-03-11T10:00:00.123456Z", "8"); // mid-window → in
    await runWithCost("2031-03-11T10:00:00.123456Z", "3", { costName: "lunknown" }); // unpriced
    await runWithCost("2031-03-11T11:00:00Z", "50", { status: "cancelled" }); // in no figure
    await runWithCost("2031-03-11T12:00:00Z", "5", { status: "refunded" });
    await runWithCost("2031-03-11T13:00:00Z", "7", { costSource: "org" }); // BYOK
    await runWithCost("2031-03-12T00:00:00.000000Z", "16"); // exactly B → in
    await runWithCost("2031-03-12T00:00:00.000400Z", "32"); // frozen AT B, started after B → out
    await runWithCost("2031-03-12T00:00:02Z", "64"); // after B → out
    // A run with no cost row is still counted.
    const bare = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task", status: "completed" });
    await db.execute(sql`UPDATE runs SET started_at = '2031-03-11T15:00:00Z' WHERE id = ${bare.id}`);
  });

  afterAll(async () => {
    await cleanTestData([ORG_ID]);
    await closeDb();
  });

  it("decides runs started within a millisecond of a bound by their own start", async () => {
    const res = await request(app)
      .get("/internal/stats/costs/timeseries/vendor")
      .query({ interval: "day", costSource: "platform", startedAfter: A, startedBefore: B })
      .set(API_KEY);
    expect(res.status).toBe(200);
    const byDay = Object.fromEntries(res.body.buckets.map((b: any) => [b.period, b]));
    expect(Object.keys(byDay)).toEqual(["2031-03-10", "2031-03-11", "2031-03-12"]);
    expect(byDay["2031-03-10"]).toMatchObject({ totalCostInUsdCents: "36.0000000000", vendorTotalCostInUsdCents: "6.0000000000", runCount: 2 });
    expect(byDay["2031-03-11"]).toMatchObject({
      totalCostInUsdCents: "54.0000000000",
      vendorTotalCostInUsdCents: "8.0000000000",
      unpricedTotalCostInUsdCents: "6.0000000000",
      refundedCostInUsdCents: "30.0000000000",
      vendorRefundedCostInUsdCents: "5.0000000000",
      unpricedCostNames: ["lunknown"],
      runCount: 6,
    });
    expect(byDay["2031-03-12"]).toMatchObject({ totalCostInUsdCents: "96.0000000000", vendorTotalCostInUsdCents: "16.0000000000", runCount: 1 });
  });

  it.each([
    { interval: "day", tz: "UTC", costSource: "platform", startedAfter: A, startedBefore: B },
    { interval: "day", tz: "UTC", startedAfter: A, startedBefore: B },
    { interval: "day", tz: "America/New_York", startedAfter: "2031-03-09T23:59:59.9996Z", startedBefore: "2031-03-12T00:00:00.0002Z" },
    { interval: "week", tz: "Europe/Paris", costSource: "platform", startedAfter: A },
    { interval: "month", tz: "UTC", startedBefore: B },
  ])("serves exactly the joined read (%o)", async (q) => {
    const res = await request(app)
      .get("/internal/stats/costs/timeseries/vendor")
      .query(q)
      .set(API_KEY);
    expect(res.status).toBe(200);
    const joined = await joinedRows(q);
    const fixed = (v: string) => new Decimal(v).toFixed(10);
    const inWindow = res.body.buckets.filter((b: any) => b.period >= "2031-02-01");
    const joinedInWindow = joined.filter((r) => r.period >= "2031-02-01");
    expect(inWindow.map((b: any) => [b.period, b.totalCostInUsdCents, b.vendorTotalCostInUsdCents, b.unpricedTotalCostInUsdCents, b.refundedCostInUsdCents, b.runCount])).toEqual(
      joinedInWindow.map((r) => [r.period, fixed(r.billed_total), fixed(r.vendor_total), fixed(r.unpriced_total), fixed(r.billed_refunded), Number(r.run_count)]),
    );
  });

  it("falls back to the joined read while a cost row has no frozen run start", async () => {
    const id = await runWithCost("2031-03-11T16:00:00Z", "100", { runStartedAt: null });
    try {
      const res = await request(app)
        .get("/internal/stats/costs/timeseries/vendor")
        .query({ interval: "day", costSource: "platform", startedAfter: A, startedBefore: B })
        .set(API_KEY);
      expect(res.status).toBe(200);
      const day = res.body.buckets.find((b: any) => b.period === "2031-03-11");
      expect(day).toMatchObject({ totalCostInUsdCents: "654.0000000000", runCount: 7 });
    } finally {
      await db.execute(sql`DELETE FROM runs WHERE id = ${id}`);
    }
  });
});
