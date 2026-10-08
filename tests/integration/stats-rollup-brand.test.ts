import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";
import { CAMPAIGN_DAY_ROLLUP_NAME, rebuildCampaignDayRollup } from "../../src/services/stats-rollup-campaign.js";

// The brand-history reads (migration 0041) — org-scoped GET /v1/stats/costs
// grouped by workflow / campaign / feature, with or without startedAfter /
// startedBefore, and the public timeseries with bounds or without a campaign —
// must answer from the (campaign, UTC day) rollup EXACTLY as the live query does,
// raw body included, through every write the ledger sees: inserts, status
// transitions, deletes and key moves (which make a group's min/max stale), and
// rebuilds racing writes. Each comparison runs the same request with the rollup
// stamped ready and with the stamp removed (the live query).

const ORG_ID = "7a330000-1111-4aaa-8aaa-111111111111";
const OTHER_ORG_ID = "7a330000-2222-4aaa-8aaa-222222222222";
const CLEANUP = [ORG_ID, OTHER_ORG_ID];
const SUFFIX = randomUUID().slice(0, 8);
const FEAT = `brand-rollup-${SUFFIX}`;
const FEAT_SRC = `brand-rollup-src-${SUFFIX}`;
const FEAT_OTHER = `brand-rollup-other-${SUFFIX}`;
const BRAND = randomUUID();
const BRAND_OTHER = randomUUID();
const C1 = randomUUID();
const C2 = randomUUID();

const app = createTestApp();
const headers = getAuthHeaders({ orgId: ORG_ID });

async function readyStamp(ready: boolean) {
  if (ready) {
    await sql`INSERT INTO stats_rollups (name, ready_at) VALUES (${CAMPAIGN_DAY_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  } else {
    await sql`DELETE FROM stats_rollups WHERE name = ${CAMPAIGN_DAY_ROLLUP_NAME}`;
  }
}

async function getRaw(path: string, query: Record<string, string>) {
  const res = await request(app).get(path).set(headers).query(query);
  expect(res.status).toBe(200);
  return res;
}

const key = (g: any) => JSON.stringify(g.dimensions);
const byKey = (a: any[]) => [...a].sort((x, y) => key(x).localeCompare(key(y)));

/** Rollup vs live for one org-scoped GET /v1/stats/costs request. */
async function expectCostsEqual(query: Record<string, string>, opts: { nonEmpty?: boolean } = {}) {
  await readyStamp(true);
  const rolled = (await getRaw("/v1/stats/costs", query)).body.groups as any[];
  await readyStamp(false);
  const live = (await getRaw("/v1/stats/costs", query)).body.groups as any[];
  await readyStamp(true);
  if (opts.nonEmpty !== false) expect(live.length).toBeGreaterThan(0);
  // ORDER BY total_cost (text) DESC is the contract; ties have no defined order
  // in either read, so compare the totals' sequence, then the groups by key.
  expect(rolled.map((g) => g.totalCostInUsdCents)).toEqual(live.map((g) => g.totalCostInUsdCents));
  expect(byKey(rolled)).toEqual(byKey(live));
}

/** Rollup vs live for one public timeseries request, raw body (order is total). */
async function expectTimeseriesEqual(query: Record<string, string>) {
  await readyStamp(true);
  const rolled = (await getRaw("/v1/stats/public/costs/timeseries", query)).text;
  await readyStamp(false);
  const live = (await getRaw("/v1/stats/public/costs/timeseries", query)).text;
  await readyStamp(true);
  expect(JSON.parse(live).buckets.length).toBeGreaterThan(0);
  expect(rolled).toBe(live);
}

const features = `${FEAT},${FEAT_SRC}`;
// The shapes features-service sends: whole history, the past half (startedBefore
// = a UTC midnight - 1 ms), the today half / maturity cutoff (startedAfter = a
// UTC midnight), plus bounds that cut through a day holding runs.
const BOUNDS: Record<string, string>[] = [
  {},
  { startedBefore: "2026-09-08T23:59:59.999Z" },
  { startedAfter: "2026-09-08T00:00:00.000Z" },
  { startedAfter: "2026-09-08T11:00:00Z" },
  { startedBefore: "2026-09-08T12:30:00Z" },
  { startedAfter: "2026-09-08T00:00:00Z", startedBefore: "2026-09-21T23:59:59.999Z" },
  { startedAfter: "2026-09-08T11:00:00Z", startedBefore: "2026-09-08T13:30:00Z" },
];

async function allComparisons() {
  for (const bounds of BOUNDS) {
    for (const groupBy of ["workflowSlug,campaignId", "workflowSlug", "campaignId", "featureSlug", "campaignId,featureSlug"]) {
      await expectCostsEqual({ groupBy, brandId: BRAND, featureSlugs: features, ...bounds }, { nonEmpty: false });
    }
  }
  await expectCostsEqual({ groupBy: "workflowSlug,campaignId", brandId: BRAND, featureSlugs: features });
  await expectCostsEqual({ groupBy: "workflowSlug", featureSlug: FEAT });
  await expectCostsEqual({ groupBy: "campaignId", brandId: BRAND, campaignIds: `${C1},${C2}` });
  await expectCostsEqual({ groupBy: "workflowSlug", brandId: BRAND, campaignId: C1, startedAfter: "2026-09-08T00:00:00Z" });
  await expectCostsEqual({ groupBy: "campaignId", brandId: BRAND, workflowSlug: "wf-a", featureSlugs: features });
  await expectCostsEqual({ groupBy: "campaignId", brandId: BRAND_OTHER });

  for (const q of [
    { orgId: ORG_ID, brandId: BRAND, featureSlugs: features },
    { orgId: ORG_ID, brandId: BRAND, featureSlugs: features, startedAfter: "2026-09-08T00:00:00Z" },
    { orgId: ORG_ID, brandId: BRAND, featureSlugs: features, startedAfter: "2026-09-08T11:00:00Z" },
    { orgId: ORG_ID, featureSlugs: features, groupBy: "campaignId", startedAfter: "2026-09-01T00:00:00.000Z" },
    { orgId: ORG_ID, brandId: BRAND, interval: "week", startedBefore: "2026-09-08T12:30:00Z" },
    { brandId: BRAND, featureSlug: FEAT, interval: "month" },
    { orgId: ORG_ID, costSource: "platform", campaignIds: `${C1},${C2}`, startedAfter: "2026-09-08T00:00:00Z" },
  ]) {
    await expectTimeseriesEqual(q);
  }
}

const ids: Record<string, string> = {};

afterAll(async () => {
  await cleanTestData(CLEANUP);
  await readyStamp(true);
  await closeDb();
});

describe("brand-history rollup — org-scoped cost reads (migration 0041)", () => {
  beforeAll(async () => {
    await cleanTestData(CLEANUP);
    await readyStamp(true);

    const run = async (k: string, o: { org?: string; campaign?: string; at: string; workflow?: string; feature?: string; brands?: string[] }) => {
      const r = await insertTestRun({
        organizationId: o.org ?? ORG_ID, serviceName: "svc", taskName: "t",
        featureSlug: o.feature ?? FEAT, workflowSlug: o.workflow, campaignId: o.campaign,
        brandIds: o.brands ?? [BRAND], startedAt: new Date(o.at),
      });
      ids[k] = r.id;
      return r.id;
    };
    const cost = async (k: string, runId: string, status: string, total: string, extra: Record<string, string> = {}) => {
      const c = await insertTestRunCost({
        runId, costName: "c", quantity: "1", unitCostInUsdCents: total, totalCostInUsdCents: total, status, ...extra,
      });
      ids[k] = c.id;
    };

    const r1 = await run("r1", { campaign: C1, at: "2026-09-07T23:59:59Z", workflow: "wf-a" });
    const r2 = await run("r2", { campaign: C1, at: "2026-09-08T00:00:01Z", workflow: "wf-a" });
    await run("r3", { campaign: C1, at: "2026-09-08T10:00:00Z", workflow: "wf-a" }); // no cost
    const r4 = await run("r4", { campaign: C2, at: "2026-09-08T12:00:00Z", workflow: "wf-b" });
    const r5 = await run("r5", { campaign: C2, at: "2026-09-21T12:00:00Z" }); // NULL workflow
    const r6 = await run("r6", { at: "2026-09-08T13:00:00Z", workflow: "wf-a" }); // no campaign
    const r7 = await run("r7", { at: "2026-09-08T23:59:59.9995Z", workflow: "wf-a", feature: FEAT_SRC }); // inside the last ms
    const r8 = await run("r8", { campaign: C2, at: "2026-09-08T13:00:00Z", workflow: "wf-b", org: OTHER_ORG_ID });
    const r9 = await run("r9", { at: "2026-09-08T14:00:00Z", workflow: "wf-a", feature: FEAT_OTHER }); // other feature
    const r10 = await run("r10", { campaign: C1, at: "2026-09-08T15:00:00Z", workflow: "wf-a", brands: [BRAND, BRAND_OTHER] });
    await run("r11", { at: "2026-10-01T09:00:00Z" }); // NULL campaign + workflow, cost-less

    await cost("k1", r1, "actual", "12.3456789012", { netCostInUsdCents: "6.1728394506", usageDiscountPct: "0.5" });
    await cost("k2", r1, "provisioned", "0.0000000001");
    await cost("k3", r2, "actual", "100");
    await cost("k4", r2, "cancelled", "7.5");
    await cost("k5", r4, "provisioned", "3.3333333333");
    await cost("k6", r5, "actual", "0.25", { costSource: "org" });
    await cost("k7", r6, "actual", "2000");
    await cost("k8", r7, "refunded", "1.5");
    await cost("k9", r8, "actual", "4");
    await cost("k10", r9, "actual", "9.99");
    await cost("k11", r4, "actual", "0"); // a matched row summing to zero
    await cost("k12", r10, "actual", "5.5");
  });

  it("matches the live query after inserts", async () => {
    await allComparisons();
    const body = (await getRaw("/v1/stats/costs", { groupBy: "campaignId", brandId: BRAND, featureSlugs: features })).body;
    const none = body.groups.find((g: any) => g.dimensions.campaignId === null);
    expect(none.runCount).toBe(3); // r6, r7, r11: runs with no campaign are rolled up too
    expect(none.minStartedAt).toBe("2026-09-08T13:00:00.000Z");
    expect(none.maxStartedAt).toBe("2026-10-01T09:00:00.000Z");
  });

  it("is actually served by the rollup (planted rollup row is counted, finer filters stay live)", async () => {
    const PLANTED = randomUUID();
    await sql`INSERT INTO stats_rollup_campaign_runs (campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, run_count, min_started_at, max_started_at)
              VALUES (${PLANTED}, '2026-09-15', ${ORG_ID}, ${[BRAND]}, ${FEAT}, 'wf-a', 5, '2026-09-15T01:00:00Z', '2026-09-15T02:00:00Z')`;
    try {
      const planted = (g: any) => g.dimensions.campaignId === PLANTED;
      const served = (await getRaw("/v1/stats/costs", { groupBy: "campaignId", brandId: BRAND })).body.groups;
      expect(served.find(planted)?.runCount).toBe(5);
      const bounded = (await getRaw("/v1/stats/costs", { groupBy: "campaignId", brandId: BRAND, startedAfter: "2026-09-10T00:00:00Z" })).body.groups;
      expect(bounded.find(planted)?.minStartedAt).toBe("2026-09-15T01:00:00.000Z");
      for (const q of [
        { groupBy: "campaignId", brandId: BRAND, taskName: "t" },
        { groupBy: "campaignId", brandId: BRAND, serviceName: "svc" },
        { groupBy: "campaignId,serviceName", brandId: BRAND },
        { groupBy: "campaignId", brandId: BRAND, audienceId: randomUUID() },
        { groupBy: "brandId" },
      ]) {
        const groups = (await getRaw("/v1/stats/costs", q)).body.groups;
        expect(groups.some(planted)).toBe(false);
      }
      const ts = JSON.parse((await getRaw("/v1/stats/public/costs/timeseries", { orgId: ORG_ID, brandId: BRAND })).text);
      expect(ts.buckets.find((b: any) => b.period === "2026-09-15")?.runCount).toBe(5);
      const tsLive = JSON.parse((await getRaw("/v1/stats/public/costs/timeseries", { orgId: ORG_ID, brandId: BRAND, tz: "Europe/Paris" })).text);
      expect(tsLive.buckets.find((b: any) => b.period === "2026-09-15")).toBeUndefined();
    } finally {
      await sql`DELETE FROM stats_rollup_campaign_runs WHERE campaign_id = ${PLANTED}`;
    }
  });

  it("matches the live query through status transitions", async () => {
    await db.update(runsCosts).set({ status: "actual" }).where(eq(runsCosts.id, ids.k5));
    await db.update(runsCosts).set({ status: "refunded" }).where(eq(runsCosts.id, ids.k3));
    await db.update(runsCosts).set({ status: "cancelled" }).where(eq(runsCosts.id, ids.k2));
    await allComparisons();
  });

  it("matches the live query after deletes and key moves (stale min/max read live)", async () => {
    // r1 is the min of its group's day; r6 the only run of its (NULL campaign) group's day.
    await db.delete(runs).where(eq(runs.id, ids.r1));
    await db.update(runs).set({ brandIds: [BRAND_OTHER] }).where(eq(runs.id, ids.r4)); // transfer-brand shape
    await db.update(runs).set({ campaignId: C2 }).where(eq(runs.id, ids.r2));
    await db.update(runs).set({ startedAt: new Date("2026-09-30T23:30:00Z") }).where(eq(runs.id, ids.r5));
    await db.update(runs).set({ campaignId: C1 }).where(eq(runs.id, ids.r6)); // gains a campaign
    await db.delete(runsCosts).where(eq(runsCosts.id, ids.k12));
    const [{ stale }] = await sql`SELECT count(*)::int AS stale FROM stats_rollup_campaign_runs
                                  WHERE organization_id = ${ORG_ID} AND minmax_stale AND run_count <> 0`;
    expect(stale).toBeGreaterThan(0);
    await allComparisons();
  });

  it("a rebuild reproduces the trigger-maintained counts and money, with exact min/max", async () => {
    const snapshot = async () => ({
      runs: await sql`SELECT campaign_id, day::text, organization_id::text, brand_ids, feature_slug, workflow_slug, run_count::text
                      FROM stats_rollup_campaign_runs WHERE feature_slug IN (${FEAT}, ${FEAT_SRC}, ${FEAT_OTHER}) AND run_count <> 0
                      ORDER BY 1, 2, 3, 4, 5, 6`,
      costs: await sql`SELECT campaign_id, day::text, organization_id::text, brand_ids, feature_slug, workflow_slug, cost_source,
                        n_actual::text, n_provisioned::text, n_cancelled::text, n_refunded::text,
                        gross_actual::numeric(30,10)::text, net_actual::numeric(30,10)::text, gross_refunded::numeric(30,10)::text
                      FROM stats_rollup_campaign_costs
                      WHERE feature_slug IN (${FEAT}, ${FEAT_SRC}, ${FEAT_OTHER})
                        AND n_actual + n_provisioned + n_cancelled + n_refunded <> 0
                      ORDER BY 1, 2, 3, 4, 5, 6, 7`,
    });
    const before = await snapshot();
    await rebuildCampaignDayRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    expect(await snapshot()).toEqual(before);
    const [{ stale }] = await sql`SELECT count(*)::int AS stale FROM stats_rollup_campaign_runs
                                  WHERE organization_id = ${ORG_ID} AND minmax_stale`;
    expect(stale).toBe(0);
    const [{ wrong }] = await sql`
      SELECT count(*)::int AS wrong FROM stats_rollup_campaign_runs g
      CROSS JOIN LATERAL (
        SELECT min(r.started_at) AS mn, max(r.started_at) AS mx FROM runs r
        WHERE r.organization_id = g.organization_id AND (r.started_at AT TIME ZONE 'UTC')::date = g.day
          AND r.campaign_id IS NOT DISTINCT FROM g.campaign_id AND r.brand_ids IS NOT DISTINCT FROM g.brand_ids
          AND r.feature_slug IS NOT DISTINCT FROM g.feature_slug AND r.workflow_slug IS NOT DISTINCT FROM g.workflow_slug
      ) truth
      WHERE g.organization_id = ${ORG_ID} AND g.run_count > 0
        AND (g.min_started_at IS DISTINCT FROM truth.mn OR g.max_started_at IS DISTINCT FROM truth.mx)`;
    expect(wrong).toBe(0);
    await allComparisons();
  });

  it("a rebuild racing live writes and removals still counts every run once", async () => {
    const writes = (async () => {
      for (let i = 0; i < 20; i++) {
        const r = await insertTestRun({
          organizationId: ORG_ID, serviceName: "svc", taskName: "t", featureSlug: FEAT, workflowSlug: `wf-race-${i % 3}`,
          campaignId: i % 4 === 0 ? undefined : [C1, C2][i % 2], brandIds: [BRAND], startedAt: new Date(Date.UTC(2026, 8, 8 + (i % 4), i)),
        });
        await insertTestRunCost({ runId: r.id, costName: "c", quantity: "1", unitCostInUsdCents: "1.1", totalCostInUsdCents: "1.1", status: i % 2 ? "actual" : "provisioned" });
        if (i % 5 === 0) await db.delete(runs).where(eq(runs.id, r.id));
      }
    })();
    const rebuilds = (async () => {
      for (let i = 0; i < 3; i++) await rebuildCampaignDayRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    })();
    await Promise.all([writes, rebuilds]);
    await allComparisons();
  });
});
