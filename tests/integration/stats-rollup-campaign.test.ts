import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db, sql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";
import { CAMPAIGN_DAY_ROLLUP_NAME, rebuildCampaignDayRollup } from "../../src/services/stats-rollup-campaign.js";

// The write-maintained (campaign, UTC day) rollup (migration 0037) must answer the
// campaign-FAMILY reads — GET /v1/stats/public/costs/timeseries and
// GET /v1/stats/public/costs with campaignId / campaignIds — IDENTICALLY to the
// live query, through every write the ledger sees. Each comparison runs the same
// request with the rollup ready and with its readiness stamp removed (which sends
// the route down the live query).
//
// It also pins the feature itself: one family request returns exactly the sum of
// the per-row requests it replaces, combined and broken down per row.

const ORG_ID = "7a220000-1111-4aaa-8aaa-111111111111";
const OTHER_ORG_ID = "7a220000-2222-4aaa-8aaa-222222222222";
const CLEANUP = [ORG_ID, OTHER_ORG_ID];
const SUFFIX = randomUUID().slice(0, 8);
const FEAT = `camp-rollup-${SUFFIX}`;
const FEAT_OTHER = `camp-rollup-other-${SUFFIX}`;
const BRAND = randomUUID();
const BRAND_OTHER = randomUUID();
const C1 = randomUUID();
const C2 = randomUUID();
const C3 = randomUUID();
const C_OUTSIDE = randomUUID(); // never asked for — must never leak into a family answer
const FAMILY = [C1, C2, C3];

const app = createTestApp();
const headers = getAuthHeaders({ orgId: ORG_ID });

async function readyStamp(ready: boolean) {
  if (ready) {
    await sql`INSERT INTO stats_rollups (name, ready_at) VALUES (${CAMPAIGN_DAY_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  } else {
    await sql`DELETE FROM stats_rollups WHERE name = ${CAMPAIGN_DAY_ROLLUP_NAME}`;
  }
}

async function get(path: string, query: Record<string, string>) {
  const res = await request(app).get(path).set(headers).query(query);
  expect(res.status).toBe(200);
  return res.body;
}

async function timeseriesBothWays(query: Record<string, string>) {
  await readyStamp(true);
  const rolled = await get("/v1/stats/public/costs/timeseries", query);
  await readyStamp(false);
  const live = await get("/v1/stats/public/costs/timeseries", query);
  await readyStamp(true);
  return { rolled, live };
}

async function expectTimeseriesEqual(query: Record<string, string>) {
  const { rolled, live } = await timeseriesBothWays(query);
  expect(live.buckets.length).toBeGreaterThan(0);
  // Ordered by period (then campaign) — the order is part of the contract.
  expect(rolled).toEqual(live);
}

async function expectPublicCostsEqual(query: Record<string, string>) {
  await readyStamp(true);
  const rolled = (await get("/v1/stats/public/costs", query)).groups as any[];
  await readyStamp(false);
  const live = (await get("/v1/stats/public/costs", query)).groups as any[];
  await readyStamp(true);
  expect(live.length).toBeGreaterThan(0);
  expect(rolled.map((g) => g.totalCostInUsdCents)).toEqual(live.map((g) => g.totalCostInUsdCents));
  const key = (g: any) => JSON.stringify(g.dimensions);
  const sortByKey = (a: any[]) => [...a].sort((x, y) => key(x).localeCompare(key(y)));
  expect(sortByKey(rolled)).toEqual(sortByKey(live));
}

const family = FAMILY.join(",");

async function allComparisons() {
  for (const q of [
    { campaignIds: family },
    { campaignIds: family, groupBy: "campaignId" },
    { campaignIds: family, interval: "week" },
    { campaignIds: family, interval: "month", groupBy: "campaignId" },
    { campaignIds: family, orgId: ORG_ID },
    { campaignIds: family, brandId: BRAND },
    { campaignIds: family, featureSlugs: FEAT },
    { campaignIds: family, featureSlug: FEAT_OTHER },
    { campaignIds: family, costSource: "platform" },
    { campaignIds: family, costSource: "org", groupBy: "campaignId" },
    { campaignId: C1 },
    { campaignId: C1, campaignIds: `${C1},${C2}` },
    { campaignIds: `${C2},${C_OUTSIDE}`, orgId: OTHER_ORG_ID },
  ]) {
    await expectTimeseriesEqual(q);
  }
  for (const q of [
    { campaignIds: family, groupBy: "campaignId" },
    { campaignIds: family, groupBy: "workflowSlug" },
    { campaignIds: family, groupBy: "featureSlug" },
    { campaignIds: family, groupBy: "campaignId", orgId: ORG_ID, brandId: BRAND },
    { campaignIds: family, groupBy: "campaignId", costSource: "platform" },
    { campaignIds: family, groupBy: "workflowSlug", featureSlugs: `${FEAT},${FEAT_OTHER}` },
    { campaignId: C2, groupBy: "workflowSlug" },
  ]) {
    await expectPublicCostsEqual(q);
  }
}

const ids: Record<string, string> = {};

afterAll(async () => {
  await cleanTestData(CLEANUP);
  await readyStamp(true);
  await closeDb();
});

describe("campaign-day rollup — campaign-family cost reads", () => {
  beforeAll(async () => {
    await cleanTestData(CLEANUP);
    await readyStamp(true);

    const run = async (key: string, o: { org?: string; campaign?: string; at: string; workflow?: string; feature?: string; brands?: string[] }) => {
      const r = await insertTestRun({
        organizationId: o.org ?? ORG_ID, serviceName: "svc", taskName: "t",
        featureSlug: o.feature ?? FEAT, workflowSlug: o.workflow, campaignId: o.campaign,
        brandIds: o.brands ?? [BRAND], startedAt: new Date(o.at),
      });
      ids[key] = r.id;
      return r.id;
    };
    const cost = async (key: string, runId: string, status: string, total: string, extra: Record<string, string> = {}) => {
      const c = await insertTestRunCost({
        runId, costName: "c", quantity: "1", unitCostInUsdCents: total, totalCostInUsdCents: total, status, ...extra,
      });
      ids[key] = c.id;
    };

    // Two runs straddling a UTC midnight land in different day buckets.
    const r1 = await run("r1", { campaign: C1, at: "2026-09-07T23:59:59Z", workflow: "wf-a" });
    const r2 = await run("r2", { campaign: C1, at: "2026-09-08T00:00:01Z", workflow: "wf-a" });
    await run("r3", { campaign: C1, at: "2026-09-08T10:00:00Z", workflow: "wf-a" }); // no cost
    const r4 = await run("r4", { campaign: C2, at: "2026-09-08T12:00:00Z", workflow: "wf-b" });
    const r5 = await run("r5", { campaign: C2, at: "2026-09-21T12:00:00Z" }); // NULL workflow
    const r6 = await run("r6", { campaign: C3, at: "2026-10-02T08:00:00Z", workflow: "wf-b", feature: FEAT_OTHER, brands: [BRAND_OTHER] });
    const r7 = await run("r7", { campaign: C2, at: "2026-09-08T13:00:00Z", workflow: "wf-b", org: OTHER_ORG_ID });
    const r8 = await run("r8", { campaign: C_OUTSIDE, at: "2026-09-08T13:00:00Z", workflow: "wf-a" });
    const r9 = await run("r9", { at: "2026-09-08T13:00:00Z", workflow: "wf-a" }); // no campaign

    await cost("k1", r1, "actual", "12.3456789012", { netCostInUsdCents: "6.1728394506", usageDiscountPct: "0.5" });
    await cost("k2", r1, "provisioned", "0.0000000001");
    await cost("k3", r2, "actual", "100");
    await cost("k4", r2, "cancelled", "7.5");
    await cost("k5", r4, "provisioned", "3.3333333333");
    await cost("k6", r5, "actual", "0.25", { costSource: "org" });
    await cost("k7", r6, "actual", "9.99");
    await cost("k8", r7, "actual", "4");
    await cost("k9", r8, "actual", "1000");
    await cost("k10", r9, "actual", "2000");
    await cost("k11", r4, "actual", "0"); // a matched row summing to zero
  });

  it("matches the live query after inserts", async () => {
    await allComparisons();
    const body = await get("/v1/stats/public/costs/timeseries", { campaignIds: family, groupBy: "campaignId" });
    const c1Sep8 = body.buckets.find((b: any) => b.period === "2026-09-08" && b.campaignId === C1);
    expect(c1Sep8.runCount).toBe(2); // r2 + the cost-less r3; r1 fell on Sep 7
    expect(c1Sep8.totalCostInUsdCents).toBe("100.0000000000");
    expect(c1Sep8.cancelledCostInUsdCents).toBe("7.5000000000");
  });

  it("one family request equals the sum of the per-row requests it replaces", async () => {
    const perRow = await Promise.all(FAMILY.map((c) => get("/v1/stats/public/costs/timeseries", { campaignId: c })));
    const summed = new Map<string, { total: Decimal; net: Decimal; runs: number }>();
    for (const body of perRow) {
      for (const b of body.buckets) {
        const cur = summed.get(b.period) ?? { total: new Decimal(0), net: new Decimal(0), runs: 0 };
        summed.set(b.period, {
          total: cur.total.plus(b.totalCostInUsdCents),
          net: cur.net.plus(b.netTotalCostInUsdCents),
          runs: cur.runs + b.runCount,
        });
      }
    }
    const combined = await get("/v1/stats/public/costs/timeseries", { campaignIds: family });
    expect(combined.buckets.map((b: any) => [b.period, b.totalCostInUsdCents, b.netTotalCostInUsdCents, b.runCount])).toEqual(
      [...summed.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([p, v]) => [p, v.total.toFixed(10), v.net.toFixed(10), v.runs]),
    );

    // Broken down per row: each campaign's slice equals its own per-row request.
    const split = await get("/v1/stats/public/costs/timeseries", { campaignIds: family, groupBy: "campaignId" });
    FAMILY.forEach((c, i) => {
      const mine = split.buckets.filter((b: any) => b.campaignId === c).map(({ campaignId: _c, ...rest }: any) => rest);
      expect(mine).toEqual(perRow[i].buckets);
    });

    // Untimed totals per row equal the sum of that row's dated buckets.
    const totals = (await get("/v1/stats/public/costs", { campaignIds: family, groupBy: "campaignId" })).groups as any[];
    for (const [i, c] of FAMILY.entries()) {
      const g = totals.find((t) => t.dimensions.campaignId === c);
      const dated = perRow[i].buckets.reduce((acc: Decimal, b: any) => acc.plus(b.totalCostInUsdCents), new Decimal(0));
      expect(g.totalCostInUsdCents).toBe(dated.toFixed(10));
    }
    expect(totals.map((t) => t.dimensions.campaignId)).not.toContain(C_OUTSIDE);
  });

  it("matches the live query through status transitions", async () => {
    await db.update(runsCosts).set({ status: "actual" }).where(eq(runsCosts.id, ids.k5));
    await db.update(runsCosts).set({ status: "refunded" }).where(eq(runsCosts.id, ids.k3));
    await db.update(runsCosts).set({ status: "cancelled" }).where(eq(runsCosts.id, ids.k2));
    await allComparisons();
  });

  it("matches the live query after deletes and runs moved across every key column", async () => {
    await db.delete(runsCosts).where(eq(runsCosts.id, ids.k7));
    await db.delete(runs).where(eq(runs.id, ids.r4)); // cascades k5 + k11
    await db.update(runs).set({ brandIds: [BRAND_OTHER] }).where(eq(runs.id, ids.r1)); // transfer-brand shape
    await db.update(runs).set({ campaignId: C3 }).where(eq(runs.id, ids.r2));
    await db.update(runs).set({ startedAt: new Date("2026-09-30T23:30:00Z") }).where(eq(runs.id, ids.r5));
    await db.update(runs).set({ workflowSlug: "wf-moved", featureSlug: FEAT_OTHER }).where(eq(runs.id, ids.r7));
    await db.update(runs).set({ campaignId: C1 }).where(eq(runs.id, ids.r9)); // gains a campaign
    await db.update(runs).set({ campaignId: null }).where(eq(runs.id, ids.r8)); // loses it
    await allComparisons();
  });

  it("a rebuild from the ledger reproduces the trigger-maintained state exactly", async () => {
    const snapshot = async () => ({
      runs: await sql`SELECT campaign_id, day::text, organization_id::text, brand_ids, feature_slug, workflow_slug, run_count::text
                      FROM stats_rollup_campaign_runs WHERE feature_slug IN (${FEAT}, ${FEAT_OTHER}) AND run_count <> 0
                      ORDER BY 1, 2, 3, 5, 6`,
      costs: await sql`SELECT campaign_id, day::text, organization_id::text, brand_ids, feature_slug, workflow_slug, cost_source,
                        n_actual::text, n_provisioned::text, n_cancelled::text, n_refunded::text,
                        gross_actual::numeric(30,10)::text, gross_provisioned::numeric(30,10)::text,
                        gross_cancelled::numeric(30,10)::text, gross_refunded::numeric(30,10)::text,
                        net_actual::numeric(30,10)::text, net_provisioned::numeric(30,10)::text, net_refunded::numeric(30,10)::text
                      FROM stats_rollup_campaign_costs
                      WHERE feature_slug IN (${FEAT}, ${FEAT_OTHER})
                        AND n_actual + n_provisioned + n_cancelled + n_refunded <> 0
                      ORDER BY 1, 2, 3, 5, 6, 7`,
    });
    const before = await snapshot();
    const result = await rebuildCampaignDayRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    expect(result.runGroups).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);
    await allComparisons();
  });

  it("a rebuild racing live writes still counts every row exactly once", async () => {
    const writes = (async () => {
      for (let i = 0; i < 25; i++) {
        const r = await insertTestRun({
          organizationId: ORG_ID, serviceName: "svc", taskName: "t", featureSlug: FEAT, workflowSlug: `wf-race-${i % 3}`,
          campaignId: FAMILY[i % 3], brandIds: [BRAND], startedAt: new Date(Date.UTC(2026, 8, 10 + (i % 4), i)),
        });
        await insertTestRunCost({ runId: r.id, costName: "c", quantity: "1", unitCostInUsdCents: "1.1", totalCostInUsdCents: "1.1", status: i % 2 ? "actual" : "provisioned" });
        if (i % 5 === 0) await db.update(runsCosts).set({ status: "cancelled" }).where(eq(runsCosts.runId, r.id));
      }
    })();
    const rebuilds = (async () => {
      for (let i = 0; i < 3; i++) await rebuildCampaignDayRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    })();
    await Promise.all([writes, rebuilds]);
    await allComparisons();
  });

  it("keeps the live query for anything finer than a campaign's UTC day", async () => {
    // Plant a row only the rollup can see: a request routed to the rollup counts
    // it, a request that must stay live does not.
    const PLANTED = randomUUID();
    await sql`INSERT INTO stats_rollup_campaign_runs (campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, run_count)
              VALUES (${PLANTED}, '2026-09-08', ${ORG_ID}, ${[BRAND]}, ${FEAT}, 'wf-a', 5)`;
    try {
      const routed = await get("/v1/stats/public/costs/timeseries", { campaignId: PLANTED });
      expect(routed.buckets).toHaveLength(1);
      for (const q of [
        { campaignId: PLANTED, tz: "America/New_York" },
        { campaignId: PLANTED, taskName: "t" },
        { campaignId: PLANTED, startedAfter: "2026-01-01T00:00:00Z" },
        { campaignId: PLANTED, startedBefore: "2027-01-01T00:00:00Z" },
      ]) {
        expect((await get("/v1/stats/public/costs/timeseries", q)).buckets).toEqual([]);
      }
      expect((await get("/v1/stats/public/costs", { campaignId: PLANTED, groupBy: "campaignId" })).groups).toHaveLength(1);
      expect((await get("/v1/stats/public/costs", { campaignId: PLANTED, groupBy: "campaignId", taskName: "t" })).groups).toEqual([]);
      expect((await get("/v1/stats/public/costs", { campaignId: PLANTED, groupBy: "serviceName" })).groups).toEqual([]);
    } finally {
      await sql`DELETE FROM stats_rollup_campaign_runs WHERE campaign_id = ${PLANTED}`;
    }
  });

  it("rejects a malformed campaignIds or timeseries groupBy with 400", async () => {
    // Short ids: 501 UUIDs overflow the 16 KB request-line limit before the route sees them.
    const tooMany = Array.from({ length: 501 }, (_, i) => `c${i}`).join(",");
    for (const [path, extra] of [
      ["/v1/stats/public/costs/timeseries", {}],
      ["/v1/stats/public/costs", { groupBy: "campaignId" }],
      ["/v1/stats/costs", { groupBy: "campaignId" }],
    ] as const) {
      for (const campaignIds of [" , ,", tooMany]) {
        const res = await request(app).get(path).set(headers).query({ ...extra, campaignIds });
        expect(res.status).toBe(400);
      }
    }
    const res = await request(app).get("/v1/stats/public/costs/timeseries").set(headers).query({ campaignIds: C1, groupBy: "workflowSlug" });
    expect(res.status).toBe(400);
  });

  it("GET /v1/stats/costs with campaignIds equals the per-row reads summed", async () => {
    const family2 = await get("/v1/stats/costs", { groupBy: "workflowSlug,campaignId", campaignIds: family });
    const perRow = await Promise.all(FAMILY.map((c) => get("/v1/stats/costs", { groupBy: "workflowSlug,campaignId", campaignId: c })));
    const key = (g: any) => JSON.stringify(g.dimensions);
    const flat = perRow.flatMap((b) => b.groups).sort((a: any, b: any) => key(a).localeCompare(key(b)));
    expect([...family2.groups].sort((a: any, b: any) => key(a).localeCompare(key(b)))).toEqual(flat);
    expect(family2.groups.map((g: any) => g.dimensions.campaignId)).not.toContain(C_OUTSIDE);
  });
});
