import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { eq } from "drizzle-orm";
import { db, sql as rawSql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { ORG_HOUR_ROLLUP_NAME, rebuildOrgHourRollup } from "../../src/services/stats-rollup-org-hour.js";

// Migration 0042: GET /v1/stats/costs/timeseries served from the (org, brand set,
// campaign, UTC hour) rollup must answer byte-for-byte what the live query
// answers. Every case reads twice — stamp present, then absent — and compares
// the raw bodies.

const ORG = "0d42bbbb-1111-4aaa-8aaa-111111111111";
const ORG2 = "0d42bbbb-2222-4aaa-8aaa-222222222222";
const BRAND = randomUUID();
const BRAND2 = randomUUID();
const C1 = randomUUID();
const C2 = randomUUID();

const app = createTestApp();

async function setReady(ready: boolean) {
  if (ready) {
    await rawSql`INSERT INTO stats_rollups (name, ready_at) VALUES (${ORG_HOUR_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  } else {
    await rawSql`DELETE FROM stats_rollups WHERE name = ${ORG_HOUR_ROLLUP_NAME}`;
  }
}

async function both(query: Record<string, string>, orgId = ORG) {
  const get = () => request(app).get("/v1/stats/costs/timeseries").query(query).set(getAuthHeaders({ orgId }));
  await setReady(true);
  const fast = await get();
  await setReady(false);
  try {
    const live = await get();
    return { fast, live };
  } finally {
    await setReady(true);
  }
}

async function run(at: string, opts: { campaignId?: string | null; brandIds?: string[]; orgId?: string } = {}) {
  return insertTestRun({
    organizationId: opts.orgId ?? ORG,
    serviceName: "workflow",
    taskName: "execute-workflow",
    brandIds: opts.brandIds ?? [BRAND],
    campaignId: opts.campaignId === null ? undefined : (opts.campaignId ?? C1),
    startedAt: new Date(at),
  });
}

async function cost(runId: string, qty: string, unit: string, opts: { status?: string; discountPct?: string } = {}) {
  const gross = new Decimal(qty).times(unit);
  return insertTestRunCost({
    runId,
    costName: "tok",
    quantity: qty,
    unitCostInUsdCents: unit,
    totalCostInUsdCents: gross.toFixed(10),
    ...(opts.discountPct && {
      netCostInUsdCents: gross.times(new Decimal(1).minus(opts.discountPct)).toFixed(10),
      usageDiscountPct: opts.discountPct,
    }),
    status: opts.status ?? "actual",
  });
}

let removed: string;
let moved: string;
let revised: string;

beforeAll(async () => {
  await cleanTestData([ORG, ORG2]);
  // A week of runs around local midnights in Almaty (UTC+5: 19:00Z) and New York
  // (DST ends 2026-11-01), several per hour, both campaigns, no campaign, a
  // co-branded run, and a run in another org.
  const times = [
    "2026-10-01T18:59:59.999Z", "2026-10-01T19:00:00.000Z", "2026-10-01T19:30:00.000Z",
    "2026-10-02T04:00:00.000Z", "2026-10-02T04:00:00.500Z", "2026-10-03T12:15:00.000Z",
    "2026-10-04T23:59:59.000Z", "2026-10-05T00:00:00.000Z", "2026-10-06T18:10:00.000Z",
    "2026-10-07T18:59:00.000Z", "2026-10-07T19:00:01.000Z", "2026-11-01T05:30:00.000Z",
    "2026-11-01T06:30:00.000Z",
  ];
  for (const [i, t] of times.entries()) {
    const r = await run(t, { campaignId: i % 3 === 0 ? C2 : i % 5 === 0 ? null : C1, brandIds: i % 4 === 0 ? [BRAND, BRAND2] : [BRAND] });
    if (i % 2 === 0) await cost(r.id, String(i + 1), "6", { discountPct: i % 4 === 0 ? "0.1" : undefined });
    if (i % 3 === 0) await cost(r.id, "2", "5", { status: "provisioned" });
    if (i === 5) await cost(r.id, "1", "7", { status: "cancelled" });
  }
  await run("2026-10-03T12:20:00.000Z", { orgId: ORG2 });

  // A run removed from its hour: min/max of that hour goes stale.
  const gone = await run("2026-10-03T12:40:00.000Z");
  removed = gone.id;
  await db.delete(runs).where(eq(runs.id, removed));
  // A run moved to another brand set (what transfer-brand does) with its cost.
  const m = await run("2026-10-04T08:05:00.000Z");
  await cost(m.id, "3", "6");
  moved = m.id;
  await db.update(runs).set({ brandIds: [BRAND2] }).where(eq(runs.id, moved));
  // A cost refunded after the fact.
  const rv = await run("2026-10-05T09:00:00.000Z");
  const c = await cost(rv.id, "4", "6");
  revised = c.id;
  await db.update(runsCosts).set({ status: "refunded" }).where(eq(runsCosts.id, revised));
});

afterAll(async () => {
  await cleanTestData([ORG, ORG2]);
  await closeDb();
});

const WEEK = { startedAfter: "2026-10-01T19:00:00.000Z", startedBefore: "2026-10-08T18:59:59.999Z" };
const cases: Array<[string, Record<string, string>]> = [
  ["Almaty week per campaign", { ...WEEK, tz: "Asia/Almaty", groupBy: "campaignId", brandId: BRAND }],
  ["Almaty week, no grouping", { ...WEEK, tz: "Asia/Almaty", brandId: BRAND }],
  ["UTC, unbounded", { groupBy: "campaignId" }],
  ["New York across DST, weekly", { tz: "America/New_York", interval: "week", groupBy: "campaignId", brandId: BRAND }],
  ["monthly", { tz: "Europe/Paris", interval: "month", brandId: BRAND }],
  ["unaligned bounds with runs on both sides", { tz: "UTC", groupBy: "campaignId", startedAfter: "2026-10-01T19:15:00.000Z", startedBefore: "2026-10-02T04:00:00.200Z" }],
  ["campaign family", { tz: "Asia/Almaty", groupBy: "campaignId", campaignIds: `${C1},${C2}` }],
  ["single campaign, second brand", { tz: "Asia/Almaty", campaignId: C1, brandId: BRAND2 }],
  ["half-hour zone falls back live", { tz: "Asia/Kolkata", groupBy: "campaignId" }],
];

describe("GET /v1/stats/costs/timeseries from the hour rollup", () => {
  for (const [name, query] of cases) {
    it(`identical to the live query: ${name}`, async () => {
      const { fast, live } = await both(query);
      expect(fast.status).toBe(200);
      expect(live.status).toBe(200);
      expect(fast.text).toBe(live.text);
      expect(fast.body.buckets.length).toBeGreaterThan(0);
    });
  }

  it("another org sees only its own run", async () => {
    const { fast, live } = await both({ groupBy: "campaignId" }, ORG2);
    expect(fast.text).toBe(live.text);
    expect(fast.body.buckets).toHaveLength(1);
  });

  it("a filter the rollup does not carry keeps the live query", async () => {
    const { fast, live } = await both({ tz: "Asia/Almaty", featureSlug: "nope" });
    expect(fast.text).toBe(live.text);
  });

  it("a rebuild from the ledger lands on the same bytes", async () => {
    const q = { tz: "Asia/Almaty", groupBy: "campaignId" };
    const before = await request(app).get("/v1/stats/costs/timeseries").query(q).set(getAuthHeaders({ orgId: ORG }));
    await rebuildOrgHourRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    const stale = await rawSql`SELECT count(*)::int AS n FROM stats_rollup_org_hour WHERE minmax_stale`;
    expect(stale[0].n).toBe(0);
    const after = await request(app).get("/v1/stats/costs/timeseries").query(q).set(getAuthHeaders({ orgId: ORG }));
    expect(after.text).toBe(before.text);
  });
});
