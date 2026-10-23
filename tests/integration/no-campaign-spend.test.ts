import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";
import { sql } from "../../src/db/index.js";
import { isStatsRollupReady } from "../../src/services/stats-rollup.js";
import { rebuildNoCampaignDayRollup } from "../../src/services/stats-rollup-no-campaign-day.js";

const ORG_ID = "a7a7a7a7-0045-4000-a000-000000000001";
const OTHER_ORG_ID = "a7a7a7a7-0045-4000-a000-000000000002";
const ORG_IDS = [ORG_ID, OTHER_ORG_ID];
const CAMPAIGN = "camp-0045";
const SINCE = "2026-10-01T00:00:00.000Z";
const BEFORE = new Date("2026-09-30T23:59:59Z");
const AFTER = new Date("2026-10-05T12:00:00Z");

describe("no-campaign spend (migration 0045)", () => {
  const app = createTestApp();
  const headers = getInternalAuthHeaders();

  async function run(opts: { campaignId?: string; status?: string; orgId?: string; parentRunId?: string } = {}) {
    return insertTestRun({
      organizationId: opts.orgId ?? ORG_ID,
      serviceName: "svc",
      taskName: "task",
      campaignId: opts.campaignId,
      status: opts.status ?? "completed",
      parentRunId: opts.parentRunId,
    });
  }

  async function cost(runId: string, total: string, extra: Partial<Parameters<typeof insertTestRunCost>[0]> = {}) {
    return insertTestRunCost({
      runId,
      costName: "tokens",
      quantity: "1",
      unitCostInUsdCents: total,
      totalCostInUsdCents: total,
      createdAt: AFTER,
      ...extra,
    });
  }

  async function noCampaign(orgId = ORG_ID, since = SINCE) {
    const res = await request(app).get("/internal/org-no-campaign-total").set(headers).query({ org_id: orgId, since });
    expect(res.status).toBe(200);
    return res.body;
  }

  beforeEach(async () => {
    await cleanTestData(ORG_IDS);
  });

  afterAll(async () => {
    await cleanTestData(ORG_IDS);
    await closeDb();
  });

  it("401 without API key, 400 on a bad org_id or since", async () => {
    expect((await request(app).get("/internal/org-no-campaign-total").query({ org_id: ORG_ID, since: SINCE })).status).toBe(401);
    expect((await request(app).get("/internal/org-no-campaign-total").set(headers).query({ org_id: "nope", since: SINCE })).status).toBe(400);
    expect((await request(app).get("/internal/org-no-campaign-total").set(headers).query({ org_id: ORG_ID })).status).toBe(400);
    expect((await request(app).get("/internal/org-no-campaign-total").set(headers).query({ org_id: ORG_ID, since: "yesterday" })).status).toBe(400);
  });

  it("freezes the run's campaign on each cost row at insert; a child inherits its parent's campaign", async () => {
    const parent = await request(app)
      .post("/v1/runs")
      .set({ ...getAuthHeaders(), "x-org-id": ORG_ID, "x-campaign-id": CAMPAIGN })
      .send({ serviceName: "workflow", taskName: "execute-workflow" });
    expect(parent.status).toBe(201);
    expect(parent.body.campaignId).toBe(CAMPAIGN);
    const child = await request(app)
      .post("/v1/runs")
      .set({ ...getAuthHeaders(), "x-org-id": ORG_ID, "x-run-id": parent.body.id })
      .send({ serviceName: "chat", taskName: "complete" });
    expect(child.status).toBe(201);
    expect(child.body.campaignId).toBe(CAMPAIGN);
    const lone = await run();

    const a = await cost(child.body.id, "1.0000000000");
    const b = await cost(lone.id, "1.0000000000");
    const rows = await sql`SELECT id, run_has_campaign FROM runs_costs WHERE id IN (${a.id}, ${b.id})`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.run_has_campaign]));
    expect(byId[a.id]).toBe(true);
    expect(byId[b.id]).toBe(false);
  });

  it("is the no-campaign part of both totals from since on: total - part == campaign part, to the cent", async () => {
    const camp = await run({ campaignId: CAMPAIGN });
    const chat = await run();
    const chatRunning = await run({ status: "running" });
    const other = await run({ orgId: OTHER_ORG_ID });

    // Campaign spend: charged.
    await cost(camp.id, "10.0000000000", { netCostInUsdCents: "9.0000000000" });
    await cost(camp.id, "2.0000000000", { status: "provisioned" });
    // No-campaign spend after the cutover: absorbed.
    await cost(chat.id, "0.4000000000", { netCostInUsdCents: "0.3600000000" });
    await cost(chat.id, "0.0500000000", { status: "provisioned" });
    await cost(chatRunning.id, "0.2500000000");
    // Not in either total: cancelled, refunded, BYOK.
    await cost(chat.id, "5.0000000000", { status: "cancelled" });
    await cost(chat.id, "6.0000000000", { status: "refunded" });
    await cost(chat.id, "7.0000000000", { costSource: "org" });
    // No-campaign spend BEFORE the cutover: stays charged.
    await cost(chat.id, "3.0000000000", { createdAt: BEFORE });
    // Another org's no-campaign spend.
    await cost(other.id, "8.0000000000");

    const part = await noCampaign();
    expect(part).toMatchObject({
      org_id: ORG_ID,
      since: SINCE,
      spent_cents: "0.7000000000", // 0.40 + 0.05 + 0.25
      net_spent_cents: "0.6600000000", // 0.36 + 0.05 + 0.25
      total_expected_cents: "0.4000000000", // completed run's actual only
      net_total_expected_cents: "0.3600000000",
    });

    const usage = (await request(app).get("/internal/org-usage-total").set(headers).query({ org_id: ORG_ID })).body;
    const actual = (await request(app).get("/internal/org-actual-total").set(headers).query({ org_id: ORG_ID })).body;
    // Campaign part = what a customer is charged: the campaign rows + pre-cutover rows.
    expect(new Decimal(usage.spent_cents).minus(part.spent_cents).toFixed(10)).toBe("15.0000000000"); // 10 + 2 + 3
    expect(new Decimal(usage.net_spent_cents).minus(part.net_spent_cents).toFixed(10)).toBe("14.0000000000"); // 9 + 2 + 3
    expect(new Decimal(actual.total_expected_cents).minus(part.total_expected_cents).toFixed(10)).toBe("13.0000000000"); // 10 + 3
    expect(new Decimal(actual.net_total_expected_cents).minus(part.net_total_expected_cents).toFixed(10)).toBe("12.0000000000"); // 9 + 3

    // An org with nothing: zeros in the totals' format.
    await cleanTestData(ORG_IDS);
    expect(await noCampaign()).toMatchObject({
      spent_cents: "0.0000000000",
      net_spent_cents: "0.0000000000",
      total_expected_cents: "0.0000000000",
      net_total_expected_cents: "0.0000000000",
    });
  });

  it("follows a run completing after its cost was written", async () => {
    const chat = await run({ status: "running" });
    await cost(chat.id, "1.0000000000");
    expect((await noCampaign()).total_expected_cents).toBe("0.0000000000");
    await sql`UPDATE runs SET status = 'completed' WHERE id = ${chat.id}`;
    expect((await noCampaign()).total_expected_cents).toBe("1.0000000000");
  });

  it("500s when a cost row in the window has no known campaign status, never folds it", async () => {
    const chat = await run();
    const c = await cost(chat.id, "1.0000000000");
    await sql`UPDATE runs_costs SET run_has_campaign = NULL WHERE id = ${c.id}`;
    const res = await request(app).get("/internal/org-no-campaign-total").set(headers).query({ org_id: ORG_ID, since: SINCE });
    expect(res.status).toBe(500);
    // Outside the window it does not matter.
    expect((await noCampaign(ORG_ID, "2026-11-01T00:00:00Z")).spent_cents).toBe("0.0000000000");
  });

  it("monthly read: the 0055 rollup answers byte-identical to the live query, through updates, deletes and an org move", async () => {
    const mine = (body: any) => body.orgs.filter((o: any) => ORG_IDS.includes(o.orgId));
    async function both() {
      const ready = await request(app).get("/internal/stats/costs/no-campaign/monthly").set(headers);
      expect(ready.status).toBe(200);
      await sql`DELETE FROM stats_rollups WHERE name = 'no_campaign_day'`;
      try {
        const live = await request(app).get("/internal/stats/costs/no-campaign/monthly").set(headers);
        expect(live.status).toBe(200);
        expect(JSON.stringify(mine(ready.body))).toBe(JSON.stringify(mine(live.body)));
        return mine(ready.body);
      } finally {
        await sql`INSERT INTO stats_rollups (name, ready_at) VALUES ('no_campaign_day', now()) ON CONFLICT (name) DO NOTHING`;
      }
    }
    expect(await isStatsRollupReady("no_campaign_day")).toBe(true);

    const camp = await run({ campaignId: CAMPAIGN });
    const chat = await run();
    const other = await run({ orgId: OTHER_ORG_ID });
    await cost(camp.id, "10.0000000000");
    const a = await cost(chat.id, "0.4000000000", { netCostInUsdCents: "0.3000000000" });
    await cost(chat.id, "0", { costName: "free-tier" });
    const prov = await cost(chat.id, "3.0000000000", { status: "provisioned", createdAt: BEFORE });
    const gone = await cost(chat.id, "5.0000000000", { costName: "gone" });
    const unknown = await cost(other.id, "2.0000000000", { createdAt: BEFORE, costName: "legacy" });
    await cost(chat.id, "9.0000000000", { status: "cancelled" });
    await cost(chat.id, "7.0000000000", { costSource: "org" });
    expect((await both()).length).toBeGreaterThan(0);

    await sql`UPDATE runs_costs SET run_has_campaign = NULL WHERE id = ${unknown.id}`;
    await sql`UPDATE runs_costs SET status = 'actual' WHERE id = ${prov.id}`;
    await sql`UPDATE runs_costs SET status = 'cancelled' WHERE id = ${a.id}`;
    await sql`DELETE FROM runs_costs WHERE id = ${gone.id}`;
    await sql`UPDATE runs_costs SET organization_id = ${OTHER_ORG_ID}::uuid WHERE run_id = ${camp.id}`;
    const after = await both();
    const oct = after.find((o: any) => o.orgId === ORG_ID && o.month === "2026-10");
    expect(oct.noCampaignByCostName.map((c: any) => c.costName)).toEqual(["free-tier"]);
    expect(oct.noCampaignByCostName[0].noCampaignCostInUsdCents).toBe("0.0000000000");
    expect(oct.campaignCostInUsdCents).toBe("0");

    // A rebuild from the ledger lands on the same figures as the triggers did.
    await rebuildNoCampaignDayRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    expect(await both()).toEqual(after);
  });

  it("monthly fleet read: per org per UTC month, campaign / no campaign / unknown, no-campaign per cost name", async () => {
    const camp = await run({ campaignId: CAMPAIGN });
    const chat = await run();
    await cost(camp.id, "10.0000000000", { createdAt: AFTER });
    await cost(chat.id, "0.4000000000", { createdAt: AFTER, netCostInUsdCents: "0.3000000000" });
    await cost(chat.id, "0.1000000000", { createdAt: AFTER, costName: "stripe-processing-fee" });
    await cost(chat.id, "1.0000000000", { createdAt: BEFORE });
    const unknown = await cost(chat.id, "2.0000000000", { createdAt: BEFORE, costName: "legacy" });
    await sql`UPDATE runs_costs SET run_has_campaign = NULL WHERE id = ${unknown.id}`;
    await cost(chat.id, "9.0000000000", { createdAt: AFTER, status: "cancelled" });

    const res = await request(app).get("/internal/stats/costs/no-campaign/monthly").set(headers);
    expect(res.status).toBe(200);
    const oct = res.body.orgs.find((o: any) => o.orgId === ORG_ID && o.month === "2026-10");
    const sep = res.body.orgs.find((o: any) => o.orgId === ORG_ID && o.month === "2026-09");
    expect(oct).toMatchObject({
      noCampaignCostInUsdCents: "0.5000000000",
      netNoCampaignCostInUsdCents: "0.4000000000",
      campaignCostInUsdCents: "10.0000000000",
      netCampaignCostInUsdCents: "10.0000000000",
      unknownCostInUsdCents: "0",
    });
    expect(oct.noCampaignByCostName).toEqual([
      { costName: "stripe-processing-fee", noCampaignCostInUsdCents: "0.1000000000", netNoCampaignCostInUsdCents: "0.1000000000" },
      { costName: "tokens", noCampaignCostInUsdCents: "0.4000000000", netNoCampaignCostInUsdCents: "0.3000000000" },
    ]);
    expect(sep).toMatchObject({
      noCampaignCostInUsdCents: "1.0000000000",
      campaignCostInUsdCents: "0",
      unknownCostInUsdCents: "2.0000000000",
      netUnknownCostInUsdCents: "2.0000000000",
    });

    // months[] is dense to the current month and starts at the first month with a row.
    const months = res.body.months.map((m: any) => m.month);
    expect(months).toContain("2026-09");
    expect(months).toContain("2026-10");
    for (let i = 1; i < months.length; i++) {
      const [y, m] = months[i - 1].split("-").map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      expect(months[i]).toBe(next);
    }
    const now = new Date();
    expect(months[months.length - 1]).toBe(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`);
  });

  it("public costs timeseries hasCampaign=true|false split the unfiltered series", async () => {
    const camp = await run({ campaignId: CAMPAIGN });
    const chat = await run();
    await cost(camp.id, "10.0000000000");
    await cost(chat.id, "0.4000000000");

    const q = { orgId: ORG_ID, costSource: "platform", interval: "month" };
    const all = await request(app).get("/v1/stats/public/costs/timeseries").query(q);
    const yes = await request(app).get("/v1/stats/public/costs/timeseries").query({ ...q, hasCampaign: "true" });
    const no = await request(app).get("/v1/stats/public/costs/timeseries").query({ ...q, hasCampaign: "false" });
    expect([all.status, yes.status, no.status]).toEqual([200, 200, 200]);
    const sum = (b: any) => b.body.buckets.reduce((acc: Decimal, x: any) => acc.plus(x.actualCostInUsdCents), new Decimal(0));
    expect(sum(yes).toFixed(10)).toBe("10.0000000000");
    expect(sum(no).toFixed(10)).toBe("0.4000000000");
    expect(sum(all).toFixed(10)).toBe("10.4000000000");

    const bad = await request(app).get("/v1/stats/public/costs/timeseries").query({ ...q, hasCampaign: "maybe" });
    expect(bad.status).toBe(400);
  });
});
