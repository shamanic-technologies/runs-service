import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";
import { COST_NAME_DAY_ROLLUP_NAME, rebuildCostNameDayRollup } from "../../src/services/stats-rollup-brand.js";
import { repairStaleMinMax } from "../../src/services/stats-rollup-minmax-repair.js";

// The brand spend breakdown (migration 0053) — org-scoped GET /v1/stats/costs with
// costName grouped on (features-service: groupBy=costName or costName,campaignId,
// org + brand + feature slugs, lifetime and startedAfter=<UTC midnight>) — must
// answer from the (campaign, UTC day, …, cost name) rollup EXACTLY as the live
// query does, raw groups and totalQuantity included, through inserts, status
// transitions, cost-name moves, deletes, key moves, concurrent first rows on one
// run, and rebuilds racing writes. Each comparison runs the same request with the
// rollup stamped ready and without.

const ORG_ID = "7a530000-1111-4aaa-8aaa-111111111111";
const OTHER_ORG_ID = "7a530000-2222-4aaa-8aaa-222222222222";
const CLEANUP = [ORG_ID, OTHER_ORG_ID];
const SUFFIX = randomUUID().slice(0, 8);
const FEAT = `cn-rollup-${SUFFIX}`;
const FEAT_SRC = `cn-rollup-src-${SUFFIX}`;
const BRAND = randomUUID();
const BRAND_OTHER = randomUUID();
const C1 = randomUUID();
const C2 = randomUUID();

const app = createTestApp();
const headers = getAuthHeaders({ orgId: ORG_ID });

async function readyStamp(ready: boolean) {
  if (ready) {
    await sql`INSERT INTO stats_rollups (name, ready_at) VALUES (${COST_NAME_DAY_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  } else {
    await sql`DELETE FROM stats_rollups WHERE name = ${COST_NAME_DAY_ROLLUP_NAME}`;
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
  { startedAfter: "2026-09-08T00:00:00.000Z" }, // the "today" read
  { startedBefore: "2026-09-08T23:59:59.999Z" },
  { startedBefore: "2026-09-08T12:30:00Z" }, // cuts through a day holding runs
  { startedAfter: "2026-09-08T11:00:00Z", startedBefore: "2026-09-08T13:30:00Z" },
];

async function allComparisons() {
  for (const bounds of BOUNDS) {
    for (const groupBy of ["costName", "costName,campaignId", "costName,workflowSlug", "featureSlug,costName"]) {
      await expectEqual({ groupBy, brandId: BRAND, featureSlugs: features, ...bounds }, { nonEmpty: false });
      await expectEqual({ groupBy, brandId: BRAND, featureSlugs: features, campaignIds: `${C1},${C2}`, ...bounds }, { nonEmpty: false });
    }
  }
  await expectEqual({ groupBy: "costName", brandId: BRAND, featureSlugs: features });
  await expectEqual({ groupBy: "costName", brandId: BRAND, featureSlugs: features, workflowSlugs: "wf-a,wf-b" }, { nonEmpty: false });
  await expectEqual({ groupBy: "costName", featureSlug: FEAT });
  await expectEqual({ groupBy: "costName,campaignId", brandId: BRAND, campaignId: C1 }, { nonEmpty: false });
  await expectEqual({ groupBy: "costName", brandId: BRAND_OTHER }, { nonEmpty: false });
}

const ids: Record<string, string> = {};

afterAll(async () => {
  await cleanTestData(CLEANUP);
  await readyStamp(true);
  await closeDb();
});

describe("cost-name rollup — org-scoped brand spend breakdown (migration 0053)", () => {
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
    const cost = async (k: string, runId: string, name: string, status: string, total: string, extra: Record<string, string> = {}) => {
      const c = await insertTestRunCost({
        runId, costName: name, quantity: extra.quantity ?? "1.5", unitCostInUsdCents: total, totalCostInUsdCents: total, status, ...extra,
      });
      ids[k] = c.id;
    };

    const r1 = await run("r1", { campaign: C1, at: "2026-09-07T23:59:59Z", workflow: "wf-a" });
    const r2 = await run("r2", { campaign: C1, at: "2026-09-08T00:00:01Z", workflow: "wf-a" });
    await run("r3", { campaign: C1, at: "2026-09-08T10:00:00Z", workflow: "wf-a" }); // no cost: in no group
    const r4 = await run("r4", { campaign: C2, at: "2026-09-08T12:00:00Z", workflow: "wf-b" });
    const r5 = await run("r5", { campaign: C2, at: "2026-09-21T12:00:00Z" }); // NULL workflow
    const r6 = await run("r6", { at: "2026-09-08T13:00:00Z", workflow: "wf-a" }); // no campaign
    const r7 = await run("r7", { at: "2026-09-08T23:59:59.9995Z", workflow: "wf-a", feature: FEAT_SRC });
    const r8 = await run("r8", { campaign: C2, at: "2026-09-08T13:00:00Z", workflow: "wf-b", org: OTHER_ORG_ID });
    const r9 = await run("r9", { campaign: C1, at: "2026-09-08T15:00:00Z", workflow: "wf-a", brands: [BRAND, BRAND_OTHER] });

    await cost("k1", r1, "email-send", "actual", "12.3456789012", { netCostInUsdCents: "6.1728394506", usageDiscountPct: "0.5" });
    await cost("k2", r1, "email-send", "provisioned", "0.0000000001");
    await cost("k3", r2, "email-send", "actual", "100", { quantity: "3.123456" });
    await cost("k4", r2, "apollo-credit", "cancelled", "7.5"); // r2 sits under two names
    await cost("k5", r4, "apollo-credit", "provisioned", "3.3333333333");
    await cost("k6", r4, "email-send", "actual", "0"); // a matched row summing to zero
    await cost("k7", r5, "llm-tokens", "actual", "0.25", { costSource: "org" });
    await cost("k8", r6, "llm-tokens", "actual", "2000", { quantity: "1000000" });
    await cost("k9", r7, "email-send", "refunded", "1.5");
    await cost("k10", r8, "email-send", "actual", "4");
    await cost("k11", r9, "apollo-credit", "actual", "5.5");
  });

  it("matches the live query after inserts (a run counts once per distinct cost name)", async () => {
    await allComparisons();
    const groups = (await getRaw({ groupBy: "costName", brandId: BRAND, featureSlugs: features })).body.groups as any[];
    const email = groups.find((g) => g.dimensions.costName === "email-send");
    expect(email.runCount).toBe(4); // r1 (two rows), r2, r4, r7
    expect(email.totalQuantity).toBe("9.123456");
    const apollo = groups.find((g) => g.dimensions.costName === "apollo-credit");
    expect(apollo.runCount).toBe(3); // r2, r4, r9
  });

  it("is actually served by the rollup (planted row counted, finer filters stay live)", async () => {
    const PLANTED = `planted-${SUFFIX}`;
    await sql`INSERT INTO stats_rollup_cost_name_day (campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, cost_name, run_count, min_started_at, max_started_at, n_actual, gross_actual, net_actual, quantity)
              VALUES (${C1}, '2026-09-15', ${ORG_ID}, ${[BRAND]}, ${FEAT}, 'wf-a', ${PLANTED}, 5, '2026-09-15T01:00:00Z', '2026-09-15T02:00:00Z', 1, 9, 9, 2)`;
    try {
      const planted = (g: any) => g.dimensions.costName === PLANTED;
      const served = (await getRaw({ groupBy: "costName", brandId: BRAND, featureSlugs: features })).body.groups;
      expect(served.find(planted)?.runCount).toBe(5);
      expect(served.find(planted)?.totalQuantity).toBe("2.000000");
      for (const q of [
        { groupBy: "costName", brandId: BRAND, taskName: "t" },
        { groupBy: "costName,serviceName", brandId: BRAND },
        { groupBy: "costName", brandId: BRAND, goal: "g" },
        { groupBy: "audienceId,costName", brandId: BRAND },
        { groupBy: "costName", brandId: BRAND, attributionStatus: "tagged" },
      ]) {
        const groups = (await getRaw(q)).body.groups;
        expect(groups.some(planted)).toBe(false);
      }
    } finally {
      await sql`DELETE FROM stats_rollup_cost_name_day WHERE cost_name = ${PLANTED}`;
    }
  });

  it("matches the live query through status transitions, without marking anything stale", async () => {
    await db.update(runsCosts).set({ status: "actual" }).where(eq(runsCosts.id, ids.k5));
    await db.update(runsCosts).set({ status: "refunded" }).where(eq(runsCosts.id, ids.k3));
    await db.update(runsCosts).set({ status: "cancelled" }).where(eq(runsCosts.id, ids.k2));
    await db.update(runsCosts).set({ quantity: "9.5" }).where(eq(runsCosts.id, ids.k6));
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM stats_rollup_cost_name_day WHERE organization_id = ${ORG_ID} AND minmax_stale`;
    expect(n).toBe(0);
    await allComparisons();
  });

  it("matches the live query after cost-name moves, run moves and cost deletes", async () => {
    await db.update(runsCosts).set({ costName: "llm-tokens" }).where(eq(runsCosts.id, ids.k4)); // r2: email+apollo -> email+llm
    await db.update(runsCosts).set({ costName: "email-send" }).where(eq(runsCosts.id, ids.k5)); // r4: both rows email-send
    await db.update(runsCosts).set({ runId: ids.r3 }).where(eq(runsCosts.id, ids.k9)); // r7 loses its only row, r3 gains one
    await db.delete(runsCosts).where(eq(runsCosts.id, ids.k11)); // r9 back to no cost row
    await allComparisons();
  });

  it("matches the live query after run deletes and key moves (stale min/max read live, then repaired)", async () => {
    await db.delete(runs).where(eq(runs.id, ids.r1));
    await db.update(runs).set({ brandIds: [BRAND_OTHER] }).where(eq(runs.id, ids.r4)); // transfer-brand shape
    await db.update(runs).set({ campaignId: C2 }).where(eq(runs.id, ids.r2));
    await db.update(runs).set({ startedAt: new Date("2026-09-30T23:30:00Z") }).where(eq(runs.id, ids.r5));
    await db.update(runs).set({ workflowSlug: "wf-b" }).where(eq(runs.id, ids.r6));
    const stale = async () => (await sql`SELECT count(*)::int AS n FROM stats_rollup_cost_name_day
                                          WHERE organization_id = ${ORG_ID} AND minmax_stale AND run_count <> 0`)[0].n;
    await allComparisons();
    const results = await repairStaleMinMax(sql, 1000);
    const costName = results.find((r) => r.table === "stats_rollup_cost_name_day")!;
    expect(costName.mismatched).toBe(0);
    expect(await stale()).toBe(0);
    await allComparisons();
  });

  it("concurrent first cost rows on one run keep its membership exact", async () => {
    // Without the lock-then-read order, two writers of one run and one name each
    // see no other row and both add the run.
    const RUNS = 12;
    const created = await Promise.all([...Array(RUNS).keys()].map((i) => insertTestRun({
      organizationId: ORG_ID, serviceName: "svc", taskName: "t", featureSlug: FEAT, workflowSlug: "wf-c",
      campaignId: C1, brandIds: [BRAND], startedAt: new Date(Date.UTC(2026, 8, 9, i)),
    })));
    await Promise.all(created.flatMap((r) => ["a", "b", "a", "c", "b", "a"].map((name) =>
      insertTestRunCost({ runId: r.id, costName: `cc-${name}`, quantity: "1", unitCostInUsdCents: "1", totalCostInUsdCents: "1", status: "actual" }),
    )));
    await allComparisons();
    const counts = await sql`SELECT cost_name, sum(run_count)::int AS n FROM stats_rollup_cost_name_day
                             WHERE workflow_slug = 'wf-c' AND organization_id = ${ORG_ID} GROUP BY 1 ORDER BY 1`;
    expect(counts.map((c) => [c.cost_name, c.n])).toEqual([["cc-a", RUNS], ["cc-b", RUNS], ["cc-c", RUNS]]);
  });

  it("a rebuild reproduces the trigger-maintained rollup, with exact min/max", async () => {
    const snapshot = async () =>
      sql`SELECT campaign_id, day::text, organization_id::text, brand_ids, feature_slug, workflow_slug, cost_name, run_count::text,
                 n_actual::text, n_provisioned::text, n_cancelled::text, n_refunded::text,
                 gross_actual::numeric(30,10)::text, gross_provisioned::numeric(30,10)::text,
                 gross_cancelled::numeric(30,10)::text, gross_refunded::numeric(30,10)::text,
                 net_actual::numeric(30,10)::text, net_provisioned::numeric(30,10)::text, net_refunded::numeric(30,10)::text,
                 quantity::numeric(30,6)::text
          FROM stats_rollup_cost_name_day
          WHERE organization_id IN (${ORG_ID}, ${OTHER_ORG_ID})
            AND (run_count <> 0 OR n_actual + n_provisioned + n_cancelled + n_refunded <> 0)
          ORDER BY 1, 2, 3, 4, 5, 6, 7`;
    const before = await snapshot();
    expect(before.length).toBeGreaterThan(0);
    await rebuildCostNameDayRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    expect(await snapshot()).toEqual(before);
    const [{ stale }] = await sql`SELECT count(*)::int AS stale FROM stats_rollup_cost_name_day WHERE organization_id = ${ORG_ID} AND minmax_stale`;
    expect(stale).toBe(0);
    await allComparisons();
  });

  it("a rebuild racing live writes and removals still counts every run once", async () => {
    const writes = (async () => {
      for (let i = 0; i < 20; i++) {
        const r = await insertTestRun({
          organizationId: ORG_ID, serviceName: "svc", taskName: "t", featureSlug: FEAT, workflowSlug: `wf-race-${i % 3}`,
          campaignId: i % 4 === 0 ? undefined : [C1, C2][i % 2], brandIds: [BRAND], startedAt: new Date(Date.UTC(2026, 8, 8 + (i % 4), i)),
        });
        await insertTestRunCost({ runId: r.id, costName: ["email-send", "apollo-credit"][i % 2], quantity: "1", unitCostInUsdCents: "1.1", totalCostInUsdCents: "1.1", status: i % 2 ? "actual" : "provisioned" });
        if (i % 3 === 1) await insertTestRunCost({ runId: r.id, costName: "email-send", quantity: "2", unitCostInUsdCents: "0.5", totalCostInUsdCents: "0.5", status: "actual" });
        if (i % 5 === 0) await db.delete(runs).where(eq(runs.id, r.id));
      }
    })();
    const rebuilds = (async () => {
      for (let i = 0; i < 3; i++) await rebuildCostNameDayRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    })();
    await Promise.all([writes, rebuilds]);
    await allComparisons();
  });
});
