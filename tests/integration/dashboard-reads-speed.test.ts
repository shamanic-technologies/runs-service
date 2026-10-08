import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { eq } from "drizzle-orm";
import { db, sql as rawSql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { COST_DAY_ROLLUP_NAME, rebuildCostDayRollup } from "../../src/services/stats-rollup-cost-day.js";
import { CAMPAIGN_ENTRY_ROLLUP_NAME, backfillRunCampaignEntries } from "../../src/services/run-campaign-entries.js";

// Migration 0040: the dashboard reads served from precomputed structures must
// answer byte-for-byte what the live queries answer. Each test reads the same
// endpoint twice — structure stamped ready, then un-stamped (live query) — and
// compares the raw response bodies.

const ORG = "0d40aaaa-1111-4aaa-8aaa-111111111111";
const ORG2 = "0d40aaaa-2222-4aaa-8aaa-222222222222";
const BRAND = randomUUID();

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});

// Edges mid-day on 2026-09-15 (provider + price move) and 2026-09-20 (vendor
// price change at the same billed price): rows on both sides of each.
const VERSIONS = [
  { costName: "tok", provider: "vercel", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "6", vendorUnitCostInUsdCents: "1" },
  { costName: "tok", provider: "deepseek", servedFrom: "2026-09-15T12:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" },
  { costName: "api", provider: "apollo", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "10", vendorUnitCostInUsdCents: "4" },
  { costName: "api", provider: "apollo", servedFrom: "2026-09-20T08:30:00Z", billedUnitCostInUsdCents: "10", vendorUnitCostInUsdCents: "3.3333333" },
  { costName: "unknown", provider: "acme", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "2", vendorUnitCostInUsdCents: null },
];

const app = createTestApp();
const INTERNAL = { "x-api-key": "test-api-key" };

async function setReady(name: string, ready: boolean) {
  if (ready) {
    await rawSql`INSERT INTO stats_rollups (name, ready_at) VALUES (${name}, now()) ON CONFLICT (name) DO NOTHING`;
  } else {
    await rawSql`DELETE FROM stats_rollups WHERE name = ${name}`;
  }
}

/** Raw bodies of `fetch()` with the structure ready, then live. */
async function bothWays(name: string, fetch: () => Promise<request.Response>) {
  await setReady(name, true);
  const fast = await fetch();
  await setReady(name, false);
  try {
    const live = await fetch();
    return { fast, live };
  } finally {
    await setReady(name, true);
  }
}

async function cost(runId: string, costName: string, qty: string, unit: string, createdAt: string, opts: { status?: string; costSource?: string; discountPct?: string } = {}) {
  const gross = new Decimal(qty).times(unit);
  return insertTestRunCost({
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

beforeAll(async () => {
  await cleanTestData([ORG, ORG2]);
  catalog.fn.mockResolvedValue(VERSIONS);
});

afterAll(async () => {
  await cleanTestData([ORG, ORG2]);
  await closeDb();
});

describe("margin reads from the cost-day rollup", () => {
  beforeAll(async () => {
    const r1 = await insertTestRun({ organizationId: ORG, serviceName: "svc", taskName: "t", status: "completed" });
    const r2 = await insertTestRun({ organizationId: ORG2, serviceName: "svc", taskName: "t", status: "completed" });
    // tok: both sides of the 09-15 12:00 edge, same day, both billed prices.
    await cost(r1.id, "tok", "10", "6", "2026-09-15T08:00:00Z", { discountPct: "0.1" });
    await cost(r1.id, "tok", "3", "6", "2026-09-15T13:00:00Z");
    await cost(r1.id, "tok", "7", "5", "2026-09-15T14:00:00Z");
    await cost(r1.id, "tok", "2.5", "5", "2026-09-16T10:00:00Z");
    await cost(r1.id, "tok", "1", "7", "2026-09-16T10:00:00Z"); // no version at 7 → unpriced
    // api: vendor changes 09-20 08:30 at the same billed price.
    await cost(r1.id, "api", "2", "10", "2026-09-20T08:00:00Z");
    await cost(r1.id, "api", "3", "10", "2026-09-20T09:00:00Z");
    await cost(r1.id, "api", "1", "10", "2026-09-21T09:00:00Z", { status: "refunded" });
    await cost(r1.id, "api", "1", "10", "2026-09-21T09:00:00Z", { status: "provisioned" });
    await cost(r1.id, "api", "1", "10", "2026-09-21T09:00:00Z", { costSource: "org" });
    await cost(r1.id, "unknown", "4", "2", "2026-09-10T10:00:00Z");
    await cost(r1.id, "mystery", "1", "3", "2026-09-10T10:00:00Z"); // never listed
    await cost(r2.id, "tok", "1.25", "6", "2026-09-12T10:00:00Z");
    await cost(r2.id, "api", "4", "10", "2026-09-20T23:59:59Z");
    // An actual row then refunded, and one deleted: the rollup follows.
    const refundLater = await cost(r2.id, "api", "5", "10", "2026-09-22T10:00:00Z");
    await db.update(runsCosts).set({ status: "refunded" }).where(eq(runsCosts.id, refundLater.id));
    const gone = await cost(r2.id, "tok", "9", "6", "2026-09-12T11:00:00Z");
    await db.delete(runsCosts).where(eq(runsCosts.id, gone.id));
  });

  for (const path of ["/internal/stats/costs/margin", "/internal/stats/costs/margin/timeseries"]) {
    for (const orgId of [undefined, ORG, ORG2]) {
      it(`${path}${orgId ? " (one org)" : " (fleet)"}: identical to the live query`, async () => {
        const { fast, live } = await bothWays(COST_DAY_ROLLUP_NAME, () =>
          request(app).get(path).query(orgId ? { orgId } : {}).set(INTERNAL),
        );
        expect(fast.status).toBe(200);
        expect(live.status).toBe(200);
        expect(fast.text).toBe(live.text);
      });
    }
  }

  it("a straddling group really is read row by row (the figure moves at the edge)", async () => {
    const res = await request(app).get("/internal/stats/costs/margin").query({ orgId: ORG }).set(INTERNAL);
    const api = res.body.costItems.find((c: any) => c.costName === "api");
    // 2 × 4 (before 08:30) + 3 × 3.3333333 (after)
    expect(api.vendorCostInUsdCents).toBe("17.9999999000");
  });

  it("an org moved with its cost rows (brand transfer) moves its rollup groups", async () => {
    await db.update(runsCosts).set({ organizationId: ORG2 }).where(eq(runsCosts.costName, "mystery"));
    for (const orgId of [ORG, ORG2]) {
      const { fast, live } = await bothWays(COST_DAY_ROLLUP_NAME, () =>
        request(app).get("/internal/stats/costs/margin").query({ orgId }).set(INTERNAL),
      );
      expect(fast.text).toBe(live.text);
    }
  });

  it("a rebuild from the ledger lands on the same figures", async () => {
    const before = await request(app).get("/internal/stats/costs/margin").set(INTERNAL);
    const url = process.env.RUNS_SERVICE_DATABASE_URL!;
    await rebuildCostDayRollup(url);
    const after = await request(app).get("/internal/stats/costs/margin").set(INTERNAL);
    expect(after.text).toBe(before.text);
  });
});

describe("run-outcomes reads entry runs from run_campaign_entries", () => {
  const C1 = randomUUID();
  const C2 = randomUUID();
  const T0 = new Date("2026-09-25T10:00:00.000Z");

  async function run(opts: { campaignId?: string; status?: string; parentRunId?: string; startedAt?: Date; durationMs?: number; serviceName?: string; orgId?: string }) {
    const startedAt = opts.startedAt ?? T0;
    const r = await insertTestRun({
      organizationId: opts.orgId ?? ORG,
      serviceName: opts.serviceName ?? "workflow",
      taskName: "execute-workflow",
      brandIds: [BRAND],
      campaignId: opts.campaignId,
      parentRunId: opts.parentRunId,
      status: opts.status ?? "running",
      featureSlug: "f",
      startedAt,
    });
    if (opts.durationMs !== undefined) {
      await db.update(runs).set({ status: opts.status ?? "completed", completedAt: new Date(startedAt.getTime() + opts.durationMs) }).where(eq(runs.id, r.id));
    }
    return r;
  }

  let movedParent: string;

  beforeAll(async () => {
    const trigger = await run({ serviceName: "campaign-service", status: "completed", durationMs: 10 });
    const e1 = await run({ campaignId: C1, parentRunId: trigger.id, status: "completed", durationMs: 1500 });
    await run({ campaignId: C1, status: "completed", durationMs: 4000 });
    await run({ campaignId: C1, status: "failed", durationMs: 700 });
    await run({ campaignId: C1, parentRunId: e1.id, status: "completed", durationMs: 100, serviceName: "chat-service" });
    // A child of another campaign under e1: an entry of C2.
    await run({ campaignId: C2, parentRunId: e1.id, status: "completed", durationMs: 900 });
    // Parent before the window, same campaign: still a child.
    const old = await run({ campaignId: C2, startedAt: new Date("2026-08-01T00:00:00Z"), status: "completed", durationMs: 50 });
    await run({ campaignId: C2, parentRunId: old.id, status: "running" });
    await run({ campaignId: C2, status: "running" });
    // A run that completes after its entry row was written.
    const late = await run({ campaignId: C2 });
    await db.update(runs).set({ status: "completed", completedAt: new Date(T0.getTime() + 3000) }).where(eq(runs.id, late.id));
    // A parent whose campaign changes: its children flip membership.
    const p = await run({ campaignId: C1, status: "completed", durationMs: 5 });
    await run({ campaignId: C2, parentRunId: p.id, status: "completed", durationMs: 6 });
    await run({ campaignId: C1, parentRunId: p.id, status: "completed", durationMs: 7 });
    movedParent = p.id;
    await db.update(runs).set({ campaignId: C2 }).where(eq(runs.id, p.id));
  });

  const queries = [
    { groupBy: "featureSlug", campaignIds: "" },
    { groupBy: "campaignId", campaignIds: "" },
    { groupBy: "campaignId,serviceName", campaignIds: "" },
    { groupBy: "campaignId", campaignIds: "", startedAfter: "2026-09-01T00:00:00.000Z" },
    { groupBy: "campaignId", campaignIds: "", brandId: BRAND, startedBefore: "2026-09-30T00:00:00.000Z" },
  ];

  for (const q of queries) {
    it(`identical to the live query: ${JSON.stringify({ ...q, campaignIds: undefined })}`, async () => {
      const query = { ...q, campaignIds: `${C1},${C2}` };
      const { fast, live } = await bothWays(CAMPAIGN_ENTRY_ROLLUP_NAME, () =>
        request(app).get("/v1/stats/run-outcomes").query(query).set(getAuthHeaders({ orgId: ORG })),
      );
      expect(fast.status).toBe(200);
      expect(fast.text).toBe(live.text);
      expect(fast.body.groups.length).toBeGreaterThan(0);
    });
  }

  it("single campaignId filter too", async () => {
    for (const campaignId of [C1, C2]) {
      const { fast, live } = await bothWays(CAMPAIGN_ENTRY_ROLLUP_NAME, () =>
        request(app).get("/v1/stats/run-outcomes").query({ campaignId }).set(getAuthHeaders({ orgId: ORG })),
      );
      expect(fast.text).toBe(live.text);
    }
  });

  it("the moved parent's children flipped", async () => {
    const rows = await rawSql`SELECT r.campaign_id FROM run_campaign_entries e JOIN runs r ON r.id = e.run_id WHERE r.parent_run_id = ${movedParent}`;
    expect(rows.map((r) => r.campaign_id)).toEqual([C1]);
  });

  it("the windowed backfill rebuilds the same table", async () => {
    const before = await rawSql`SELECT * FROM run_campaign_entries WHERE organization_id = ${ORG} ORDER BY run_id`;
    await rawSql`DELETE FROM run_campaign_entries WHERE organization_id = ${ORG}`;
    await backfillRunCampaignEntries(process.env.RUNS_SERVICE_DATABASE_URL!);
    const after = await rawSql`SELECT * FROM run_campaign_entries WHERE organization_id = ${ORG} ORDER BY run_id`;
    expect(after).toEqual(before);
  });
});

describe("GET /v1/stats/costs/timeseries", () => {
  const C1 = randomUUID();
  const C2 = randomUUID();

  beforeAll(async () => {
    // Paris days: 10-05 23:30Z is 10-06 local; 10-06 22:30Z is 10-07 local.
    const at = ["2026-10-05T21:00:00Z", "2026-10-05T23:30:00Z", "2026-10-06T12:00:00Z", "2026-10-06T22:30:00Z", "2026-10-07T09:00:00Z"];
    for (const [i, t] of at.entries()) {
      const r = await insertTestRun({
        organizationId: ORG2,
        serviceName: "workflow",
        taskName: "execute-workflow",
        brandIds: [BRAND],
        campaignId: i % 2 === 0 ? C1 : C2,
        startedAt: new Date(t),
      });
      if (i !== 2) await cost(r.id, "tok", String(i + 1), "6", t);
    }
    await insertTestRun({ organizationId: ORG2, serviceName: "x", taskName: "y", brandIds: [BRAND], startedAt: new Date("2026-10-06T12:00:00Z") });
  });

  it("each local-day bucket equals GET /v1/stats/costs over that local day", async () => {
    const res = await request(app)
      .get("/v1/stats/costs/timeseries")
      .query({ brandId: BRAND, groupBy: "campaignId", tz: "Europe/Paris", startedAfter: "2026-10-04T22:00:00.000Z", startedBefore: "2026-10-07T22:00:00.000Z" })
      .set(getAuthHeaders({ orgId: ORG2 }));
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("Europe/Paris");
    expect(res.body.buckets.map((b: any) => b.period)).toEqual(
      [...res.body.buckets.map((b: any) => b.period)].sort(),
    );

    const days = [
      ["2026-10-05", "2026-10-04T22:00:00.000Z", "2026-10-05T21:59:59.999Z"],
      ["2026-10-06", "2026-10-05T22:00:00.000Z", "2026-10-06T21:59:59.999Z"],
      ["2026-10-07", "2026-10-06T22:00:00.000Z", "2026-10-07T21:59:59.999Z"],
    ];
    let seen = 0;
    for (const [day, after, before] of days) {
      const perDay = await request(app)
        .get("/v1/stats/costs")
        .query({ brandId: BRAND, groupBy: "campaignId", startedAfter: after, startedBefore: before })
        .set(getAuthHeaders({ orgId: ORG2 }));
      for (const g of perDay.body.groups) {
        const b = res.body.buckets.find((x: any) => x.period === day && x.campaignId === g.dimensions.campaignId);
        const { dimensions, ...figures } = g;
        expect({ ...b, period: undefined, campaignId: undefined }).toEqual({ ...figures, period: undefined, campaignId: undefined });
        seen += 1;
      }
    }
    expect(seen).toBe(res.body.buckets.length);
    expect(res.body.buckets.find((b: any) => b.period === "2026-10-06" && b.campaignId === null)).toMatchObject({ runCount: 1, totalCostInUsdCents: "0.0000000000" });
  });

  it("rejects an unknown timezone", async () => {
    const res = await request(app).get("/v1/stats/costs/timeseries").query({ tz: "Mars/Olympus" }).set(getAuthHeaders({ orgId: ORG2 }));
    expect(res.status).toBe(400);
  });
});
