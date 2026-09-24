import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";
import { db, sql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";

// File-local org ids keep this file isolated from other integration files running in parallel.
const ORG_ID = "a7a7a7a7-0034-4000-a000-000000000001";
const OTHER_ORG_ID = "a7a7a7a7-0034-4000-a000-000000000002";
const ORG_IDS = [ORG_ID, OTHER_ORG_ID];
const BRAND_ID = "a7a7a7a7-0034-4000-b000-00000000b0b0";

// GET /internal/org-actual-total must serve the SAME two figures that
// GET /internal/runs-expected-totals computes from the ledger, after every kind of
// write that can move them. Each test ends by comparing the two routes byte for byte.
describe("GET /internal/org-actual-total", () => {
  const app = createTestApp();
  const headers = getInternalAuthHeaders();

  async function actual(orgId: string) {
    const res = await request(app).get("/internal/org-actual-total").set(headers).query({ org_id: orgId });
    expect(res.status).toBe(200);
    return res.body;
  }

  async function expectMatchesLedger(orgId: string) {
    const ledger = await request(app).get("/internal/runs-expected-totals").set(headers).query({ org_id: orgId });
    expect(ledger.status).toBe(200);
    const fast = await actual(orgId);
    expect(fast.total_expected_cents).toBe(ledger.body.total_expected_cents);
    expect(fast.net_total_expected_cents).toBe(ledger.body.net_total_expected_cents);
    return fast;
  }

  async function run(status: string, orgId: string | null = ORG_ID) {
    return insertTestRun({ organizationId: orgId, serviceName: "svc", taskName: "task", status });
  }

  async function cost(runId: string, total: string, extra: Partial<Parameters<typeof insertTestRunCost>[0]> = {}) {
    return insertTestRunCost({
      runId,
      costName: "tokens",
      quantity: "1",
      unitCostInUsdCents: total,
      totalCostInUsdCents: total,
      ...extra,
    });
  }

  beforeEach(async () => {
    await cleanTestData(ORG_IDS);
  });

  afterAll(async () => {
    await cleanTestData(ORG_IDS);
    await closeDb();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).get("/internal/org-actual-total").query({ org_id: ORG_ID });
    expect(res.status).toBe(401);
  });

  it("returns 400 when org_id is not a UUID", async () => {
    const res = await request(app).get("/internal/org-actual-total").set(headers).query({ org_id: "nope" });
    expect(res.status).toBe(400);
  });

  it("answers '0' for an org with nothing charged, like runs-expected-totals", async () => {
    const body = await expectMatchesLedger(ORG_ID);
    expect(body).toMatchObject({ org_id: ORG_ID, total_expected_cents: "0", net_total_expected_cents: "0" });
  });

  it("counts only committed platform rows of completed/failed runs, net of discount", async () => {
    const completed = await run("completed");
    const failed = await run("failed");
    const running = await run("running");
    await cost(completed.id, "0.5000000000");
    await cost(completed.id, "2.0000000000", { netCostInUsdCents: "1.0000000000", usageDiscountPct: "0.50000000" });
    await cost(failed.id, "1.2500000000");
    await cost(running.id, "7.0000000000");
    await cost(completed.id, "3.0000000000", { status: "provisioned" });
    await cost(completed.id, "4.0000000000", { status: "cancelled" });
    await cost(completed.id, "5.0000000000", { costSource: "org" });

    const body = await expectMatchesLedger(ORG_ID);
    expect(body.total_expected_cents).toBe("3.7500000000");
    expect(body.net_total_expected_cents).toBe("2.7500000000");
  });

  it("moves a run's costs in when it settles and out if it goes back", async () => {
    const r = await run("running");
    await cost(r.id, "1.0000000000");
    expect((await expectMatchesLedger(ORG_ID)).total_expected_cents).toBe("0");

    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, r.id));
    expect((await expectMatchesLedger(ORG_ID)).total_expected_cents).toBe("1.0000000000");

    await db.update(runs).set({ status: "failed" }).where(eq(runs.id, r.id));
    expect((await expectMatchesLedger(ORG_ID)).total_expected_cents).toBe("1.0000000000");

    await db.update(runs).set({ status: "running" }).where(eq(runs.id, r.id));
    expect((await expectMatchesLedger(ORG_ID)).total_expected_cents).toBe("0");
  });

  it("follows cost status: materialize adds, cancel and refund remove", async () => {
    const r = await run("completed");
    const hold = await cost(r.id, "2.0000000000", { status: "provisioned" });
    expect((await expectMatchesLedger(ORG_ID)).total_expected_cents).toBe("0");

    await db.update(runsCosts).set({ status: "actual" }).where(eq(runsCosts.id, hold.id));
    expect((await expectMatchesLedger(ORG_ID)).total_expected_cents).toBe("2.0000000000");

    await db.update(runsCosts).set({ status: "refunded" }).where(eq(runsCosts.id, hold.id));
    expect((await expectMatchesLedger(ORG_ID)).total_expected_cents).toBe("0");

    const other = await cost(r.id, "1.5000000000");
    await db.update(runsCosts).set({ status: "cancelled" }).where(eq(runsCosts.id, other.id));
    expect((await expectMatchesLedger(ORG_ID)).total_expected_cents).toBe("0");
  });

  it("subtracts a deleted run's costs exactly once (FK cascade)", async () => {
    const keep = await run("completed");
    const gone = await run("completed");
    await cost(keep.id, "1.0000000000");
    await cost(gone.id, "2.0000000000");
    await cost(gone.id, "3.0000000000");
    expect((await expectMatchesLedger(ORG_ID)).total_expected_cents).toBe("6.0000000000");

    await db.delete(runs).where(eq(runs.id, gone.id));
    expect((await expectMatchesLedger(ORG_ID)).total_expected_cents).toBe("1.0000000000");
  });

  it("moves totals between orgs on transfer-brand", async () => {
    const r = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc",
      taskName: "task",
      status: "completed",
      brandIds: [BRAND_ID],
    });
    await cost(r.id, "4.0000000000");

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ sourceBrandId: BRAND_ID, sourceOrgId: ORG_ID, targetOrgId: OTHER_ORG_ID });
    expect(res.status).toBe(200);

    expect((await expectMatchesLedger(ORG_ID)).total_expected_cents).toBe("0");
    expect((await expectMatchesLedger(OTHER_ORG_ID)).total_expected_cents).toBe("4.0000000000");

    const [moved] = await db.select().from(runsCosts).where(eq(runsCosts.runId, r.id));
    expect(moved.organizationId).toBe(OTHER_ORG_ID);
  });

  it("ignores org-less platform runs", async () => {
    const r = await run("completed", null);
    await cost(r.id, "9.0000000000");
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM org_actual_totals WHERE organization_id IS NULL`;
    // Delete only this run: other files on the shard own org-less runs of their own.
    await db.delete(runs).where(eq(runs.id, r.id));
    expect(n).toBe(0);
  });

  it("answers '0' when every charged row is zero, like runs-expected-totals", async () => {
    const r = await run("completed");
    await cost(r.id, "0.0000000000");
    const body = await expectMatchesLedger(ORG_ID);
    expect(body.total_expected_cents).toBe("0");
  });

  it("stays equal to a full recompute under concurrent cost writes and run settlement", async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => run("running")));
    await Promise.all(
      rs.flatMap((r, i) => [
        cost(r.id, `${i + 1}.0000000000`),
        db.update(runs).set({ status: "completed" }).where(eq(runs.id, r.id)),
        cost(r.id, "0.1000000000"),
      ])
    );
    const body = await expectMatchesLedger(ORG_ID);
    expect(body.total_expected_cents).toBe("56.0000000000");
  });
});
