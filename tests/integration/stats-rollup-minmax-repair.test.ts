import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { runs } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";
import { CAMPAIGN_DAY_ROLLUP_NAME } from "../../src/services/stats-rollup-campaign.js";
import { repairStaleMinMax } from "../../src/services/stats-rollup-minmax-repair.js";

// A removed run marks its rollup group's min/max stale, and every read returning
// min/max then takes that whole UTC day from the live ledger (an org-wide scan in
// prod: brand-history reads past the 30 s statement timeout). The repair pass
// recomputes min/max from the ledger and clears the flag; the reads must then be
// served by the rollup with the SAME body the live query answers.

const ORG_ID = "7a330000-5555-4aaa-8aaa-555555555555";
const SUFFIX = randomUUID().slice(0, 8);
const FEAT = `minmax-repair-${SUFFIX}`;
const BRAND = randomUUID();
const C1 = randomUUID();

const app = createTestApp();
const headers = getAuthHeaders({ orgId: ORG_ID });

const DAY = "2026-07-01";
const at = (hh: string) => new Date(`${DAY}T${hh}:00.000Z`);

async function staleCount(table: string): Promise<number> {
  const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1 AND minmax_stale`, [ORG_ID]);
  return n;
}

async function readCosts(query: Record<string, string>, ready: boolean) {
  if (ready) {
    await sql`INSERT INTO stats_rollups (name, ready_at) VALUES (${CAMPAIGN_DAY_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  } else {
    await sql`DELETE FROM stats_rollups WHERE name = ${CAMPAIGN_DAY_ROLLUP_NAME}`;
  }
  const res = await request(app).get("/v1/stats/costs").set(headers).query(query);
  expect(res.status).toBe(200);
  return res.body.groups as any[];
}

describe("stale rollup min/max repair", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await cleanTestData([ORG_ID]);
    const mk = async (name: string, hh: string, opts: { campaign?: string } = {}) => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "svc",
        taskName: "task",
        brandIds: [BRAND],
        campaignId: opts.campaign,
        featureSlug: FEAT,
        workflowSlug: "wf-a",
        startedAt: at(hh),
      });
      await insertTestRunCost({ runId: run.id, costName: "x", quantity: "1", unitCostInUsdCents: "2.5", totalCostInUsdCents: "2.5", status: "actual" });
      ids[name] = run.id;
    };
    await mk("first", "01:00", { campaign: C1 });
    await mk("middle", "12:00", { campaign: C1 });
    await mk("last", "23:00", { campaign: C1 });
    await mk("noCampaignFirst", "02:00");
    await mk("noCampaignOnly", "03:00");
    // Removing the earliest / latest run of a group cannot shrink its min/max: stale.
    await db.delete(runs).where(eq(runs.id, ids.first));
    await db.delete(runs).where(eq(runs.id, ids.last));
    // A group left empty (run_count 0) is stale too.
    await db.delete(runs).where(eq(runs.id, ids.noCampaignOnly));
    await db.delete(runs).where(eq(runs.id, ids.noCampaignFirst));
  });

  afterAll(async () => {
    await cleanTestData([ORG_ID]);
    await closeDb();
  });

  it("marks the groups stale, then clears every flag of the org with exact min/max", async () => {
    expect(await staleCount("stats_rollup_campaign_runs")).toBeGreaterThan(0);
    expect(await staleCount("stats_rollup_org_task")).toBeGreaterThan(0);
    expect(await staleCount("stats_rollup_org_hour")).toBeGreaterThan(0);

    const results = await repairStaleMinMax(sql, 10_000);
    expect(results.every((r) => r.mismatched === 0)).toBe(true);

    expect(await staleCount("stats_rollup_campaign_runs")).toBe(0);
    expect(await staleCount("stats_rollup_org_task")).toBe(0);
    expect(await staleCount("stats_rollup_org_hour")).toBe(0);

    const [row] = await sql`SELECT min_started_at, max_started_at, run_count FROM stats_rollup_campaign_runs
                            WHERE organization_id = ${ORG_ID} AND campaign_id = ${C1}`;
    expect(Number(row.run_count)).toBe(1);
    expect(new Date(row.min_started_at).toISOString()).toBe(at("12:00").toISOString());
    expect(new Date(row.max_started_at).toISOString()).toBe(at("12:00").toISOString());
  });

  it("serves the brand-history read from the rollup with the live body after the repair", async () => {
    for (const query of [
      { groupBy: "workflowSlug,campaignId", brandId: BRAND, featureSlugs: FEAT },
      { groupBy: "campaignId", brandId: BRAND },
      { groupBy: "workflowSlug", brandId: BRAND, featureSlugs: FEAT, startedBefore: `${DAY}T23:59:59.999Z` },
    ]) {
      const rolled = await readCosts(query, true);
      const live = await readCosts(query, false);
      expect(rolled).toEqual(live);
      expect(rolled.length).toBeGreaterThan(0);
      expect(rolled[0].minStartedAt).toBe(at("12:00").toISOString());
      expect(rolled[0].maxStartedAt).toBe(at("12:00").toISOString());
    }
    await sql`INSERT INTO stats_rollups (name, ready_at) VALUES (${CAMPAIGN_DAY_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  });

  it("leaves a row stale when the ledger disagrees with its run count", async () => {
    // A rollup row claiming a run the ledger does not hold must stay stale (read live).
    await sql`UPDATE stats_rollup_campaign_runs SET run_count = run_count + 1, minmax_stale = true
              WHERE organization_id = ${ORG_ID} AND campaign_id = ${C1}`;
    const results = await repairStaleMinMax(sql, 10_000);
    expect(results.find((r) => r.table === "stats_rollup_campaign_runs")!.mismatched).toBeGreaterThanOrEqual(1);
    expect(await staleCount("stats_rollup_campaign_runs")).toBe(1);
    await sql`UPDATE stats_rollup_campaign_runs SET run_count = run_count - 1
              WHERE organization_id = ${ORG_ID} AND campaign_id = ${C1}`;
    await repairStaleMinMax(sql, 10_000);
    expect(await staleCount("stats_rollup_campaign_runs")).toBe(0);
  });
});
