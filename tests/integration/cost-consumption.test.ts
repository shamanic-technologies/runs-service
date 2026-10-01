import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { Decimal } from "decimal.js";

// GET /internal/stats/costs/consumption — units consumed per UTC day per cost
// name, fleet-wide, platform key and org key apart. costs-service divides a vendor
// subscription's bank spend by these units. Cost names are unique to this file so
// rows written by files sharing the shard never enter the figures.

const ORG_A = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ORG_B = "8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";
const BRAND_1 = "consumption-brand-1";
const BRAND_2 = "consumption-brand-2";
const APOLLO = "consumption-test-apollo-credit";
const SERPER = "consumption-test-serper-query";
const API_KEY = { "x-api-key": "test-api-key" };
const PATH = "/internal/stats/costs/consumption";

// Unit price 2 cents; net = 90% of gross when a discount is given.
async function cost(runId: string, costName: string, qty: string, createdAt: string, opts: { status?: string; costSource?: string; discounted?: boolean } = {}) {
  const gross = new Decimal(qty).times(2);
  await insertTestRunCost({
    runId,
    costName,
    quantity: qty,
    unitCostInUsdCents: "2",
    totalCostInUsdCents: gross.toFixed(10),
    ...(opts.discounted && { netCostInUsdCents: gross.times("0.9").toFixed(10), usageDiscountPct: "0.1" }),
    status: opts.status ?? "actual",
    costSource: opts.costSource ?? "platform",
    createdAt: new Date(createdAt),
  });
}

describe("GET /internal/stats/costs/consumption", () => {
  const app = createTestApp();

  beforeAll(async () => {
    await cleanTestData([ORG_A, ORG_B]);
    const a = await insertTestRun({ organizationId: ORG_A, serviceName: "svc", taskName: "t", status: "completed", brandIds: [BRAND_1, BRAND_2] });
    const b = await insertTestRun({ organizationId: ORG_B, serviceName: "svc", taskName: "t", status: "completed" });
    await cost(a.id, APOLLO, "3", "2026-01-10T10:00:00Z", { discounted: true });
    await cost(b.id, APOLLO, "2.5", "2026-01-10T23:59:59Z"); // other org, same UTC day: summed
    await cost(a.id, APOLLO, "1", "2026-01-11T00:00:00Z", { status: "refunded" }); // consumed, not charged
    await cost(a.id, APOLLO, "7", "2026-01-11T00:00:00Z", { status: "provisioned" }); // a hold: not consumption
    await cost(a.id, APOLLO, "9", "2026-01-11T00:00:00Z", { status: "cancelled" }); // never happened
    await cost(a.id, APOLLO, "4", "2026-01-11T05:00:00Z", { costSource: "org" }); // customer's key: kept apart
    await cost(b.id, SERPER, "10", "2026-02-01T00:00:00Z", { costSource: "org" });
  });

  afterAll(async () => {
    await cleanTestData([ORG_A, ORG_B]);
    await closeDb();
  });

  it("refuses a call without the service key", async () => {
    const res = await request(app).get(PATH).query({ costNames: APOLLO });
    expect(res.status).toBe(401);
  });

  it("sums quantity per UTC day, cost name and source across orgs; actual + refunded only", async () => {
    const res = await request(app).get(PATH).query({ costNames: `${APOLLO},${SERPER}` }).set(API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ timezone: "UTC", since: null, statuses: ["actual", "refunded"], groupBy: [] });
    const z10 = "0.0000000000";
    expect(res.body.days).toEqual([
      // 3 units discounted (gross 6, net 5.4) + 2.5 units (gross 5)
      { day: "2026-01-10", costName: APOLLO, costSource: "platform", quantity: "5.500000", refundedQuantity: "0.000000", billedCostInUsdCents: "11.0000000000", netBilledCostInUsdCents: "10.4000000000", refundedCostInUsdCents: z10, netRefundedCostInUsdCents: z10 },
      { day: "2026-01-11", costName: APOLLO, costSource: "org", quantity: "4.000000", refundedQuantity: "0.000000", billedCostInUsdCents: "8.0000000000", netBilledCostInUsdCents: "8.0000000000", refundedCostInUsdCents: z10, netRefundedCostInUsdCents: z10 },
      { day: "2026-01-11", costName: APOLLO, costSource: "platform", quantity: "1.000000", refundedQuantity: "1.000000", billedCostInUsdCents: z10, netBilledCostInUsdCents: z10, refundedCostInUsdCents: "2.0000000000", netRefundedCostInUsdCents: "2.0000000000" },
      { day: "2026-02-01", costName: SERPER, costSource: "org", quantity: "10.000000", refundedQuantity: "0.000000", billedCostInUsdCents: "20.0000000000", netBilledCostInUsdCents: "20.0000000000", refundedCostInUsdCents: z10, netRefundedCostInUsdCents: z10 },
    ]);
    expect(res.body.totals).toEqual([
      { costName: APOLLO, costSource: "org", quantity: "4.000000", refundedQuantity: "0.000000", billedCostInUsdCents: "8.0000000000", netBilledCostInUsdCents: "8.0000000000", refundedCostInUsdCents: z10, netRefundedCostInUsdCents: z10 },
      { costName: APOLLO, costSource: "platform", quantity: "6.500000", refundedQuantity: "1.000000", billedCostInUsdCents: "11.0000000000", netBilledCostInUsdCents: "10.4000000000", refundedCostInUsdCents: "2.0000000000", netRefundedCostInUsdCents: "2.0000000000" },
      { costName: SERPER, costSource: "org", quantity: "10.000000", refundedQuantity: "0.000000", billedCostInUsdCents: "20.0000000000", netBilledCostInUsdCents: "20.0000000000", refundedCostInUsdCents: z10, netRefundedCostInUsdCents: z10 },
    ]);
  });

  it("totals equal a direct SQL sum of the same rows", async () => {
    const res = await request(app).get(PATH).query({ costNames: APOLLO }).set(API_KEY);
    const [direct] = (await db.execute(sql`
      SELECT SUM(quantity)::text AS q FROM runs_costs
      WHERE cost_name = ${APOLLO} AND cost_source = 'platform' AND status IN ('actual','refunded')
    `)) as any[];
    const platform = res.body.totals.find((t: any) => t.costSource === "platform");
    expect(platform.quantity).toBe(direct.q);
  });

  it("totals of billed money equal a direct SQL sum of the margin read's billed rows", async () => {
    const res = await request(app).get(PATH).query({ costNames: APOLLO, orgId: ORG_A }).set(API_KEY);
    const [direct] = (await db.execute(sql`
      SELECT SUM(total_cost_in_usd_cents)::text AS g, SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents))::text AS n FROM runs_costs
      WHERE cost_name = ${APOLLO} AND cost_source = 'platform' AND status = 'actual' AND organization_id = ${ORG_A}::uuid
    `)) as any[];
    const platform = res.body.totals.find((t: any) => t.costSource === "platform");
    expect(platform.billedCostInUsdCents).toBe(direct.g);
    expect(platform.netBilledCostInUsdCents).toBe(direct.n);
  });

  it("orgId narrows to one org; groupBy=orgId splits the fleet per org", async () => {
    const one = await request(app).get(PATH).query({ costNames: APOLLO, orgId: ORG_B }).set(API_KEY);
    expect(one.status).toBe(200);
    expect(one.body.days.map((d: any) => [d.day, d.costSource, d.quantity])).toEqual([["2026-01-10", "platform", "2.500000"]]);

    const grouped = await request(app).get(PATH).query({ costNames: APOLLO, groupBy: "orgId" }).set(API_KEY);
    expect(grouped.body.groupBy).toEqual(["orgId"]);
    const jan10 = grouped.body.days.filter((d: any) => d.day === "2026-01-10").map((d: any) => [d.orgId, d.quantity]);
    expect(jan10).toEqual([[ORG_A, "3.000000"], [ORG_B, "2.500000"]]); // ORG_A sorts first
    expect(grouped.body.days.every((d: any) => !("brandId" in d))).toBe(true);
  });

  it("brandId narrows to runs carrying the brand; groupBy=brandId counts a co-branded run under each brand", async () => {
    const one = await request(app).get(PATH).query({ costNames: APOLLO, brandId: BRAND_2 }).set(API_KEY);
    expect(one.status).toBe(200);
    // run A only (ORG_B's run has no brand)
    expect(one.body.totals.map((t: any) => [t.costSource, t.quantity])).toEqual([["org", "4.000000"], ["platform", "4.000000"]]);

    const both = await request(app).get(PATH).query({ costNames: APOLLO, orgId: ORG_A, brandId: BRAND_1, groupBy: "brandId" }).set(API_KEY);
    expect(both.body.totals.map((t: any) => [t.brandId, t.costSource, t.quantity])).toEqual([[BRAND_1, "org", "4.000000"], [BRAND_1, "platform", "4.000000"]]); // the run's other brand is not asked for
    expect((await request(app).get(PATH).query({ costNames: APOLLO, orgId: ORG_B, brandId: BRAND_1 }).set(API_KEY)).body.days).toEqual([]);

    const grouped = await request(app).get(PATH).query({ costNames: APOLLO, groupBy: "brandId,orgId" }).set(API_KEY);
    expect(grouped.body.groupBy).toEqual(["orgId", "brandId"]);
    const platform = grouped.body.totals.filter((t: any) => t.costSource === "platform").map((t: any) => [t.orgId, t.brandId, t.quantity]);
    expect(platform).toEqual([
      [ORG_A, BRAND_1, "4.000000"],
      [ORG_A, BRAND_2, "4.000000"],
      [ORG_B, null, "2.500000"],
    ]);
  });

  it("since keeps rows from that UTC day on", async () => {
    const res = await request(app).get(PATH).query({ costNames: APOLLO, since: "2026-01-11" }).set(API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.since).toBe("2026-01-11");
    expect(res.body.days.map((d: any) => d.day)).toEqual(["2026-01-11", "2026-01-11"]);
  });

  it("rejects a malformed since or an empty costNames", async () => {
    expect((await request(app).get(PATH).query({ since: "2026/01/01" }).set(API_KEY)).status).toBe(400);
    expect((await request(app).get(PATH).query({ costNames: " , " }).set(API_KEY)).status).toBe(400);
    expect((await request(app).get(PATH).query({ orgId: "nope" }).set(API_KEY)).status).toBe(400);
    expect((await request(app).get(PATH).query({ groupBy: "campaignId" }).set(API_KEY)).status).toBe(400);
  });
});
