import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";
import { sql } from "../../src/db/index.js";

const ORG_ID = "a7a7a7a7-0046-4000-a000-000000000001";
const OTHER_ORG_ID = "a7a7a7a7-0046-4000-a000-000000000002";
const ORG_IDS = [ORG_ID, OTHER_ORG_ID];
const CAMPAIGN = "camp-0046";

// GET /internal/org-no-campaign-total reads whole UTC days from org_no_campaign_days
// (migration 0046) and the cutover's own partial day live. Every test compares it,
// for several cutovers (mid-day and midnight), to the LIVE definition below: the
// figure 0045 served by scanning the ledger.
const SINCES = ["2026-09-01T00:00:00.000Z", "2026-10-01T12:00:00.000Z", "2026-10-02T00:00:00.000Z", "2026-10-05T23:30:00.000Z"];

async function live(orgId: string, since: string) {
  const [row] = await sql`
    SELECT
      COALESCE(SUM(rc.total_cost_in_usd_cents), 0)::text AS spent,
      COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)), 0)::text AS net_spent,
      COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.is_platform_committed AND r.status IN ('completed','failed')), 0)::text AS actual,
      COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.is_platform_committed AND r.status IN ('completed','failed')), 0)::text AS net_actual
    FROM runs_costs rc JOIN runs r ON r.id = rc.run_id
    WHERE rc.organization_id = ${orgId}::uuid AND rc.is_platform_projected
      AND rc.run_has_campaign = false AND rc.created_at >= ${since}::timestamptz
  `;
  return {
    spent_cents: new Decimal(row.spent).toFixed(10),
    net_spent_cents: new Decimal(row.net_spent).toFixed(10),
    total_expected_cents: new Decimal(row.actual).toFixed(10),
    net_total_expected_cents: new Decimal(row.net_actual).toFixed(10),
  };
}

describe("org_no_campaign_days (migration 0046)", () => {
  const app = createTestApp();
  const headers = getInternalAuthHeaders();

  async function expectParity() {
    for (const orgId of ORG_IDS) {
      for (const since of SINCES) {
        const res = await request(app).get("/internal/org-no-campaign-total").set(headers).query({ org_id: orgId, since });
        expect(res.status).toBe(200);
        const { spent_cents, net_spent_cents, total_expected_cents, net_total_expected_cents } = res.body;
        expect({ spent_cents, net_spent_cents, total_expected_cents, net_total_expected_cents }, `${orgId} ${since}`).toEqual(await live(orgId, since));
      }
    }
  }

  async function run(opts: { campaignId?: string; status?: string; orgId?: string } = {}) {
    return insertTestRun({ organizationId: opts.orgId ?? ORG_ID, serviceName: "svc", taskName: "task", campaignId: opts.campaignId, status: opts.status ?? "completed" });
  }

  async function cost(runId: string, total: string, at: string, extra: Partial<Parameters<typeof insertTestRunCost>[0]> = {}) {
    return insertTestRunCost({ runId, costName: "tokens", quantity: "1", unitCostInUsdCents: total, totalCostInUsdCents: total, createdAt: new Date(at), ...extra });
  }

  beforeEach(async () => {
    await cleanTestData(ORG_IDS);
    await sql`DELETE FROM org_no_campaign_days WHERE organization_id IN ${sql(ORG_IDS)}`;
  });

  afterAll(async () => {
    await cleanTestData(ORG_IDS);
    await closeDb();
  });

  it("matches the live ledger through inserts, statuses, run transitions, deletes and an org move", async () => {
    const chat = await run();
    const pending = await run({ status: "running" });
    const camp = await run({ campaignId: CAMPAIGN });
    await cost(camp.id, "10.0000000000", "2026-10-03T10:00:00Z");
    const a = await cost(chat.id, "0.4000000000", "2026-10-01T09:00:00Z", { netCostInUsdCents: "0.3000000000" });
    await cost(chat.id, "0.2000000000", "2026-10-01T15:00:00Z");
    const hold = await cost(chat.id, "0.0500000000", "2026-10-02T00:00:00Z", { status: "provisioned" });
    await cost(pending.id, "1.0000000000", "2026-10-05T23:45:00Z");
    await cost(chat.id, "7.0000000000", "2026-10-04T08:00:00Z", { costSource: "org" });
    await expectParity();

    // Hold actualized, a charge refunded, a hold cancelled.
    await sql`UPDATE runs_costs SET status = 'actual' WHERE id = ${hold.id}`;
    await sql`UPDATE runs_costs SET status = 'refunded' WHERE id = ${a.id}`;
    const hold2 = await cost(pending.id, "0.3000000000", "2026-10-06T01:00:00Z", { status: "provisioned" });
    await sql`UPDATE runs_costs SET status = 'cancelled' WHERE id = ${hold2.id}`;
    await expectParity();

    // Run settles, then fails over (no-op), then a cost lands on a settled run.
    await sql`UPDATE runs SET status = 'completed' WHERE id = ${pending.id}`;
    await cost(pending.id, "0.7000000000", "2026-10-07T00:00:00Z");
    await expectParity();

    // Move the chat run (and its costs) to another org, as transfer-brand does.
    await sql`UPDATE runs SET organization_id = ${OTHER_ORG_ID} WHERE id = ${chat.id}`;
    await sql`UPDATE runs_costs SET organization_id = ${OTHER_ORG_ID} WHERE run_id = ${chat.id}`;
    await expectParity();

    // Backfill flips an unknown row to no-campaign.
    const unknown = await cost(pending.id, "0.9000000000", "2026-10-08T00:00:00Z");
    await sql`UPDATE runs_costs SET run_has_campaign = NULL WHERE id = ${unknown.id}`;
    await sql`UPDATE runs_costs SET run_has_campaign = false WHERE id = ${unknown.id}`;
    await expectParity();

    // Delete a settled run with costs (cascade).
    await sql`DELETE FROM runs WHERE id = ${pending.id}`;
    await expectParity();
  });

  it("stays exact when costs land while their run completes, concurrently", async () => {
    const runs = await Promise.all(Array.from({ length: 10 }, () => run({ status: "running" })));
    await Promise.all(
      runs.flatMap((r, i) => [
        cost(r.id, "0.1000000000", `2026-10-0${(i % 7) + 1}T12:00:00Z`),
        sql`UPDATE runs SET status = 'completed' WHERE id = ${r.id}`,
        cost(r.id, "0.0100000000", `2026-10-0${(i % 7) + 2}T06:00:00Z`),
      ])
    );
    await expectParity();
  });
});
