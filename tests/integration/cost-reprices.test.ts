import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq, inArray, and } from "drizzle-orm";
import { db, sql as rawSql } from "../../src/db/index.js";
import { runsCosts, costLifecycleEvents } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from "../helpers/test-app.js";
import { staleComputedDays } from "../../src/services/outcome-ledger.js";
import { setRepriceTestHookForTests } from "../../src/routes/reprices.js";
import { REPRICE_APPLY_TX_COSTS } from "../../src/schemas.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";

// NEWSLETTER-COST-1107: costs-service froze `postmark-email-send` at 1.1923620000
// cents for three weeks; our own org's sends were re-priced to the real price.
// The action must: select exactly what the preview shows, never touch another
// org / cost name / price / status, be idempotent, keep the old price in bronze,
// and move every rollup reading those rows.

const ORG_ID = "4e9c0000-1111-4aaa-8aaa-111111111107";
const OTHER_ORG_ID = "4e9c0000-2222-4aaa-8aaa-222222221107";
const CLEANUP = [ORG_ID, OTHER_ORG_ID];

vi.mock("../../src/services/billing.js", () => ({
  notifyUsage: vi.fn().mockResolvedValue(undefined),
  fetchOrgPlatformSpent: vi.fn().mockResolvedValue(0),
}));

const app = createTestApp();
const internal = getInternalAuthHeaders();
const auth = getAuthHeaders({ orgId: ORG_ID });

const FROZEN = "1.1923620000";
const REAL = "0.1650000000";
const COST = "postmark-email-send";

const filter = {
  orgId: ORG_ID,
  costName: COST,
  fromUnitCostInUsdCents: FROZEN,
  toUnitCostInUsdCents: REAL,
  createdAfter: "2026-10-16T00:00:00.000Z",
};
const applyBody = { ...filter, reason: "frozen catalogue price 2026-10-17..11-07", repricedBy: "test@distribute.you" };

async function seed() {
  const run = await insertTestRun({
    organizationId: ORG_ID,
    serviceName: "postmark-service",
    taskName: "email-send",
    startedAt: new Date("2026-10-20T10:00:00Z"),
  });
  const mk = (o: Partial<Parameters<typeof insertTestRunCost>[0]> & { runId?: string }) =>
    insertTestRunCost({
      runId: run.id,
      costName: COST,
      quantity: "1",
      unitCostInUsdCents: FROZEN,
      totalCostInUsdCents: FROZEN,
      netCostInUsdCents: FROZEN,
      status: "actual",
      createdAt: new Date("2026-10-20T10:00:01Z"),
      ...o,
    });
  const targets = [
    await mk({ createdAt: new Date("2026-10-20T10:00:01Z") }),
    await mk({ createdAt: new Date("2026-10-21T10:00:01Z") }),
    // a row with a frozen 20% usage discount: net follows at 80% of the new gross
    await mk({ quantity: "2", totalCostInUsdCents: "2.3847240000", netCostInUsdCents: "1.9077792000", usageDiscountPct: "0.20000000", createdAt: new Date("2026-10-22T10:00:01Z") }),
  ];
  const otherRun = await insertTestRun({
    organizationId: OTHER_ORG_ID,
    serviceName: "postmark-service",
    taskName: "email-send",
    startedAt: new Date("2026-10-20T10:00:00Z"),
  });
  const decoys = [
    await mk({ runId: otherRun.id }), // another org, same name + price
    await mk({ costName: "postmark-email-send-other", }), // other cost name
    await mk({ unitCostInUsdCents: "0.1955670000", totalCostInUsdCents: "0.1955670000", netCostInUsdCents: "0.1955670000" }), // other price
    await mk({ status: "provisioned" }),
    await mk({ costSource: "org" }),
    await mk({ status: "refunded" }),
    await mk({ createdAt: new Date("2026-10-15T23:59:59Z") }), // before the window
  ];
  return { run, targets, decoys };
}

async function rowsById(ids: string[]) {
  const rows = await db.select().from(runsCosts).where(inArray(runsCosts.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

describe("POST /internal/cost-reprices/{preview,apply} (NEWSLETTER-COST-1107)", () => {
  beforeEach(async () => {
    await cleanTestData(CLEANUP);
  });
  afterAll(async () => {
    await cleanTestData(CLEANUP);
    await closeDb();
  });

  it("requires internal auth and a different target price", async () => {
    expect((await request(app).post("/internal/cost-reprices/preview").send(filter)).status).toBe(401);
    expect((await request(app).post("/internal/cost-reprices/apply").send(applyBody)).status).toBe(401);
    const same = await request(app)
      .post("/internal/cost-reprices/preview")
      .set(internal)
      .send({ ...filter, toUnitCostInUsdCents: "1.192362" });
    expect(same.status).toBe(400);
    const noReason = await request(app).post("/internal/cost-reprices/apply").set(internal).send(filter);
    expect(noReason.status).toBe(400);
  });

  it("preview selects exactly the targets, with before/after totals, and writes nothing", async () => {
    const { targets, decoys } = await seed();
    const res = await request(app).post("/internal/cost-reprices/preview").set(internal).send(filter);
    expect(res.status).toBe(200);
    expect(res.body.costs.map((c: any) => c.id).sort()).toEqual(targets.map((t) => t.id).sort());
    expect(res.body.costCount).toBe(3);
    expect(res.body.runCount).toBe(1);
    expect(res.body.grossBeforeInUsdCents).toBe("4.7694480000");
    expect(res.body.grossAfterInUsdCents).toBe("0.6600000000");
    expect(res.body.netBeforeInUsdCents).toBe("4.2925032000");
    expect(res.body.netAfterInUsdCents).toBe("0.5940000000"); // 0.165 + 0.165 + 0.33 x 0.8
    const after = await rowsById([...targets, ...decoys].map((r) => r.id));
    for (const r of [...targets, ...decoys]) expect(after.get(r.id)!.totalCostInUsdCents).toBe(r.totalCostInUsdCents);
  });

  it("apply re-prices exactly the preview set (in batches), never another org's row, and keeps history", async () => {
    const { targets, decoys } = await seed();
    const usageBefore = await request(app).get("/internal/org-usage-total").set(internal).query({ org_id: ORG_ID });
    const otherUsageBefore = await request(app).get("/internal/org-usage-total").set(internal).query({ org_id: OTHER_ORG_ID });
    const preview = await request(app).post("/internal/cost-reprices/preview").set(internal).send(filter);

    const first = await request(app).post("/internal/cost-reprices/apply").set(internal).send({ ...applyBody, maxCosts: 2 });
    expect(first.status).toBe(200);
    expect(first.body.repricedCostCount).toBe(2);
    expect(first.body.remainingCostCount).toBe(1);
    const second = await request(app).post("/internal/cost-reprices/apply").set(internal).send(applyBody);
    expect(second.body.repricedCostCount).toBe(1);
    expect(second.body.remainingCostCount).toBe(0);

    // preview == apply set, totals add up to the preview's after
    const events = await db
      .select()
      .from(costLifecycleEvents)
      .where(and(eq(costLifecycleEvents.eventType, "cost.repriced")));
    const ours = events.filter((e) => preview.body.costs.some((c: any) => c.id === e.costId) || decoys.some((d) => d.id === e.costId));
    expect(ours.map((e) => e.costId).sort()).toEqual(preview.body.costs.map((c: any) => c.id).sort());
    const grossApplied = Number(first.body.grossAfterInUsdCents) + Number(second.body.grossAfterInUsdCents);
    expect(grossApplied.toFixed(10)).toBe(preview.body.grossAfterInUsdCents);

    const rows = await rowsById([...targets, ...decoys].map((r) => r.id));
    expect(rows.get(targets[0].id)!.unitCostInUsdCents).toBe(REAL);
    expect(rows.get(targets[0].id)!.totalCostInUsdCents).toBe(REAL);
    expect(rows.get(targets[0].id)!.netCostInUsdCents).toBe(REAL);
    expect(rows.get(targets[2].id)!.totalCostInUsdCents).toBe("0.3300000000");
    expect(rows.get(targets[2].id)!.netCostInUsdCents).toBe("0.2640000000");
    for (const d of decoys) {
      const r = rows.get(d.id)!;
      expect(r.unitCostInUsdCents).toBe(d.unitCostInUsdCents);
      expect(r.totalCostInUsdCents).toBe(d.totalCostInUsdCents);
      expect(r.status).toBe(d.status);
    }

    // history: the old price stays in the append-only audit
    const ev = ours.find((e) => e.costId === targets[2].id)!;
    expect(ev.payload).toMatchObject({
      fromUnitCostInUsdCents: FROZEN,
      newUnitCostInUsdCents: REAL,
      fromTotalCostInUsdCents: "2.3847240000",
      newTotalCostInUsdCents: "0.3300000000",
      fromNetCostInUsdCents: "1.9077792000",
      newNetCostInUsdCents: "0.2640000000",
      reason: applyBody.reason,
      repricedBy: applyBody.repricedBy,
    });

    // rollups follow: org usage total (O(1) rollup) drops by the gross delta, the
    // other org does not move, and the org stats read agrees with the rows
    const usageAfter = await request(app).get("/internal/org-usage-total").set(internal).query({ org_id: ORG_ID });
    const otherUsageAfter = await request(app).get("/internal/org-usage-total").set(internal).query({ org_id: OTHER_ORG_ID });
    expect(otherUsageAfter.body.spent_cents).toBe(otherUsageBefore.body.spent_cents);
    expect(otherUsageAfter.body.net_spent_cents).toBe(otherUsageBefore.body.net_spent_cents);
    const drop = Number(usageBefore.body.spent_cents) - Number(usageAfter.body.spent_cents);
    expect(drop.toFixed(10)).toBe((4.769448 - 0.66).toFixed(10));

    const live = (await rawSql`
      SELECT COALESCE(SUM(total_cost_in_usd_cents), 0)::numeric(16,10)::text AS g
        FROM runs_costs WHERE organization_id = ${ORG_ID} AND cost_name = ${COST} AND status = 'actual'
    `) as any[];
    const rolled = (await rawSql`
      SELECT COALESCE(SUM(gross_actual), 0)::numeric(16,10)::text AS g
        FROM stats_rollup_cost_name_day WHERE organization_id = ${ORG_ID} AND cost_name = ${COST}
    `) as any[];
    // 0.66 re-priced + the three decoys of our org still at their own price (other
    // price 0.195567, before the window 1.192362, BYOK 1.192362)
    expect(live[0].g).toBe("3.2402910000");
    expect(rolled[0].g).toBe(live[0].g);
    const consumption = (await rawSql`
      SELECT COALESCE(SUM(billed), 0)::numeric(16,10)::text AS g
        FROM stats_rollup_consumption_day WHERE organization_id = ${ORG_ID} AND cost_name = ${COST} AND cost_source = 'platform'
    `) as any[];
    expect(consumption[0].g).toBe("2.0479290000"); // platform only: BYOK row excluded

    const stats = await request(app).get("/v1/stats/costs").set(auth).query({ groupBy: "serviceName" });
    expect(stats.status).toBe(200);
  });

  it("re-apply moves nothing", async () => {
    const { targets } = await seed();
    await request(app).post("/internal/cost-reprices/apply").set(internal).send(applyBody);
    const before = await rowsById(targets.map((t) => t.id));
    const again = await request(app).post("/internal/cost-reprices/apply").set(internal).send(applyBody);
    expect(again.status).toBe(200);
    expect(again.body.repricedCostCount).toBe(0);
    expect(again.body.remainingCostCount).toBe(0);
    expect(again.body.grossAfterInUsdCents).toBe("0.0000000000");
    const after = await rowsById(targets.map((t) => t.id));
    for (const t of targets) expect(after.get(t.id)).toEqual(before.get(t.id));
    const preview = await request(app).post("/internal/cost-reprices/preview").set(internal).send(filter);
    expect(preview.body.costCount).toBe(0);
  });

  it("a replayed cost.repriced event moves nothing (projection guard on the old price)", async () => {
    const { targets } = await seed();
    await request(app).post("/internal/cost-reprices/apply").set(internal).send(applyBody);
    const [ev] = await db.select().from(costLifecycleEvents).where(and(eq(costLifecycleEvents.eventType, "cost.repriced"), eq(costLifecycleEvents.costId, targets[0].id)));
    await db.insert(costLifecycleEvents).values({
      runId: ev.runId,
      costId: ev.costId,
      eventType: "cost.repriced",
      payload: { ...(ev.payload as any), newUnitCostInUsdCents: "9.0000000000", newTotalCostInUsdCents: "9.0000000000", newNetCostInUsdCents: "9.0000000000" },
    });
    const [row] = await db.select().from(runsCosts).where(eq(runsCosts.id, targets[0].id));
    expect(row.totalCostInUsdCents).toBe(REAL);
  });

  it("stales the stored outcome-ledger days a re-price moved, from the row's run start", async () => {
    await seed();
    // Only facts recorded after t0 (other files' facts on these dates must not count).
    const t0 = new Date();
    const computedAt = new Date(t0.getTime() - 1);
    const computed = new Map([
      ["2026-10-19", computedAt],
      ["2026-10-20", computedAt],
      ["2026-10-22", computedAt],
    ]);
    expect((await staleComputedDays(computed, t0)).has("2026-10-20")).toBe(false);
    await request(app).post("/internal/cost-reprices/apply").set(internal).send(applyBody);
    const stale = await staleComputedDays(computed, t0);
    expect(stale.has("2026-10-20")).toBe(true);
    expect(stale.has("2026-10-22")).toBe(true);
    expect(stale.has("2026-10-19")).toBe(false);
  });

  // REPRICE-LOCK-1107: one 1000-row transaction held shared rollup rows (org totals,
  // ancestors' subtree costs, campaign/day rollups) ~2 min in prod, and every other
  // service's cost/run write on the same org queued behind it.
  describe("short transactions (REPRICE-LOCK-1107)", () => {
    const N = REPRICE_APPLY_TX_COSTS * 2 + 5; // two full chunks + a partial one

    async function seedMany() {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "postmark-service", taskName: "email-send", startedAt: new Date("2026-10-20T10:00:00Z") });
      const ids: string[] = [];
      for (let i = 0; i < N; i++) {
        const c = await insertTestRunCost({
          runId: run.id, costName: COST, quantity: "1", unitCostInUsdCents: FROZEN, totalCostInUsdCents: FROZEN, netCostInUsdCents: FROZEN,
          status: "actual", createdAt: new Date(Date.UTC(2026, 9, 20, 10, 0, i)),
        });
        ids.push(c.id);
      }
      // An UNRELATED run of the same org: its cost writes share only the org-level
      // rollup rows with the re-price (org_actual_totals, org day rollups).
      const other = await insertTestRun({ organizationId: ORG_ID, serviceName: "crm-service", taskName: "posthog-sync", startedAt: new Date("2026-10-20T11:00:00Z") });
      await insertTestRunCost({ runId: other.id, costName: "posthog-sync", quantity: "1", unitCostInUsdCents: "0.5", totalCostInUsdCents: "0.5", netCostInUsdCents: "0.5", status: "actual" });
      return { ids, otherRunId: other.id };
    }

    /** A live writer's cost insert on the unrelated run, allowed to wait at most 500 ms. */
    async function concurrentWrite(otherRunId: string): Promise<"ok" | "blocked"> {
      try {
        await rawSql.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '500ms'`;
          await tx`
            INSERT INTO runs_costs (run_id, cost_name, quantity, unit_cost_in_usd_cents, total_cost_in_usd_cents, net_cost_in_usd_cents, status, cost_source, organization_id, run_started_at)
            VALUES (${otherRunId}, 'posthog-sync', 1, 0.5, 0.5, 0.5, 'actual', 'platform', ${ORG_ID}, '2026-10-20T11:00:00Z')`;
        });
        return "ok";
      } catch (err: any) {
        if (err.code === "55P03") return "blocked";
        throw err;
      }
    }

    afterAll(() => setRepriceTestHookForTests(null));

    it("re-prices in transactions of at most REPRICE_APPLY_TX_COSTS rows, and an unrelated write of the same org never waits between them", async () => {
      const { ids, otherRunId } = await seedMany();
      const seen: Record<string, "ok" | "blocked"> = {};
      setRepriceTestHookForTests(async (phase, i) => {
        if (i === 0) seen[phase] = await concurrentWrite(otherRunId);
      });
      const res = await request(app).post("/internal/cost-reprices/apply").set(internal).send(applyBody);
      setRepriceTestHookForTests(null);
      expect(res.status).toBe(200);
      expect(res.body.repricedCostCount).toBe(N);
      expect(res.body.remainingCostCount).toBe(0);
      expect(res.body.transactionCount).toBe(3);
      expect(res.body.maxTransactionMs).toBeGreaterThanOrEqual(0);
      // The probe is sensitive: while a chunk is open, the org rollup row is locked
      // (the old single transaction held it for the WHOLE call) ...
      expect(seen.written).toBe("blocked");
      // ... and once the chunk commits, the same write goes straight through.
      expect(seen.committed).toBe("ok");

      // exactly one event per row, every row at the new price
      const events = await db.select().from(costLifecycleEvents).where(and(eq(costLifecycleEvents.eventType, "cost.repriced"), inArray(costLifecycleEvents.costId, ids)));
      expect(events.length).toBe(N);
      const rows = await rowsById(ids);
      for (const id of ids) expect(rows.get(id)!.totalCostInUsdCents).toBe(REAL);
      expect(res.body.grossAfterInUsdCents).toBe((0.165 * N).toFixed(10));
    });

    it("a call cut mid-way keeps its committed chunks, rolls back the open one, and a re-call resumes without moving any row twice", async () => {
      const { ids } = await seedMany();
      setRepriceTestHookForTests(async (phase, i) => {
        if (phase === "written" && i === 1) throw new Error("simulated deploy cut");
      });
      const cut = await request(app).post("/internal/cost-reprices/apply").set(internal).send(applyBody);
      setRepriceTestHookForTests(null);
      expect(cut.status).toBe(500);
      const mid = await request(app).post("/internal/cost-reprices/preview").set(internal).send(filter);
      expect(mid.body.costCount).toBe(N - REPRICE_APPLY_TX_COSTS); // chunk 0 committed, chunk 1 rolled back

      const resumed = await request(app).post("/internal/cost-reprices/apply").set(internal).send(applyBody);
      expect(resumed.status).toBe(200);
      expect(resumed.body.repricedCostCount).toBe(N - REPRICE_APPLY_TX_COSTS);
      expect(resumed.body.remainingCostCount).toBe(0);
      const events = await db.select().from(costLifecycleEvents).where(and(eq(costLifecycleEvents.eventType, "cost.repriced"), inArray(costLifecycleEvents.costId, ids)));
      expect(events.length).toBe(N);
      expect(new Set(events.map((e) => e.costId)).size).toBe(N);
    });

    it("a row re-priced by a concurrent call between pick and lock is skipped, never moved twice", async () => {
      const { ids } = await seedMany();
      // A parallel apply re-prices the whole set while this call is between chunks.
      let parallel: any = null;
      setRepriceTestHookForTests(async (phase, i) => {
        if (phase === "committed" && i === 0) {
          setRepriceTestHookForTests(null);
          parallel = await request(app).post("/internal/cost-reprices/apply").set(internal).send(applyBody);
        }
      });
      const res = await request(app).post("/internal/cost-reprices/apply").set(internal).send(applyBody);
      setRepriceTestHookForTests(null);
      expect(res.status).toBe(200);
      expect(parallel.body.repricedCostCount).toBe(N - REPRICE_APPLY_TX_COSTS);
      expect(res.body.repricedCostCount).toBe(REPRICE_APPLY_TX_COSTS);
      const events = await db.select().from(costLifecycleEvents).where(and(eq(costLifecycleEvents.eventType, "cost.repriced"), inArray(costLifecycleEvents.costId, ids)));
      expect(events.length).toBe(N);
    });
  });
});
