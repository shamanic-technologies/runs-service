import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";
import { AUDIENCE_DAY_ROLLUP_NAME, rebuildAudienceDayRollup } from "../../src/services/stats-rollup-brand.js";
import { repairStaleMinMax } from "../../src/services/stats-rollup-minmax-repair.js";

// The per-audience reads (migration 0052) — org-scoped GET /v1/stats/costs with
// audienceId grouped on (features-service: groupBy=audienceId,workflowSlug, org +
// brand + campaign family + feature slugs, optionally startedBefore) — must answer
// from the (campaign, UTC day, …, audience) rollup EXACTLY as the live query does,
// raw groups included, through inserts, status transitions, deletes, key moves,
// cost rows whose audience differs from their run's (a run then sits in several
// groups), concurrent writes on one run, and rebuilds racing writes. Each
// comparison runs the same request with the rollup stamped ready and without.

const ORG_ID = "7a520000-1111-4aaa-8aaa-111111111111";
const OTHER_ORG_ID = "7a520000-2222-4aaa-8aaa-222222222222";
const CLEANUP = [ORG_ID, OTHER_ORG_ID];
const SUFFIX = randomUUID().slice(0, 8);
const FEAT = `aud-rollup-${SUFFIX}`;
const FEAT_SRC = `aud-rollup-src-${SUFFIX}`;
const BRAND = randomUUID();
const BRAND_OTHER = randomUUID();
const C1 = randomUUID();
const C2 = randomUUID();
const A1 = randomUUID();
const A2 = randomUUID();
const A3 = randomUUID();

const app = createTestApp();
const headers = getAuthHeaders({ orgId: ORG_ID });

async function readyStamp(ready: boolean) {
  if (ready) {
    await sql`INSERT INTO stats_rollups (name, ready_at) VALUES (${AUDIENCE_DAY_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  } else {
    await sql`DELETE FROM stats_rollups WHERE name = ${AUDIENCE_DAY_ROLLUP_NAME}`;
  }
}

async function getRaw(query: Record<string, string>) {
  const res = await request(app).get("/v1/stats/costs").set(headers).query(query);
  expect(res.status).toBe(200);
  return res;
}

const key = (g: any) => JSON.stringify(g.dimensions);
const byKey = (a: any[]) => [...a].sort((x, y) => key(x).localeCompare(key(y)));

async function expectEqual(query: Record<string, string>, opts: { nonEmpty?: boolean } = {}) {
  await readyStamp(true);
  const rolled = (await getRaw(query)).body.groups as any[];
  await readyStamp(false);
  const live = (await getRaw(query)).body.groups as any[];
  await readyStamp(true);
  if (opts.nonEmpty !== false) expect(live.length).toBeGreaterThan(0);
  // ORDER BY total_cost (text) DESC is the contract; ties have no defined order.
  expect(rolled.map((g) => g.totalCostInUsdCents)).toEqual(live.map((g) => g.totalCostInUsdCents));
  expect(byKey(rolled)).toEqual(byKey(live));
}

const features = `${FEAT},${FEAT_SRC}`;
const BOUNDS: Record<string, string>[] = [
  {},
  { startedBefore: "2026-09-08T23:59:59.999Z" },
  { startedBefore: "2026-09-08T12:30:00Z" }, // cuts through a day holding runs
  { startedAfter: "2026-09-08T00:00:00.000Z" },
  { startedAfter: "2026-09-08T11:00:00Z", startedBefore: "2026-09-08T13:30:00Z" },
];

async function allComparisons() {
  for (const bounds of BOUNDS) {
    for (const groupBy of ["audienceId,workflowSlug", "audienceId", "audienceId,campaignId", "featureSlug,audienceId"]) {
      await expectEqual({ groupBy, brandId: BRAND, featureSlugs: features, ...bounds }, { nonEmpty: false });
      await expectEqual({ groupBy, brandId: BRAND, featureSlugs: features, campaignIds: `${C1},${C2}`, ...bounds }, { nonEmpty: false });
    }
  }
  await expectEqual({ groupBy: "audienceId,workflowSlug", brandId: BRAND, featureSlugs: features });
  await expectEqual({ groupBy: "audienceId,workflowSlug", brandId: BRAND, campaignIds: `${C1},${C2}`, featureSlugs: features, startedBefore: "2026-09-30T12:00:00Z" });
  await expectEqual({ groupBy: "audienceId", featureSlug: FEAT });
  await expectEqual({ groupBy: "audienceId,workflowSlug", brandId: BRAND, campaignId: C1 });
  await expectEqual({ groupBy: "audienceId", brandId: BRAND, workflowSlug: "wf-a" });
  await expectEqual({ groupBy: "audienceId", brandId: BRAND_OTHER }, { nonEmpty: false });
}

const ids: Record<string, string> = {};

afterAll(async () => {
  await cleanTestData(CLEANUP);
  await readyStamp(true);
  await closeDb();
});

describe("audience rollup — org-scoped per-audience cost reads (migration 0052)", () => {
  beforeAll(async () => {
    await cleanTestData(CLEANUP);
    await readyStamp(true);

    const run = async (k: string, o: { org?: string; campaign?: string; at: string; workflow?: string; feature?: string; brands?: string[]; audience?: string }) => {
      const r = await insertTestRun({
        organizationId: o.org ?? ORG_ID, serviceName: "svc", taskName: "t",
        featureSlug: o.feature ?? FEAT, workflowSlug: o.workflow, campaignId: o.campaign,
        brandIds: o.brands ?? [BRAND], startedAt: new Date(o.at), audienceId: o.audience,
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

    const r1 = await run("r1", { campaign: C1, at: "2026-09-07T23:59:59Z", workflow: "wf-a", audience: A1 });
    const r2 = await run("r2", { campaign: C1, at: "2026-09-08T00:00:01Z", workflow: "wf-a", audience: A1 });
    await run("r3", { campaign: C1, at: "2026-09-08T10:00:00Z", workflow: "wf-a", audience: A2 }); // no cost
    const r4 = await run("r4", { campaign: C2, at: "2026-09-08T12:00:00Z", workflow: "wf-b" }); // no run audience
    const r5 = await run("r5", { campaign: C2, at: "2026-09-21T12:00:00Z", audience: A2 }); // NULL workflow
    const r6 = await run("r6", { at: "2026-09-08T13:00:00Z", workflow: "wf-a", audience: A1 }); // no campaign
    const r7 = await run("r7", { at: "2026-09-08T23:59:59.9995Z", workflow: "wf-a", feature: FEAT_SRC, audience: A3 });
    const r8 = await run("r8", { campaign: C2, at: "2026-09-08T13:00:00Z", workflow: "wf-b", org: OTHER_ORG_ID, audience: A1 });
    const r9 = await run("r9", { campaign: C1, at: "2026-09-08T15:00:00Z", workflow: "wf-a", brands: [BRAND, BRAND_OTHER], audience: A1 });
    await run("r10", { at: "2026-10-01T09:00:00Z" }); // NULL everything, cost-less

    await cost("k1", r1, "actual", "12.3456789012", { netCostInUsdCents: "6.1728394506", usageDiscountPct: "0.5" });
    await cost("k2", r1, "provisioned", "0.0000000001");
    await cost("k3", r2, "actual", "100");
    await cost("k4", r2, "cancelled", "7.5", { audienceId: A2 }); // r2 now sits under A1 AND A2
    await cost("k5", r4, "provisioned", "3.3333333333", { audienceId: A3 }); // run without audience, cost with
    await cost("k6", r4, "actual", "0"); // a matched row summing to zero, effective audience NULL
    await cost("k7", r5, "actual", "0.25", { costSource: "org" });
    await cost("k8", r6, "actual", "2000");
    await cost("k9", r7, "refunded", "1.5");
    await cost("k10", r8, "actual", "4");
    await cost("k11", r9, "actual", "5.5", { audienceId: A1 });
  });

  it("matches the live query after inserts (a run counts once per distinct audience)", async () => {
    await allComparisons();
    const groups = (await getRaw({ groupBy: "audienceId", brandId: BRAND, featureSlugs: features })).body.groups as any[];
    const a2 = groups.find((g) => g.dimensions.audienceId === A2);
    expect(a2.runCount).toBe(3); // r2 (via its A2 cost row), r3, r5
    const none = groups.find((g) => g.dimensions.audienceId === null);
    expect(none.runCount).toBe(2); // r4 (its NULL cost row), r10
  });

  it("is actually served by the rollup (planted row counted, finer filters stay live)", async () => {
    const PLANTED = randomUUID();
    await sql`INSERT INTO stats_rollup_audience_runs (campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, audience_id, run_count, min_started_at, max_started_at)
              VALUES (${C1}, '2026-09-15', ${ORG_ID}, ${[BRAND]}, ${FEAT}, 'wf-a', ${PLANTED}, 5, '2026-09-15T01:00:00Z', '2026-09-15T02:00:00Z')`;
    try {
      const planted = (g: any) => g.dimensions.audienceId === PLANTED;
      const served = (await getRaw({ groupBy: "audienceId,workflowSlug", brandId: BRAND, featureSlugs: features })).body.groups;
      expect(served.find(planted)?.runCount).toBe(5);
      for (const q of [
        { groupBy: "audienceId", brandId: BRAND, taskName: "t" },
        { groupBy: "audienceId,serviceName", brandId: BRAND },
        { groupBy: "audienceId", brandId: BRAND, goal: "g" },
        { groupBy: "audienceId,costName", brandId: BRAND },
        { groupBy: "audienceId", brandId: BRAND, attributionStatus: "tagged" },
      ]) {
        const groups = (await getRaw(q)).body.groups;
        expect(groups.some(planted)).toBe(false);
      }
    } finally {
      await sql`DELETE FROM stats_rollup_audience_runs WHERE audience_id = ${PLANTED}`;
    }
  });

  it("matches the live query through status transitions", async () => {
    await db.update(runsCosts).set({ status: "actual" }).where(eq(runsCosts.id, ids.k5));
    await db.update(runsCosts).set({ status: "refunded" }).where(eq(runsCosts.id, ids.k3));
    await db.update(runsCosts).set({ status: "cancelled" }).where(eq(runsCosts.id, ids.k2));
    await allComparisons();
  });

  it("matches the live query after cost-row audience moves and cost deletes", async () => {
    await db.update(runsCosts).set({ audienceId: A3 }).where(eq(runsCosts.id, ids.k4)); // r2: A1+A2 -> A1+A3
    await db.update(runsCosts).set({ audienceId: null }).where(eq(runsCosts.id, ids.k5)); // r4: A3+NULL -> NULL
    await db.update(runsCosts).set({ runId: ids.r3 }).where(eq(runsCosts.id, ids.k9)); // r7 loses its only row, r3 gains one
    await db.delete(runsCosts).where(eq(runsCosts.id, ids.k11)); // r9 back to no cost row
    await allComparisons();
  });

  it("matches the live query after run deletes and key moves (stale min/max read live, then repaired)", async () => {
    await db.delete(runs).where(eq(runs.id, ids.r1));
    await db.update(runs).set({ brandIds: [BRAND_OTHER] }).where(eq(runs.id, ids.r4)); // transfer-brand shape
    await db.update(runs).set({ campaignId: C2 }).where(eq(runs.id, ids.r2));
    await db.update(runs).set({ startedAt: new Date("2026-09-30T23:30:00Z") }).where(eq(runs.id, ids.r5));
    await db.update(runs).set({ audienceId: A2 }).where(eq(runs.id, ids.r6)); // run audience change
    const stale = async () => (await sql`SELECT count(*)::int AS n FROM stats_rollup_audience_runs
                                          WHERE organization_id = ${ORG_ID} AND minmax_stale AND run_count <> 0`)[0].n;
    expect(await stale()).toBeGreaterThan(0);
    await allComparisons();
    const results = await repairStaleMinMax(sql, 1000);
    const audience = results.find((r) => r.table === "stats_rollup_audience_runs")!;
    expect(audience.mismatched).toBe(0);
    expect(await stale()).toBe(0);
    await allComparisons();
  });

  it("concurrent cost writes on one run keep its membership exact", async () => {
    // Every run's FIRST cost rows race: without the per-run lock, two writers each
    // see no other row, and both remove the run from its own audience's group.
    const RUNS = 12;
    const created = await Promise.all([...Array(RUNS).keys()].map((i) => insertTestRun({
      organizationId: ORG_ID, serviceName: "svc", taskName: "t", featureSlug: FEAT, workflowSlug: "wf-c",
      campaignId: C1, brandIds: [BRAND], startedAt: new Date(Date.UTC(2026, 8, 9, i)), audienceId: A1,
    })));
    await Promise.all(created.flatMap((r) => [A2, A3, A2, null, A3, A2].map((aud) =>
      insertTestRunCost({ runId: r.id, costName: "c", quantity: "1", unitCostInUsdCents: "1", totalCostInUsdCents: "1", status: "actual", ...(aud ? { audienceId: aud } : {}) }),
    )));
    await allComparisons();
    const counts = await sql`SELECT audience_id, sum(run_count)::int AS n FROM stats_rollup_audience_runs
                             WHERE workflow_slug = 'wf-c' AND organization_id = ${ORG_ID} GROUP BY 1 ORDER BY 2, 1`;
    // Each run: A1 (its NULL cost row), A2, A3.
    expect(counts.map((c) => [c.audience_id, c.n]).sort()).toEqual([[A1, RUNS], [A2, RUNS], [A3, RUNS]].sort());
  });

  it("a rebuild reproduces the trigger-maintained rollup, with exact min/max", async () => {
    const snapshot = async () => ({
      runs: await sql`SELECT campaign_id, day::text, organization_id::text, brand_ids, feature_slug, workflow_slug, audience_id, run_count::text
                      FROM stats_rollup_audience_runs WHERE organization_id IN (${ORG_ID}, ${OTHER_ORG_ID}) AND run_count <> 0
                      ORDER BY 1, 2, 3, 4, 5, 6, 7`,
      costs: await sql`SELECT campaign_id, day::text, organization_id::text, brand_ids, feature_slug, workflow_slug, audience_id,
                        n_actual::text, n_provisioned::text, n_cancelled::text, n_refunded::text,
                        gross_actual::numeric(30,10)::text, gross_provisioned::numeric(30,10)::text,
                        gross_cancelled::numeric(30,10)::text, gross_refunded::numeric(30,10)::text,
                        net_actual::numeric(30,10)::text, net_provisioned::numeric(30,10)::text, net_refunded::numeric(30,10)::text
                      FROM stats_rollup_audience_costs
                      WHERE organization_id IN (${ORG_ID}, ${OTHER_ORG_ID})
                        AND n_actual + n_provisioned + n_cancelled + n_refunded <> 0
                      ORDER BY 1, 2, 3, 4, 5, 6, 7`,
    });
    const before = await snapshot();
    expect(before.runs.length).toBeGreaterThan(0);
    await rebuildAudienceDayRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    expect(await snapshot()).toEqual(before);
    const [{ stale }] = await sql`SELECT count(*)::int AS stale FROM stats_rollup_audience_runs WHERE organization_id = ${ORG_ID} AND minmax_stale`;
    expect(stale).toBe(0);
    await allComparisons();
  });

  it("a rebuild racing live writes and removals still counts every run once", async () => {
    const writes = (async () => {
      for (let i = 0; i < 20; i++) {
        const r = await insertTestRun({
          organizationId: ORG_ID, serviceName: "svc", taskName: "t", featureSlug: FEAT, workflowSlug: `wf-race-${i % 3}`,
          campaignId: i % 4 === 0 ? undefined : [C1, C2][i % 2], brandIds: [BRAND], startedAt: new Date(Date.UTC(2026, 8, 8 + (i % 4), i)),
          audienceId: [A1, A2, undefined][i % 3],
        });
        await insertTestRunCost({ runId: r.id, costName: "c", quantity: "1", unitCostInUsdCents: "1.1", totalCostInUsdCents: "1.1", status: i % 2 ? "actual" : "provisioned", ...(i % 5 === 1 ? { audienceId: A3 } : {}) });
        if (i % 5 === 0) await db.delete(runs).where(eq(runs.id, r.id));
      }
    })();
    const rebuilds = (async () => {
      for (let i = 0; i < 3; i++) await rebuildAudienceDayRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    })();
    await Promise.all([writes, rebuilds]);
    await allComparisons();
  });
});
