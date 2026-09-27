import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";
import { db, sql } from "../../src/db/index.js";
import { runs, runsCosts, runEvents } from "../../src/db/schema.js";

// UUIDs that pass Zod v4 strict validation (version [1-8], variant [89abAB])
// File-local org ids keep this file isolated from other integration files running in parallel.
const SOURCE_ORG_ID = "11111111-1111-4111-a111-111111111111";
const TARGET_ORG_ID = "33333333-3333-4333-a333-333333333333";
const OTHER_ORG_ID = "44444444-4444-4444-a444-444444444444";
const ORG_IDS = [SOURCE_ORG_ID, TARGET_ORG_ID, OTHER_ORG_ID];
const BRAND_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const BRAND_B = "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb";
const TARGET_BRAND = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const CAMPAIGN_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const CAMPAIGN_B = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

const BODY = { sourceBrandId: BRAND_A, sourceOrgId: SOURCE_ORG_ID, targetOrgId: TARGET_ORG_ID };

function tables(body: { updatedTables: { tableName: string; count: number }[] }) {
  return Object.fromEntries(body.updatedTables.map((t) => [t.tableName, t.count]));
}

async function event(runId: string, orgId: string, brandIds: string | null, campaignId: string | null = null) {
  await db.insert(runEvents).values({ runId, service: "svc", event: "tick", orgId, brandIds, campaignId });
}

describe("POST /internal/transfer-brand", () => {
  const app = createTestApp();
  const headers = getInternalAuthHeaders();

  async function transfer(body: Record<string, string> = BODY) {
    const res = await request(app).post("/internal/transfer-brand").set(headers).send(body);
    expect(res.status).toBe(200);
    return tables(res.body);
  }

  async function usage(orgId: string) {
    const res = await request(app).get("/internal/org-usage-total").set(headers).query({ org_id: orgId });
    expect(res.status).toBe(200);
    return res.body as { spent_cents: string; net_spent_cents: string };
  }

  async function actual(orgId: string) {
    const res = await request(app).get("/internal/org-actual-total").set(headers).query({ org_id: orgId });
    expect(res.status).toBe(200);
    return res.body as { total_expected_cents: string; net_total_expected_cents: string };
  }

  async function movedUsage(targetOrgId = TARGET_ORG_ID) {
    const res = await request(app)
      .get("/internal/brand-transfers/moved-usage")
      .set(headers)
      .query({ sourceOrgId: SOURCE_ORG_ID, sourceBrandId: BRAND_A, targetOrgId });
    expect(res.status).toBe(200);
    return res.body;
  }

  async function orgOf(runId: string) {
    const [r] = await db.select().from(runs).where(eq(runs.id, runId));
    return r;
  }

  beforeEach(async () => {
    await cleanTestData(ORG_IDS);
    await sql`DELETE FROM brand_transfer_moves WHERE source_org_id IN ${sql(ORG_IDS)}`;
  });

  afterAll(async () => {
    await cleanTestData(ORG_IDS);
    await sql`DELETE FROM brand_transfer_moves WHERE source_org_id IN ${sql(ORG_IDS)}`;
    await closeDb();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).post("/internal/transfer-brand").set("Content-Type", "application/json").send(BODY);
    expect(res.status).toBe(401);
  });

  it("returns 400 with invalid body", async () => {
    const res = await request(app).post("/internal/transfer-brand").set(headers).send({ sourceBrandId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("moves solo, co-branded and untagged-campaign runs; leaves everything else", async () => {
    const solo = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "s", taskName: "solo", brandIds: [BRAND_A], campaignId: CAMPAIGN_A });
    const cobrand = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "s", taskName: "co", brandIds: [BRAND_B, BRAND_A] });
    const untaggedInCampaign = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "postmark", taskName: "send", campaignId: CAMPAIGN_A });
    const untaggedNoCampaign = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "api", taskName: "GET /x" });
    const otherBrand = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "s", taskName: "b", brandIds: [BRAND_B], campaignId: CAMPAIGN_B });
    const untaggedOtherCampaign = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "postmark", taskName: "send", campaignId: CAMPAIGN_B });
    const otherOrg = await insertTestRun({ organizationId: OTHER_ORG_ID, serviceName: "s", taskName: "o", brandIds: [BRAND_A] });

    expect(await transfer()).toMatchObject({ runs: 3 });

    for (const r of [solo, cobrand, untaggedInCampaign]) expect((await orgOf(r.id)).organizationId).toBe(TARGET_ORG_ID);
    for (const r of [untaggedNoCampaign, otherBrand, untaggedOtherCampaign]) expect((await orgOf(r.id)).organizationId).toBe(SOURCE_ORG_ID);
    expect((await orgOf(otherOrg.id)).organizationId).toBe(OTHER_ORG_ID);

    // AC: nothing of the brand (tag or campaign) remains under the source org.
    const [{ n }] = await sql`
      SELECT count(*)::int AS n FROM runs
       WHERE organization_id = ${SOURCE_ORG_ID}
         AND (${BRAND_A} = ANY(brand_ids) OR campaign_id = ${CAMPAIGN_A})`;
    expect(n).toBe(0);
  });

  it("moves the runs' cost rows (runs_costs.organization_id)", async () => {
    const r = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "s", taskName: "t", brandIds: [BRAND_A] });
    await insertTestRunCost({ runId: r.id, costName: "c", quantity: "1", unitCostInUsdCents: "2", totalCostInUsdCents: "2" });
    await insertTestRunCost({ runId: r.id, costName: "c", quantity: "1", unitCostInUsdCents: "3", totalCostInUsdCents: "3", status: "provisioned" });

    expect(await transfer()).toMatchObject({ runs: 1, runs_costs: 2 });

    const costs = await db.select().from(runsCosts).where(eq(runsCosts.runId, r.id));
    expect(costs.map((c) => c.organizationId)).toEqual([TARGET_ORG_ID, TARGET_ORG_ID]);
    const [{ n }] = await sql`
      SELECT count(*)::int AS n FROM runs_costs rc JOIN runs r ON r.id = rc.run_id
       WHERE rc.organization_id = ${SOURCE_ORG_ID} AND ${BRAND_A} = ANY(r.brand_ids)`;
    expect(n).toBe(0);
  });

  it("moves the runs' telemetry events (run_events.org_id), leaves other runs' events", async () => {
    const r = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "s", taskName: "t", brandIds: [BRAND_A] });
    const stay = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "s", taskName: "t", brandIds: [BRAND_B] });
    await event(r.id, SOURCE_ORG_ID, BRAND_A);
    await event(r.id, SOURCE_ORG_ID, BRAND_A);
    await event(stay.id, SOURCE_ORG_ID, BRAND_B);

    expect(await transfer()).toMatchObject({ runs: 1, run_events: 2 });

    const moved = await db.select().from(runEvents).where(eq(runEvents.runId, r.id));
    expect(moved.map((e) => e.orgId)).toEqual([TARGET_ORG_ID, TARGET_ORG_ID]);
    const [kept] = await db.select().from(runEvents).where(eq(runEvents.runId, stay.id));
    expect(kept.orgId).toBe(SOURCE_ORG_ID);
  });

  it("is idempotent — a re-run moves nothing and records nothing", async () => {
    const r = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "s", taskName: "t", brandIds: [BRAND_A], status: "completed" });
    await insertTestRunCost({ runId: r.id, costName: "c", quantity: "1", unitCostInUsdCents: "5", totalCostInUsdCents: "5" });
    await event(r.id, SOURCE_ORG_ID, BRAND_A);

    expect(await transfer()).toEqual({ runs: 1, runs_costs: 1, run_events: 1 });
    const before = await movedUsage();
    expect(await transfer()).toEqual({ runs: 0, runs_costs: 0, run_events: 0 });
    expect(await movedUsage()).toEqual(before);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM brand_transfer_moves WHERE source_org_id = ${SOURCE_ORG_ID}`;
    expect(n).toBe(1);
  });

  it("keeps both orgs' totals correct and records exactly the moved usage", async () => {
    // Source already has spend of another brand, target already has its own.
    const keep = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "s", taskName: "t", brandIds: [BRAND_B], status: "completed" });
    await insertTestRunCost({ runId: keep.id, costName: "c", quantity: "1", unitCostInUsdCents: "7", totalCostInUsdCents: "7" });
    const own = await insertTestRun({ organizationId: TARGET_ORG_ID, serviceName: "s", taskName: "t", brandIds: [TARGET_BRAND], status: "completed" });
    await insertTestRunCost({ runId: own.id, costName: "c", quantity: "1", unitCostInUsdCents: "11", totalCostInUsdCents: "11" });

    const done = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "s", taskName: "t", brandIds: [BRAND_A], status: "completed" });
    await insertTestRunCost({ runId: done.id, costName: "c", quantity: "1", unitCostInUsdCents: "10", totalCostInUsdCents: "10", netCostInUsdCents: "8", usageDiscountPct: "0.2" });
    await insertTestRunCost({ runId: done.id, costName: "c", quantity: "1", unitCostInUsdCents: "1", totalCostInUsdCents: "1", status: "cancelled" });
    await insertTestRunCost({ runId: done.id, costName: "c", quantity: "1", unitCostInUsdCents: "4", totalCostInUsdCents: "4", costSource: "org" });
    const running = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "s", taskName: "t", brandIds: [BRAND_A] });
    await insertTestRunCost({ runId: running.id, costName: "c", quantity: "1", unitCostInUsdCents: "3", totalCostInUsdCents: "3" });
    await insertTestRunCost({ runId: running.id, costName: "c", quantity: "1", unitCostInUsdCents: "2", totalCostInUsdCents: "2", status: "provisioned" });

    expect(await usage(SOURCE_ORG_ID)).toMatchObject({ spent_cents: "22.0000000000", net_spent_cents: "20.0000000000" });
    expect(await actual(SOURCE_ORG_ID)).toMatchObject({ total_expected_cents: "17.0000000000", net_total_expected_cents: "15.0000000000" });

    await transfer();

    expect(await usage(SOURCE_ORG_ID)).toMatchObject({ spent_cents: "7.0000000000", net_spent_cents: "7.0000000000" });
    expect(await usage(TARGET_ORG_ID)).toMatchObject({ spent_cents: "26.0000000000", net_spent_cents: "24.0000000000" });
    expect(await actual(SOURCE_ORG_ID)).toMatchObject({ total_expected_cents: "7.0000000000", net_total_expected_cents: "7.0000000000" });
    expect(await actual(TARGET_ORG_ID)).toMatchObject({ total_expected_cents: "21.0000000000", net_total_expected_cents: "19.0000000000" });

    // Moved usage == source's drop == target's rise, on both bases billing reads.
    expect(await movedUsage()).toMatchObject({
      runsMoved: 2,
      costsMoved: 5,
      projectedGrossCents: "15.0000000000",
      projectedNetCents: "13.0000000000",
      actualGrossCents: "10.0000000000",
      actualNetCents: "8.0000000000",
    });

    // Later spend in either org never changes the recorded figure.
    await insertTestRunCost({ runId: done.id, costName: "c", quantity: "1", unitCostInUsdCents: "9", totalCostInUsdCents: "9" });
    expect((await movedUsage()).projectedGrossCents).toBe("15.0000000000");
  });

  it("answers '0' moved usage before any move", async () => {
    expect(await movedUsage()).toMatchObject({
      runsMoved: 0,
      projectedGrossCents: "0",
      projectedNetCents: "0",
      actualGrossCents: "0",
      actualNetCents: "0",
      firstMovedAt: null,
    });
  });

  it("concurrent calls move each run once and record it once", async () => {
    const created = [];
    for (let i = 0; i < 20; i++) {
      const r = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "s", taskName: "t", brandIds: [BRAND_A], status: "completed" });
      await insertTestRunCost({ runId: r.id, costName: "c", quantity: "1", unitCostInUsdCents: "1", totalCostInUsdCents: "1" });
      created.push(r.id);
    }

    const results = await Promise.all([transfer(), transfer(), transfer()]);
    expect(results.reduce((s, t) => s + t.runs, 0)).toBe(20);
    expect(await movedUsage()).toMatchObject({ runsMoved: 20, projectedGrossCents: "20.0000000000", actualGrossCents: "20.0000000000" });
    const moved = await db.select().from(runs).where(inArray(runs.id, created));
    expect(moved.every((r) => r.organizationId === TARGET_ORG_ID)).toBe(true);
  });

  it("rewrites the brand id with targetBrandId — solo, co-branded, events, and other orgs", async () => {
    const solo = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "s", taskName: "t", brandIds: [BRAND_A] });
    const cobrand = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "s", taskName: "t", brandIds: [BRAND_B, BRAND_A] });
    const elsewhere = await insertTestRun({ organizationId: OTHER_ORG_ID, serviceName: "s", taskName: "t", brandIds: [BRAND_A] });
    await event(solo.id, SOURCE_ORG_ID, BRAND_A);

    const counts = await transfer({ ...BODY, targetBrandId: TARGET_BRAND });
    expect(counts).toMatchObject({ runs: 3, run_events: 1 });

    expect(await orgOf(solo.id)).toMatchObject({ organizationId: TARGET_ORG_ID, brandIds: [TARGET_BRAND] });
    expect(await orgOf(cobrand.id)).toMatchObject({ organizationId: TARGET_ORG_ID, brandIds: [BRAND_B, TARGET_BRAND] });
    expect(await orgOf(elsewhere.id)).toMatchObject({ organizationId: OTHER_ORG_ID, brandIds: [TARGET_BRAND] });
    const [e] = await db.select().from(runEvents).where(eq(runEvents.runId, solo.id));
    expect(e).toMatchObject({ orgId: TARGET_ORG_ID, brandIds: TARGET_BRAND });

    expect(await transfer({ ...BODY, targetBrandId: TARGET_BRAND })).toEqual({ runs: 0, runs_costs: 0, run_events: 0 });
  });

  it("moves the brand's campaign rollup rows with the runs", async () => {
    const r = await insertTestRun({ organizationId: SOURCE_ORG_ID, serviceName: "s", taskName: "t", brandIds: [BRAND_A], campaignId: CAMPAIGN_A });
    await insertTestRunCost({ runId: r.id, costName: "c", quantity: "1", unitCostInUsdCents: "2", totalCostInUsdCents: "2" });

    await transfer();

    const rollRuns = await sql`SELECT organization_id FROM stats_rollup_campaign_runs WHERE campaign_id = ${CAMPAIGN_A} AND run_count <> 0`;
    const rollCosts = await sql`SELECT organization_id FROM stats_rollup_campaign_costs WHERE campaign_id = ${CAMPAIGN_A} AND (n_actual <> 0 OR n_provisioned <> 0)`;
    expect(rollRuns.map((x) => x.organization_id)).toEqual([TARGET_ORG_ID]);
    expect(rollCosts.map((x) => x.organization_id)).toEqual([TARGET_ORG_ID]);
  });
});
