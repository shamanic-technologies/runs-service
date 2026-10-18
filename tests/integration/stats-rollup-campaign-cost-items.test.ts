import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { eq } from "drizzle-orm";
import { db, sql as rawSql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import {
  CAMPAIGN_COST_ITEMS_ROLLUP_NAME,
  rebuildCampaignCostItemsRollup,
} from "../../src/services/stats-rollup-campaign-cost-items.js";

// Migration 0050: the (campaign, run-start day, org, brands, feature, workflow,
// cost source, status, cost name, billed unit price) rollup must hold what the
// ledger holds through every write the triggers see, and
// GET /internal/stats/costs/vendor read from it must answer byte for byte what
// the live join answers — including a group straddling a served-from instant
// and run-start bounds that cut a UTC day.

const ORG_A = "0e50aaaa-1111-4aaa-8aaa-111111111111";
const ORG_B = "0e50aaaa-2222-4aaa-8aaa-222222222222";
const BRAND_A = "0e50bbbb-1111-4bbb-8bbb-111111111111";
const BRAND_B = "0e50bbbb-2222-4bbb-8bbb-222222222222";
const CAMP_1 = "0e50cccc-1111-4ccc-8ccc-111111111111";
const CAMP_2 = "0e50cccc-2222-4ccc-8ccc-222222222222";
const FEATURE = "cost-items-rollup-test-feature";
const FEATURE_2 = "cost-items-rollup-test-feature-2";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});
const dynasties = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/dynasty-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/dynasty-resolver.js")>();
  return { ...actual, fetchAllWorkflowDynasties: dynasties.fn };
});

// tok at billed 6 changes vendor cost mid-day on 09-15: a group of rows written
// both sides of 12:00 straddles it and must be priced row by row.
const VERSIONS = [
  { costName: "ci-tok", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "6", vendorUnitCostInUsdCents: "1" },
  { costName: "ci-tok", servedFrom: "2026-09-15T12:00:00Z", billedUnitCostInUsdCents: "6", vendorUnitCostInUsdCents: "2" },
  { costName: "ci-tok", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "3" },
  { costName: "ci-unknown", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "2", vendorUnitCostInUsdCents: null },
];

const API_KEY = { "x-api-key": "test-api-key" };
const PATH = "/internal/stats/costs/vendor";
const app = createTestApp();

async function run(org: string, brands: string[], workflowSlug: string, campaignId: string | undefined, startedAt: string, featureSlug = FEATURE) {
  const r = await insertTestRun({
    organizationId: org,
    serviceName: "svc",
    taskName: "task",
    brandIds: brands,
    featureSlug,
    workflowSlug,
    campaignId,
    status: "completed",
    startedAt: new Date(startedAt),
  });
  return r.id;
}

async function cost(runId: string, costName: string, qty: string, unit: string, createdAt: string, status = "actual", costSource = "platform") {
  const row = await insertTestRunCost({
    runId,
    costName,
    costSource,
    quantity: qty,
    unitCostInUsdCents: unit,
    totalCostInUsdCents: new Decimal(qty).times(unit).toFixed(10),
    status,
    createdAt: new Date(createdAt),
  });
  return row.id as string;
}

const FEATURES = [FEATURE, FEATURE_2];

/** The rollup's grain computed LIVE from the ledger (same SELECT as the rebuild). */
async function ledgerGrain() {
  return rawSql`
    SELECT r.campaign_id, (r.started_at AT TIME ZONE 'UTC')::date::text AS day, r.organization_id::text AS org,
      r.brand_ids, r.workflow_slug, rc.cost_source, rc.status, rc.cost_name, rc.unit_cost_in_usd_cents::text AS unit,
      count(*)::text AS n, SUM(rc.quantity)::numeric AS q, SUM(rc.total_cost_in_usd_cents)::numeric AS g,
      MIN(rc.created_at) AS min_at, MAX(rc.created_at) AS max_at
    FROM runs_costs rc JOIN runs r ON r.id = rc.run_id
    WHERE r.feature_slug = ANY(${FEATURES}) AND rc.status IN ('actual','provisioned','refunded')
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
  `;
}

async function rollupGrain() {
  return rawSql`
    SELECT campaign_id, day::text AS day, organization_id::text AS org, brand_ids, workflow_slug, cost_source, status,
      cost_name, unit_cost_in_usd_cents::text AS unit, n::text AS n, quantity AS q, gross AS g,
      min_created_at AS min_at, max_created_at AS max_at
    FROM stats_rollup_campaign_cost_items
    WHERE feature_slug = ANY(${FEATURES}) AND n <> 0
  `;
}

const keyOf = (r: any) => [r.campaign_id, r.day, r.org, JSON.stringify(r.brand_ids), r.workflow_slug, r.cost_source, r.status, r.cost_name, r.unit].join("|");

async function expectRollupMatchesLedger() {
  const ledger = new Map((await ledgerGrain()).map((r: any) => [keyOf(r), r]));
  const rollup = new Map((await rollupGrain()).map((r: any) => [keyOf(r), r]));
  expect([...rollup.keys()].sort()).toEqual([...ledger.keys()].sort());
  for (const [k, l] of ledger) {
    const r: any = rollup.get(k);
    expect({ k, n: r.n, q: new Decimal(r.q).toFixed(10), g: new Decimal(r.g).toFixed(10) }).toEqual({
      k,
      n: l.n,
      q: new Decimal(l.q).toFixed(10),
      g: new Decimal(l.g).toFixed(10),
    });
    // Bounds never narrow: a superset of the ledger rows' created_at.
    expect(new Date(r.min_at).getTime()).toBeLessThanOrEqual(new Date(l.min_at).getTime());
    expect(new Date(r.max_at).getTime()).toBeGreaterThanOrEqual(new Date(l.max_at).getTime());
  }
}

async function setReady(ready: boolean) {
  if (ready) {
    await rawSql`INSERT INTO stats_rollups (name, ready_at) VALUES (${CAMPAIGN_COST_ITEMS_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  } else {
    await rawSql`DELETE FROM stats_rollups WHERE name = ${CAMPAIGN_COST_ITEMS_ROLLUP_NAME}`;
  }
}

async function vendor(query: Record<string, string>) {
  const res = await request(app).get(PATH).query(query).set(API_KEY);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.groups;
}

const QUERIES: Record<string, string>[] = [
  { groupBy: "workflowSlug", featureSlugs: FEATURES.join(",") },
  { groupBy: "workflowDynastySlug", featureSlugs: FEATURE },
  { groupBy: "campaignId", featureSlug: FEATURE },
  { groupBy: "brandId", featureSlugs: FEATURES.join(",") },
  { groupBy: "featureSlug", featureSlugs: FEATURES.join(",") },
  { groupBy: "costName", featureSlugs: FEATURES.join(",") },
  { groupBy: "campaignId,costName", featureSlugs: FEATURE },
  { groupBy: "workflowSlug", featureSlugs: FEATURE, campaignIds: `${CAMP_1},${CAMP_2}` },
  { groupBy: "workflowSlug", featureSlugs: FEATURE, campaignId: CAMP_1 },
  { groupBy: "workflowSlug", featureSlugs: FEATURE, orgId: ORG_A, brandId: BRAND_A },
  { groupBy: "workflowSlug", featureSlugs: FEATURE, costSource: "platform" },
  { groupBy: "workflowSlug", featureSlugs: FEATURE, costSource: "org" },
  { groupBy: "workflowSlug", featureSlugs: FEATURE, workflowSlugs: "alpha,beta" },
  { groupBy: "workflowSlug", featureSlugs: FEATURE, startedAfter: "2026-09-15T09:00:00Z" },
  { groupBy: "workflowSlug", featureSlugs: FEATURE, startedAfter: "2026-09-20T00:00:00Z" },
  { groupBy: "workflowSlug", featureSlugs: FEATURE, startedBefore: "2026-09-20T00:00:00Z" },
  { groupBy: "workflowSlug", featureSlugs: FEATURE, startedBefore: "2026-09-15T09:00:00Z" },
  { groupBy: "workflowSlug", featureSlugs: FEATURE, startedAfter: "2026-09-15T07:00:00Z", startedBefore: "2026-09-15T09:00:00Z" },
  { groupBy: "workflowSlug", featureSlugs: FEATURE, startedAfter: "2026-09-12T00:00:00Z", startedBefore: "2026-09-20T03:00:00Z" },
];

async function expectRollupReadEqualsLive() {
  await setReady(true);
  const fromRollup = [];
  for (const q of QUERIES) fromRollup.push(await vendor(q));
  await setReady(false);
  const live = [];
  for (const q of QUERIES) live.push(await vendor(q));
  await setReady(true);
  QUERIES.forEach((q, i) => expect({ q, groups: fromRollup[i] }).toEqual({ q, groups: live[i] }));
}

describe("campaign_cost_items rollup (migration 0050) and the grouped vendor read", () => {
  let provisionedId: string;
  let doomedId: string;
  let movedRun: string;

  beforeAll(async () => {
    await cleanTestData([ORG_A, ORG_B]);
    catalog.fn.mockResolvedValue(VERSIONS);
    dynasties.fn.mockResolvedValue([{ dynastySlug: "alpha", slugs: ["alpha", "alpha-v2"] }]);
    await setReady(true);

    const a1 = await run(ORG_A, [BRAND_A], "alpha", CAMP_1, "2026-09-10T10:00:00Z");
    await cost(a1, "ci-tok", "10", "6", "2026-09-10T10:00:01Z");
    await cost(a1, "ci-unknown", "1", "2", "2026-09-10T10:00:01Z");
    await cost(a1, "ci-tok", "4", "6", "2026-09-10T10:00:02Z", "cancelled");
    // Straddles the 09-15 12:00 instant: 3 x vendor 1 + 4 x vendor 2.
    const a2 = await run(ORG_A, [BRAND_A], "alpha-v2", CAMP_1, "2026-09-15T08:00:00Z");
    await cost(a2, "ci-tok", "3", "6", "2026-09-15T10:00:00Z");
    await cost(a2, "ci-tok", "4", "6", "2026-09-15T14:00:00Z");
    await cost(a2, "ci-tok", "2", "5", "2026-09-15T14:00:00Z", "refunded");
    provisionedId = await cost(a2, "ci-tok", "1", "6", "2026-09-15T15:00:00Z", "provisioned");
    // A run at a UTC midnight, and one later the same day.
    const b1 = await run(ORG_B, [BRAND_B], "beta", CAMP_2, "2026-09-20T00:00:00Z");
    await cost(b1, "ci-tok", "2", "6", "2026-09-20T00:00:05Z");
    doomedId = await cost(b1, "ci-tok", "9", "5", "2026-09-20T00:00:06Z");
    const b2 = await run(ORG_B, [BRAND_A, BRAND_B], "beta", CAMP_2, "2026-09-20T05:00:00Z");
    await cost(b2, "ci-tok", "5", "5", "2026-09-20T05:00:01Z");
    await cost(b2, "ci-tok", "1", "6", "2026-09-20T05:00:01Z", "actual", "org");
    // No campaign, and a second feature.
    const c1 = await run(ORG_A, [BRAND_A], "alpha", undefined, "2026-09-12T09:00:00Z");
    await cost(c1, "ci-tok", "7", "6", "2026-09-12T09:00:01Z");
    movedRun = await run(ORG_A, [BRAND_A], "gamma", CAMP_1, "2026-09-13T09:00:00Z", FEATURE_2);
    await cost(movedRun, "ci-tok", "6", "5", "2026-09-13T09:00:01Z");
  });

  afterAll(async () => {
    await cleanTestData([ORG_A, ORG_B]);
    await closeDb();
  });

  it("the triggers keep the rollup equal to the ledger, and the read equals the live join", async () => {
    await expectRollupMatchesLedger();
    await expectRollupReadEqualsLive();
  });

  it("prices a straddling group row by row", async () => {
    const groups = await vendor({ groupBy: "workflowSlug", featureSlugs: FEATURE });
    const v2 = groups.find((g: any) => g.dimensions.workflowSlug === "alpha-v2");
    // actual 3x1 + 4x2 = 11; provisioned 1x2 = 2; refunded 2x3 = 6.
    expect(v2).toMatchObject({
      vendorActualCostInUsdCents: "11.0000000000",
      vendorProvisionedCostInUsdCents: "2.0000000000",
      vendorTotalCostInUsdCents: "13.0000000000",
      vendorRefundedCostInUsdCents: "6.0000000000",
    });
  });

  it("serves from the rollup when it is ready (a tampered group shows through)", async () => {
    await rawSql`UPDATE stats_rollup_campaign_cost_items SET gross = gross + 1000 WHERE feature_slug = ${FEATURE_2}`;
    try {
      const groups = await vendor({ groupBy: "featureSlug", featureSlugs: FEATURE_2 });
      expect(groups[0].totalCostInUsdCents).toBe("1030.0000000000");
    } finally {
      await rawSql`UPDATE stats_rollup_campaign_cost_items SET gross = gross - 1000 WHERE feature_slug = ${FEATURE_2}`;
    }
  });

  it("follows status changes, deletes and run moves", async () => {
    await db.update(runsCosts).set({ status: "actual" }).where(eq(runsCosts.id, provisionedId));
    await db.delete(runsCosts).where(eq(runsCosts.id, doomedId));
    await db.update(runs).set({ brandIds: [BRAND_B], workflowSlug: "alpha", campaignId: CAMP_2 }).where(eq(runs.id, movedRun));
    await expectRollupMatchesLedger();
    await expectRollupReadEqualsLive();
  });

  it("a rebuild reproduces the triggered rollup", async () => {
    const before = (await rollupGrain()).map((r: any) => [keyOf(r), r.n, new Decimal(r.q).toFixed(10), new Decimal(r.g).toFixed(10)]).sort();
    await rebuildCampaignCostItemsRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    const after = (await rollupGrain()).map((r: any) => [keyOf(r), r.n, new Decimal(r.q).toFixed(10), new Decimal(r.g).toFixed(10)]).sort();
    expect(after).toEqual(before);
    await expectRollupMatchesLedger();
    await expectRollupReadEqualsLive();
  });
});
