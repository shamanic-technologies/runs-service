import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";

// GET /v1/stats/costs/timeseries?groupBy=serviceName,taskName — spend by ACTION per
// day: each (day, service, task) bucket carries the same money fields as the
// unsplit bucket, plus committedRunCount (runs with an actual or provisioned
// cost row). Summed over tasks, a day equals the unsplit day to the decimal.

const ORG = "0d53cccc-1111-4aaa-8aaa-111111111111";
const C1 = randomUUID();
const C2 = randomUUID();
const OTHER = randomUUID();

const app = createTestApp();

const MONEY = [
  "totalCostInUsdCents",
  "actualCostInUsdCents",
  "provisionedCostInUsdCents",
  "cancelledCostInUsdCents",
  "refundedCostInUsdCents",
  "netTotalCostInUsdCents",
  "netActualCostInUsdCents",
  "netProvisionedCostInUsdCents",
  "netRefundedCostInUsdCents",
] as const;

async function run(at: string, taskName: string, campaignId = C1, featureSlug = "sales-cold-email-outreach") {
  return insertTestRun({
    organizationId: ORG,
    serviceName: "instantly",
    taskName,
    campaignId,
    featureSlug,
    startedAt: new Date(at),
  });
}

async function cost(runId: string, qty: string, unit: string, status = "actual", discountPct?: string) {
  const gross = new Decimal(qty).times(unit);
  return insertTestRunCost({
    runId,
    costName: "send",
    quantity: qty,
    unitCostInUsdCents: unit,
    totalCostInUsdCents: gross.toFixed(10),
    ...(discountPct && {
      netCostInUsdCents: gross.times(new Decimal(1).minus(discountPct)).toFixed(10),
      usageDiscountPct: discountPct,
    }),
    status,
  });
}

function get(query: Record<string, string>) {
  return request(app).get("/v1/stats/costs/timeseries").query(query).set(getAuthHeaders({ orgId: ORG }));
}

beforeAll(async () => {
  await cleanTestData([ORG]);
  // Day 1: two step-2 sends (one discounted), one step-1 send, one cancelled-only
  // step-2 run (not an action), one cost-less step-2 run (not an action).
  const a = await run("2026-10-01T09:00:00Z", "email-send-step-2");
  await cost(a.id, "1", "4.1234567891");
  const b = await run("2026-10-01T10:00:00Z", "email-send-step-2", C2);
  await cost(b.id, "2", "3.3333333333", "actual", "0.25");
  await cost(b.id, "1", "1", "cancelled");
  const c = await run("2026-10-01T11:00:00Z", "email-send-step-1");
  await cost(c.id, "1", "6", "provisioned");
  const d = await run("2026-10-01T12:00:00Z", "email-send-step-2");
  await cost(d.id, "1", "9", "cancelled");
  await run("2026-10-01T13:00:00Z", "email-send-step-2");
  // Day 2: one refunded step-1 run (charged then comped: not committed).
  const e = await run("2026-10-02T08:00:00Z", "email-send-step-1");
  await cost(e.id, "1", "2", "refunded");
  const f = await run("2026-10-02T09:00:00Z", "email-send-step-1");
  await cost(f.id, "3", "0.5");
  // Outside the family / other feature: never counted.
  const g = await run("2026-10-01T09:30:00Z", "email-send-step-2", OTHER);
  await cost(g.id, "1", "100");
  const h = await run("2026-10-01T09:45:00Z", "email-send-step-2", C1, "other-feature");
  await cost(h.id, "1", "100");
});

afterAll(async () => {
  await cleanTestData([ORG]);
  await closeDb();
});

describe("GET /v1/stats/costs/timeseries groupBy=serviceName,taskName", () => {
  const base = { campaignIds: `${C1},${C2}`, featureSlugs: "sales-cold-email-outreach" };

  it("splits each day per task with the committed-run count", async () => {
    const res = await get({ ...base, groupBy: "serviceName,taskName" });
    expect(res.status).toBe(200);
    const rows = res.body.buckets.map((b: any) => [b.period, b.serviceName, b.taskName, b.runCount, b.committedRunCount, b.totalCostInUsdCents, b.netTotalCostInUsdCents]);
    expect(rows).toEqual([
      ["2026-10-01", "instantly", "email-send-step-1", 1, 1, "6.0000000000", "6.0000000000"],
      // a + b committed; d cancelled-only and the cost-less run are not actions.
      ["2026-10-01", "instantly", "email-send-step-2", 4, 2, "10.7901234557", "9.1234567891"],
      // e refunded (not charged) is not counted; f is.
      ["2026-10-02", "instantly", "email-send-step-1", 2, 1, "1.5000000000", "1.5000000000"],
    ]);
    expect(res.body.buckets[1].cancelledCostInUsdCents).toBe("10.0000000000");
    expect(res.body.buckets[2].refundedCostInUsdCents).toBe("2.0000000000");
  });

  it("sums over tasks to the unsplit day, every money field to the decimal", async () => {
    const [split, whole] = await Promise.all([get({ ...base, groupBy: "serviceName,taskName" }), get(base)]);
    expect(whole.status).toBe(200);
    for (const day of whole.body.buckets) {
      const parts = split.body.buckets.filter((b: any) => b.period === day.period);
      for (const f of MONEY) {
        const sum = parts.reduce((acc: Decimal, b: any) => acc.plus(b[f]), new Decimal(0));
        expect(sum.toFixed(10), `${day.period} ${f}`).toBe(day[f]);
      }
      expect(parts.reduce((n: number, b: any) => n + b.runCount, 0)).toBe(day.runCount);
    }
    // The unsplit shape is unchanged: no task keys, no committedRunCount.
    expect(Object.keys(whole.body.buckets[0]).sort()).toEqual(
      [...MONEY, "period", "runCount", "minStartedAt", "maxStartedAt"].sort(),
    );
  });

  it("combines with campaignId and with taskName alone", async () => {
    const res = await get({ ...base, groupBy: "campaignId,taskName" });
    expect(res.status).toBe(200);
    const step2 = res.body.buckets.filter((b: any) => b.period === "2026-10-01" && b.taskName === "email-send-step-2");
    expect(step2.map((b: any) => [b.campaignId, b.committedRunCount]).sort()).toEqual(
      [[C1, 1], [C2, 1]].sort(),
    );
    expect(step2[0].serviceName).toBeUndefined();
  });

  it("rejects an unknown or repeated key", async () => {
    expect((await get({ groupBy: "costName" })).status).toBe(400);
    expect((await get({ groupBy: "taskName,taskName" })).status).toBe(400);
  });
});
