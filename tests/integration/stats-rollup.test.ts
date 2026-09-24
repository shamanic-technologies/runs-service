import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq, sql as dsql } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";
import {
  STATS_ROLLUP_NAME,
  readPublicCostsFromRollup,
  rebuildStatsRollup,
} from "../../src/services/stats-rollup.js";

// The write-maintained (feature, workflow, payer) rollup (migration 0034) must
// answer GET /v1/stats/public/costs BYTE-IDENTICALLY to the live query it
// replaces — through every write the ledger sees: inserts, status transitions
// (provisioned → actual → refunded, cancelled), a cost delete, a run delete
// (cascade), and a run moved to another workflow.
//
// Every comparison runs the SAME request twice: once with the rollup ready, once
// with the readiness stamp removed (which sends the route down the live query),
// and asserts the two JSON bodies are equal. A second comparison checks the raw
// TEXT rows (the response is ordered by that text) against the live SQL.

const ORG_ID = "7a110000-1111-4aaa-8aaa-111111111111";
const OTHER_ORG_ID = "7a110000-2222-4aaa-8aaa-222222222222";
const CLEANUP = [ORG_ID, OTHER_ORG_ID];
const SUFFIX = randomUUID().slice(0, 8);
const FEAT_A = `rollup-a-${SUFFIX}`;
const FEAT_B = `rollup-b-${SUFFIX}`;

const app = createTestApp();

async function readyStamp(ready: boolean) {
  if (ready) {
    await sql`INSERT INTO stats_rollups (name, ready_at) VALUES (${STATS_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  } else {
    await sql`DELETE FROM stats_rollups WHERE name = ${STATS_ROLLUP_NAME}`;
  }
}

async function publicCosts(query: Record<string, string>) {
  const res = await request(app).get("/v1/stats/public/costs").set(getAuthHeaders({ orgId: ORG_ID })).query(query);
  expect(res.status).toBe(200);
  return res.body.groups as any[];
}

/** Same request through the rollup and through the live query — must be equal. */
async function expectRollupEqualsLive(query: Record<string, string>) {
  await readyStamp(true);
  const fromRollup = await publicCosts(query);
  await readyStamp(false);
  const fromLive = await publicCosts(query);
  await readyStamp(true);
  expect(fromLive.length).toBeGreaterThan(0);
  // Ties on total_cost have no defined order in either path; compare the order of
  // the sort key, and the groups as a set.
  expect(fromRollup.map((g) => g.totalCostInUsdCents)).toEqual(fromLive.map((g) => g.totalCostInUsdCents));
  const key = (g: any) => JSON.stringify(g.dimensions);
  const sortByKey = (a: any[]) => [...a].sort((x, y) => key(x).localeCompare(key(y)));
  expect(sortByKey(fromRollup)).toEqual(sortByKey(fromLive));
  return fromRollup;
}

/** The live public SQL for groupBy=workflowSlug, verbatim shape, raw TEXT rows. */
async function liveRawRows(featureSlugs: string[], costSource?: string) {
  const feats = dsql.join(featureSlugs.map((f) => dsql`${f}`), dsql`, `);
  const payer = costSource ? dsql`AND rc.cost_source = ${costSource}` : dsql``;
  const rows = await db.execute(dsql`
    WITH counts AS (
      SELECT dim, COUNT(*)::int AS run_count
      FROM (SELECT DISTINCT r.id, r.workflow_slug AS dim FROM runs r WHERE r.feature_slug IN (${feats})) pairs
      GROUP BY dim
    ),
    sums AS (
      SELECT r.workflow_slug AS dim,
        COALESCE(SUM(CASE WHEN rc.status IN ('actual','provisioned') THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS total_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'actual'      THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS actual_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'provisioned' THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS provisioned_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'cancelled'   THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS cancelled_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'refunded'    THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS refunded_cost,
        COALESCE(SUM(CASE WHEN rc.status IN ('actual','provisioned') THEN COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) ELSE 0 END), 0)::text AS net_total_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'actual'      THEN COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) ELSE 0 END), 0)::text AS net_actual_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'provisioned' THEN COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) ELSE 0 END), 0)::text AS net_provisioned_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'refunded'    THEN COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) ELSE 0 END), 0)::text AS net_refunded_cost
      FROM runs r INNER JOIN runs_costs rc ON rc.run_id = r.id ${payer}
      WHERE r.feature_slug IN (${feats})
      GROUP BY 1
    )
    SELECT c.dim AS workflow_slug,
      COALESCE(s.total_cost, '0') AS total_cost, COALESCE(s.actual_cost, '0') AS actual_cost,
      COALESCE(s.provisioned_cost, '0') AS provisioned_cost, COALESCE(s.cancelled_cost, '0') AS cancelled_cost,
      COALESCE(s.refunded_cost, '0') AS refunded_cost, COALESCE(s.net_total_cost, '0') AS net_total_cost,
      COALESCE(s.net_actual_cost, '0') AS net_actual_cost, COALESCE(s.net_provisioned_cost, '0') AS net_provisioned_cost,
      COALESCE(s.net_refunded_cost, '0') AS net_refunded_cost, c.run_count
    FROM counts c LEFT JOIN sums s ON s.dim IS NOT DISTINCT FROM c.dim
  `);
  return rows as unknown as any[];
}

async function expectRawTextEqual(featureSlugs: string[], costSource?: string) {
  const sortRows = (rows: any[]) =>
    rows.map((r) => ({ ...r })).sort((a, b) => String(a.workflow_slug).localeCompare(String(b.workflow_slug)));
  const live = sortRows(await liveRawRows(featureSlugs, costSource));
  const rolled = sortRows(
    await readPublicCostsFromRollup({ groupBy: "workflowSlug", resultCol: "workflow_slug", featureSlugs, costSource }),
  );
  expect(rolled).toEqual(live);
}

async function allComparisons() {
  for (const q of [
    { featureSlugs: FEAT_A, groupBy: "workflowSlug" },
    { featureSlug: FEAT_A, groupBy: "workflowSlug" },
    { featureSlugs: `${FEAT_A},${FEAT_B}`, groupBy: "workflowSlug" },
    { featureSlugs: `${FEAT_A},${FEAT_B}`, groupBy: "featureSlug" },
    { featureSlugs: FEAT_A, groupBy: "workflowSlug", costSource: "platform" },
    { featureSlugs: FEAT_A, groupBy: "workflowSlug", costSource: "org" },
  ]) {
    await expectRollupEqualsLive(q);
  }
  await expectRawTextEqual([FEAT_A]);
  await expectRawTextEqual([FEAT_A, FEAT_B]);
  await expectRawTextEqual([FEAT_A], "platform");
  await expectRawTextEqual([FEAT_A], "org");
}

const ids: Record<string, string> = {};

afterAll(async () => {
  await cleanTestData(CLEANUP);
  await readyStamp(true);
  await closeDb();
});

describe("stats rollup — cross-org per-workflow read", () => {
  beforeAll(async () => {
    await cleanTestData(CLEANUP);
    await readyStamp(true);

    const run = async (key: string, org: string, feature: string, workflow?: string) => {
      const r = await insertTestRun({ organizationId: org, serviceName: "svc", taskName: "t", featureSlug: feature, workflowSlug: workflow });
      ids[key] = r.id;
      return r.id;
    };
    const cost = async (key: string, runId: string, status: string, total: string, extra: Record<string, string> = {}) => {
      const c = await insertTestRunCost({
        runId, costName: "c", quantity: "1", unitCostInUsdCents: total, totalCostInUsdCents: total, status, ...extra,
      });
      ids[key] = c.id;
    };

    const a1 = await run("a1", ORG_ID, FEAT_A, "wf-one");
    const a2 = await run("a2", OTHER_ORG_ID, FEAT_A, "wf-one");
    await run("a3", ORG_ID, FEAT_A, "wf-one"); // no cost at all
    const a4 = await run("a4", ORG_ID, FEAT_A, "wf-two");
    const a5 = await run("a5", OTHER_ORG_ID, FEAT_A); // NULL workflow — its own group
    const a6 = await run("a6", ORG_ID, FEAT_A, "wf-cancelled-only");
    const a7 = await run("a7", ORG_ID, FEAT_A, "wf-org-only");
    const b1 = await run("b1", ORG_ID, FEAT_B, "wf-one");

    await cost("c1", a1, "actual", "12.3456789012", { netCostInUsdCents: "6.1728394506", usageDiscountPct: "0.5" });
    await cost("c2", a1, "provisioned", "0.0000000001");
    await cost("c3", a2, "actual", "100");
    await cost("c4", a2, "cancelled", "7.5");
    await cost("c5", a4, "provisioned", "3.3333333333");
    await cost("c6", a5, "actual", "0.25", { costSource: "org" });
    await cost("c7", a6, "cancelled", "9.99");
    await cost("c8", a7, "actual", "4", { costSource: "org" });
    await cost("c9", b1, "actual", "55.5");
    await cost("c10", a4, "actual", "0"); // a matched row summing to zero
  });

  it("matches the live query after inserts", async () => {
    await allComparisons();
    const groups = await publicCosts({ featureSlugs: FEAT_A, groupBy: "workflowSlug" });
    const one = groups.find((g) => g.dimensions.workflowSlug === "wf-one");
    expect(one.runCount).toBe(3); // a1, a2, a3 — cross-org, the cost-less run included
    expect(one.totalCostInUsdCents).toBe("112.3456789013");
    expect(one.netTotalCostInUsdCents).toBe("106.1728394507");
    expect(one.cancelledCostInUsdCents).toBe("7.5000000000");
  });

  it("matches the live query through status transitions", async () => {
    await db.update(runsCosts).set({ status: "actual" }).where(eq(runsCosts.id, ids.c5));
    await db.update(runsCosts).set({ status: "refunded" }).where(eq(runsCosts.id, ids.c3));
    await db.update(runsCosts).set({ status: "cancelled" }).where(eq(runsCosts.id, ids.c2));
    await allComparisons();
  });

  it("matches the live query after a cost delete, a run delete and a workflow move", async () => {
    await db.delete(runsCosts).where(eq(runsCosts.id, ids.c9));
    await db.delete(runs).where(eq(runs.id, ids.a4)); // cascades its two cost rows
    await db.update(runs).set({ workflowSlug: "wf-moved" }).where(eq(runs.id, ids.a1));
    await db.update(runs).set({ featureSlug: FEAT_B }).where(eq(runs.id, ids.a2));
    await allComparisons();
  });

  it("a rebuild from the ledger reproduces the trigger-maintained state exactly", async () => {
    const snapshot = async () => ({
      runs: await sql`SELECT feature_slug, workflow_slug, run_count::text FROM stats_rollup_runs
                      WHERE feature_slug IN (${FEAT_A}, ${FEAT_B}) AND run_count <> 0 ORDER BY 1, 2`,
      costs: await sql`SELECT feature_slug, workflow_slug, cost_source,
                        n_actual::text, n_provisioned::text, n_cancelled::text, n_refunded::text,
                        gross_actual::numeric(30,10)::text, gross_provisioned::numeric(30,10)::text,
                        gross_cancelled::numeric(30,10)::text, gross_refunded::numeric(30,10)::text,
                        net_actual::numeric(30,10)::text, net_provisioned::numeric(30,10)::text, net_refunded::numeric(30,10)::text
                      FROM stats_rollup_costs
                      WHERE feature_slug IN (${FEAT_A}, ${FEAT_B})
                        AND n_actual + n_provisioned + n_cancelled + n_refunded <> 0
                      ORDER BY 1, 2, 3`,
    });
    const before = await snapshot();
    const result = await rebuildStatsRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    expect(result.runGroups).toBeGreaterThan(0);
    const after = await snapshot();
    expect(after).toEqual(before);
    await allComparisons();
  });

  it("a rebuild racing live writes still counts every row exactly once", async () => {
    const writes = (async () => {
      for (let i = 0; i < 25; i++) {
        const r = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", featureSlug: FEAT_A, workflowSlug: `wf-race-${i % 3}` });
        await insertTestRunCost({ runId: r.id, costName: "c", quantity: "1", unitCostInUsdCents: "1.1", totalCostInUsdCents: "1.1", status: i % 2 ? "actual" : "provisioned" });
        if (i % 5 === 0) await db.update(runsCosts).set({ status: "cancelled" }).where(eq(runsCosts.runId, r.id));
      }
    })();
    const rebuilds = (async () => {
      for (let i = 0; i < 3; i++) await rebuildStatsRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    })();
    await Promise.all([writes, rebuilds]);
    await allComparisons();
  });

  it("does not serve a request carrying a dimension the rollup lacks", async () => {
    // An org filter must reach the live query: the rollup has no org, so serving
    // it would silently return the whole fleet.
    const res = await request(app).get("/v1/stats/public/costs").set(getAuthHeaders({ orgId: ORG_ID }))
      .query({ featureSlugs: FEAT_A, groupBy: "workflowSlug", orgId: OTHER_ORG_ID });
    expect(res.status).toBe(200);
    const slugs = res.body.groups.map((g: any) => g.dimensions.workflowSlug).sort();
    expect(slugs).toEqual([null]); // a5 only — a2 moved to FEAT_B
  });
});

describe("GET /v1/stats/costs — split (counts | sums) read for run-side groupings", () => {
  const FEAT = `split-${SUFFIX}`;
  const BRAND = randomUUID();
  const CAMP = randomUUID();
  const headers = getAuthHeaders({ orgId: ORG_ID });

  beforeAll(async () => {
    const mk = (workflow: string | undefined, campaign: string | undefined, brands: string[]) =>
      insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "t", featureSlug: FEAT, workflowSlug: workflow, campaignId: campaign, brandIds: brands });
    const r1 = await mk("wf-x", CAMP, [BRAND]);
    const r2 = await mk("wf-x", CAMP, [BRAND, BRAND]); // a repeated brand in the array
    await mk("wf-x", undefined, [BRAND]);             // no cost, no campaign
    const r4 = await mk("wf-y", CAMP, [BRAND]);
    await insertTestRunCost({ runId: r1.id, costName: "c", quantity: "1", unitCostInUsdCents: "2", totalCostInUsdCents: "2" });
    await insertTestRunCost({ runId: r1.id, costName: "c", quantity: "1", unitCostInUsdCents: "3", totalCostInUsdCents: "3", status: "provisioned" });
    await insertTestRunCost({ runId: r2.id, costName: "c", quantity: "1", unitCostInUsdCents: "5", totalCostInUsdCents: "5", status: "cancelled" });
    await insertTestRunCost({ runId: r4.id, costName: "c", quantity: "1", unitCostInUsdCents: "7", totalCostInUsdCents: "7", netCostInUsdCents: "3.5", usageDiscountPct: "0.5" });
  });

  /** The single joined query every run-side grouping used before the split. */
  async function joinedRows(groupByCols: string, selectCols: string, brandFilter: boolean) {
    const brand = brandFilter ? dsql`AND ${BRAND} = ANY(r.brand_ids)` : dsql``;
    const rows = await db.execute(dsql`
      SELECT ${dsql.raw(selectCols)},
        COALESCE(SUM(CASE WHEN rc.status IN ('actual','provisioned') THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS total_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'cancelled' THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS cancelled_cost,
        COALESCE(SUM(CASE WHEN rc.status IN ('actual','provisioned') THEN COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) ELSE 0 END), 0)::text AS net_total_cost,
        COUNT(DISTINCT r.id) AS run_count, MIN(r.started_at) AS mn, MAX(r.started_at) AS mx
      FROM runs r LEFT JOIN runs_costs rc ON rc.run_id = r.id
      WHERE r.organization_id = ${ORG_ID} AND r.feature_slug = ${FEAT} ${brand}
      GROUP BY ${dsql.raw(groupByCols)}
    `);
    return rows as unknown as any[];
  }

  for (const [groupBy, groupByCols, selectCols, dimOf] of [
    ["workflowSlug,campaignId", "r.workflow_slug, r.campaign_id", "r.workflow_slug, r.campaign_id", (r: any) => ({ workflowSlug: r.workflow_slug, campaignId: r.campaign_id })],
    ["workflowSlug", "r.workflow_slug", "r.workflow_slug", (r: any) => ({ workflowSlug: r.workflow_slug })],
    ["brandId,workflowSlug", "unnest(r.brand_ids), r.workflow_slug", "unnest(r.brand_ids), r.workflow_slug", (r: any) => ({ brandId: r.unnest, workflowSlug: r.workflow_slug })],
  ] as const) {
    it(`groupBy=${groupBy} equals the joined query`, async () => {
      const res = await request(app).get("/v1/stats/costs").set(headers)
        .query({ groupBy, featureSlug: FEAT, brandId: BRAND });
      expect(res.status).toBe(200);
      const expected = (await joinedRows(groupByCols, selectCols, true)).map((r) => ({
        dimensions: dimOf(r),
        totalCostInUsdCents: Number(r.total_cost).toFixed(10),
        cancelledCostInUsdCents: Number(r.cancelled_cost).toFixed(10),
        netTotalCostInUsdCents: Number(r.net_total_cost).toFixed(10),
        runCount: Number(r.run_count),
        minStartedAt: new Date(r.mn).toISOString(),
        maxStartedAt: new Date(r.mx).toISOString(),
      }));
      const got = res.body.groups.map((g: any) => ({
        dimensions: g.dimensions,
        totalCostInUsdCents: g.totalCostInUsdCents,
        cancelledCostInUsdCents: g.cancelledCostInUsdCents,
        netTotalCostInUsdCents: g.netTotalCostInUsdCents,
        runCount: g.runCount,
        minStartedAt: g.minStartedAt,
        maxStartedAt: g.maxStartedAt,
      }));
      const k = (g: any) => JSON.stringify(g.dimensions);
      expect([...got].sort((a, b) => k(a).localeCompare(k(b)))).toEqual([...expected].sort((a, b) => k(a).localeCompare(k(b))));
    });
  }

  it("counts a run with a repeated brand once per group", async () => {
    const res = await request(app).get("/v1/stats/costs").set(headers).query({ groupBy: "brandId", featureSlug: FEAT });
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].runCount).toBe(4);
  });
});
