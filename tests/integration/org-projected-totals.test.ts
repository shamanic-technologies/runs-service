import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq, sql as dsql } from "drizzle-orm";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { runsCosts } from "../../src/db/schema.js";
import { readOrgProjectedTotal, rebuildOrgProjectedRollup } from "../../src/services/org-projected-totals.js";

// LEDGER-LOAD-1107-SPEND (migration 0105): GET /internal/org-usage-total and the usage
// hint read org_projected_totals, kept by trigger. Every test compares the served body
// with the live SUM over the ledger, after each kind of write that can move it.
const ORG_ID = "a7a7a7a7-0105-4000-a000-000000000001";
const OTHER_ORG_ID = "a7a7a7a7-0105-4000-a000-000000000002";
const ORG_IDS = [ORG_ID, OTHER_ORG_ID];

describe("org_projected_totals (GET /internal/org-usage-total)", () => {
  const app = createTestApp();
  const headers = getInternalAuthHeaders();

  async function liveSum(orgId: string) {
    const rows = (await db.execute(dsql`
      SELECT COALESCE(SUM(rc.total_cost_in_usd_cents), 0) AS spent_cents,
             COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)), 0) AS net_spent_cents
        FROM runs_costs rc
       WHERE rc.organization_id = ${orgId} AND rc.is_platform_projected
    `)) as any[];
    const { Decimal } = await import("decimal.js");
    return {
      spent_cents: new Decimal(rows[0].spent_cents).toFixed(10),
      net_spent_cents: new Decimal(rows[0].net_spent_cents).toFixed(10),
    };
  }

  async function expectMatchesLedger(orgId: string) {
    const res = await request(app).get("/internal/org-usage-total").set(headers).query({ org_id: orgId });
    expect(res.status).toBe(200);
    const live = await liveSum(orgId);
    expect(res.body.spent_cents).toBe(live.spent_cents);
    expect(res.body.net_spent_cents).toBe(live.net_spent_cents);
    expect((await readOrgProjectedTotal(db, orgId)).source).toBe("rollup");
    return res.body;
  }

  async function run(orgId: string | null = ORG_ID) {
    return insertTestRun({ organizationId: orgId, serviceName: "svc", taskName: "task", status: "running" });
  }

  async function cost(runId: string, total: string, extra: Partial<Parameters<typeof insertTestRunCost>[0]> = {}) {
    return insertTestRunCost({ runId, costName: "tokens", quantity: "1", unitCostInUsdCents: total, totalCostInUsdCents: total, ...extra });
  }

  beforeEach(async () => {
    await cleanTestData(ORG_IDS);
  });

  afterAll(async () => {
    await cleanTestData(ORG_IDS);
    await closeDb();
  });

  it("is stamped on a fresh database and serves zero for an org with no spend", async () => {
    const body = await expectMatchesLedger(ORG_ID);
    expect(body.spent_cents).toBe("0.0000000000");
  });

  it("follows inserts, status transitions, amount changes, org moves and deletes", async () => {
    const r = await run();
    const hold = await cost(r.id, "2.0000000002", { status: "provisioned" });
    const charged = await cost(r.id, "1.2345678901", { status: "actual", netCostInUsdCents: "0.7407407341", usageDiscountPct: "0.40000000" });
    await cost(r.id, "9.0000000000", { status: "cancelled" });
    await cost(r.id, "7.0000000000", { status: "actual", costSource: "org" });
    expect((await expectMatchesLedger(ORG_ID)).spent_cents).toBe("3.2345678903");

    await db.update(runsCosts).set({ status: "actual" }).where(eq(runsCosts.id, hold.id));
    await expectMatchesLedger(ORG_ID);
    await db.update(runsCosts).set({ status: "refunded" }).where(eq(runsCosts.id, hold.id));
    expect((await expectMatchesLedger(ORG_ID)).spent_cents).toBe("1.2345678901");
    expect((await expectMatchesLedger(ORG_ID)).net_spent_cents).toBe("0.7407407341");

    // re-price (gross + net move in place)
    await db.update(runsCosts)
      .set({ totalCostInUsdCents: "2.5000000000", netCostInUsdCents: "1.5000000000" })
      .where(eq(runsCosts.id, charged.id));
    await expectMatchesLedger(ORG_ID);

    // the cost org moves (brand transfer)
    await db.update(runsCosts).set({ organizationId: OTHER_ORG_ID }).where(eq(runsCosts.id, charged.id));
    expect((await expectMatchesLedger(ORG_ID)).spent_cents).toBe("0.0000000000");
    expect((await expectMatchesLedger(OTHER_ORG_ID)).spent_cents).toBe("2.5000000000");

    // a NULL cost org counts nowhere
    await db.update(runsCosts).set({ organizationId: null }).where(eq(runsCosts.id, charged.id));
    expect((await expectMatchesLedger(OTHER_ORG_ID)).spent_cents).toBe("0.0000000000");
    await db.update(runsCosts).set({ organizationId: ORG_ID }).where(eq(runsCosts.id, charged.id));

    await db.delete(runsCosts).where(eq(runsCosts.id, charged.id));
    await expectMatchesLedger(ORG_ID);

    const r2 = await run();
    await cost(r2.id, "4.0000000000", { status: "actual" });
    await cleanTestData([ORG_ID]); // FK cascade from runs
    expect((await expectMatchesLedger(ORG_ID)).spent_cents).toBe("0.0000000000");
  });

  it("adds up 20 concurrent cost writes on one org exactly", async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => run()));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => cost(rs[i % 5].id, `0.${String(i + 1).padStart(10, "0")}`, { status: i % 3 === 0 ? "provisioned" : "actual" })),
    );
    const rows = await db.select().from(runsCosts).where(eq(runsCosts.organizationId, ORG_ID));
    await Promise.all(rows.filter((_, i) => i % 2 === 0).map((c) => db.update(runsCosts).set({ status: "actual" }).where(eq(runsCosts.id, c.id))));
    await expectMatchesLedger(ORG_ID);
  });

  it("serves the live SUM while un-stamped, and a rebuild restores the same figures", async () => {
    const r = await run();
    await cost(r.id, "3.3333333333", { status: "actual", netCostInUsdCents: "2.0000000000" });
    await cost(r.id, "1.0000000001", { status: "provisioned" });
    const before = await expectMatchesLedger(ORG_ID);

    await db.transaction(async (tx) => {
      await tx.execute(dsql`DELETE FROM stats_rollups WHERE name = 'org_projected'`);
      const live = await readOrgProjectedTotal(tx, ORG_ID);
      expect(live.source).toBe("live");
      const { Decimal } = await import("decimal.js");
      expect(new Decimal(live.spentCents).toFixed(10)).toBe(before.spent_cents);
      expect(new Decimal(live.netSpentCents).toFixed(10)).toBe(before.net_spent_cents);
      tx.rollback();
    }).catch((err) => {
      if (!String(err?.message ?? err).toLowerCase().includes("rollback")) throw err;
    });

    await rebuildOrgProjectedRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    const after = await expectMatchesLedger(ORG_ID);
    expect(after.spent_cents).toBe(before.spent_cents);
    expect(after.net_spent_cents).toBe(before.net_spent_cents);
  });

  it("two overlapping rebuilds never double the figures", async () => {
    const r = await run();
    await cost(r.id, "5.0000000000", { status: "actual" });
    const before = await expectMatchesLedger(ORG_ID);
    const url = process.env.RUNS_SERVICE_DATABASE_URL!;
    await Promise.all([rebuildOrgProjectedRollup(url), rebuildOrgProjectedRollup(url), rebuildOrgProjectedRollup(url)]);
    const after = await expectMatchesLedger(ORG_ID);
    expect(after.spent_cents).toBe(before.spent_cents);
  });
});
