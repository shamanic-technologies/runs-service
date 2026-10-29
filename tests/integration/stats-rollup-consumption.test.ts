import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db, sql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";
import { CONSUMPTION_DAY_ROLLUP_NAME, rebuildConsumptionDayRollup } from "../../src/services/stats-rollup-consumption-day.js";

// GET /internal/stats/costs/consumption (costs-service's daily real-cost refresh,
// groupBy=orgId and groupBy=orgId,brandId since inception) live scanned every
// counted cost row and, by brand, the whole runs table: past the 30 s stats
// timeout in prod, every refresh 500'd from 2026-10-16 to 2026-10-29. Migration
// 0090 serves it from a write-maintained rollup. The rollup must answer EXACTLY as
// the live query, through inserts, status moves, org/brand moves, deletes and
// rebuilds. Each comparison runs the same request with the rollup stamped and not.

const ORG_A = "7a900000-1111-4aaa-8aaa-111111111111";
const ORG_B = "7a900000-2222-4aaa-8aaa-222222222222";
const SUFFIX = randomUUID().slice(0, 8);
const N1 = `cons-rollup-apollo-${SUFFIX}`;
const N2 = `cons-rollup-serper-${SUFFIX}`;
const NAMES = `${N1},${N2}`;
const BRAND_1 = `cons-brand-1-${SUFFIX}`;
const BRAND_2 = `cons-brand-2-${SUFFIX}`;
const BRAND_3 = `cons-brand-3-${SUFFIX}`;
const PATH = "/internal/stats/costs/consumption";
const API_KEY = { "x-api-key": "test-api-key" };

const app = createTestApp();

async function stamp(ready: boolean) {
  if (ready) {
    await sql`INSERT INTO stats_rollups (name, ready_at) VALUES (${CONSUMPTION_DAY_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  } else {
    await sql`DELETE FROM stats_rollups WHERE name = ${CONSUMPTION_DAY_ROLLUP_NAME}`;
  }
}

async function get(query: Record<string, string>) {
  const res = await request(app).get(PATH).set(API_KEY).query({ costNames: NAMES, ...query });
  expect(res.status).toBe(200);
  return res.body;
}

const QUERIES: Record<string, string>[] = [
  {},
  { groupBy: "orgId" },
  { groupBy: "orgId,brandId" },
  { groupBy: "brandId" },
  { groupBy: "orgId", since: "2026-01-11" },
  { groupBy: "orgId,brandId", orgId: ORG_A },
  { groupBy: "orgId,brandId", brandId: BRAND_1 },
  { brandId: BRAND_2 },
  { orgId: ORG_B },
];

async function expectParity(opts: { nonEmpty?: boolean } = {}) {
  for (const q of QUERIES) {
    await stamp(true);
    const rolled = await get(q);
    await stamp(false);
    const live = await get(q);
    await stamp(true);
    expect(rolled).toEqual(live);
  }
  if (opts.nonEmpty !== false) {
    const live = await get({ groupBy: "orgId,brandId" });
    expect(live.days.length).toBeGreaterThan(0);
  }
}

async function cost(runId: string, costName: string, qty: string, createdAt: string, opts: { status?: string; costSource?: string; discounted?: boolean } = {}) {
  const gross = new Decimal(qty).times(2);
  return insertTestRunCost({
    runId,
    costName,
    quantity: qty,
    unitCostInUsdCents: "2",
    totalCostInUsdCents: gross.toFixed(10),
    ...(opts.discounted && { netCostInUsdCents: gross.times("0.9").toFixed(10), usageDiscountPct: "0.1" }),
    status: opts.status ?? "actual",
    costSource: opts.costSource ?? "platform",
    createdAt: new Date(createdAt),
  });
}

describe("consumption read from the consumption_day rollup (migration 0090)", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await cleanTestData([ORG_A, ORG_B]);
    await stamp(true);
    const a = await insertTestRun({ organizationId: ORG_A, serviceName: "svc", taskName: "t", status: "completed", brandIds: [BRAND_1, BRAND_2] });
    const a2 = await insertTestRun({ organizationId: ORG_A, serviceName: "svc", taskName: "t", status: "completed", brandIds: [BRAND_1] });
    const b = await insertTestRun({ organizationId: ORG_B, serviceName: "svc", taskName: "t", status: "completed" });
    const e = await insertTestRun({ organizationId: ORG_B, serviceName: "svc", taskName: "t", status: "completed", brandIds: [] });
    Object.assign(ids, { a: a.id, a2: a2.id, b: b.id, e: e.id });
    ids.k1 = (await cost(a.id, N1, "3", "2026-01-10T10:00:00Z", { discounted: true })).id;
    ids.k2 = (await cost(a2.id, N1, "1.5", "2026-01-10T12:00:00Z")).id;
    ids.k3 = (await cost(b.id, N1, "2.5", "2026-01-10T23:59:59Z")).id;
    ids.k4 = (await cost(a.id, N1, "1", "2026-01-11T00:00:00Z", { status: "refunded" })).id;
    ids.k5 = (await cost(a.id, N1, "7", "2026-01-11T00:00:00Z", { status: "provisioned" })).id;
    ids.k6 = (await cost(a.id, N1, "9", "2026-01-11T00:00:00Z", { status: "cancelled" })).id;
    ids.k7 = (await cost(a.id, N1, "4", "2026-01-11T05:00:00Z", { costSource: "org" })).id;
    ids.k8 = (await cost(b.id, N2, "10", "2026-02-01T00:00:00Z", { costSource: "org" })).id;
    ids.k9 = (await cost(e.id, N2, "0.25", "2026-02-01T08:00:00Z")).id;
  });

  afterAll(async () => {
    await cleanTestData([ORG_A, ORG_B]);
    await closeDb();
  });

  it("is served from the rollup once stamped (the 30 s live scan is never run)", async () => {
    await stamp(true);
    const before = await get({ groupBy: "orgId" });
    // Tamper with the stored group only: the response must follow it.
    await sql`UPDATE stats_rollup_consumption_day SET quantity = quantity + 1000 WHERE cost_name = ${N2} AND organization_id = ${ORG_B}::uuid AND cost_source = 'org'`;
    const after = await get({ groupBy: "orgId" });
    const q = (body: any) => body.totals.find((t: any) => t.costName === N2 && t.orgId === ORG_B && t.costSource === "org").quantity;
    expect(new Decimal(q(after)).minus(q(before)).toFixed(0)).toBe("1000");
    await sql`UPDATE stats_rollup_consumption_day SET quantity = quantity - 1000 WHERE cost_name = ${N2} AND organization_id = ${ORG_B}::uuid AND cost_source = 'org'`;
  });

  it("answers exactly as the live query after inserts", async () => {
    await expectParity();
  });

  it("follows status moves, amounts, renames, day and source moves", async () => {
    await db.update(runsCosts).set({ status: "actual" }).where(eq(runsCosts.id, ids.k5)); // hold actualized
    await db.update(runsCosts).set({ status: "refunded" }).where(eq(runsCosts.id, ids.k1)); // refunded later
    await db.update(runsCosts).set({ status: "cancelled" }).where(eq(runsCosts.id, ids.k2)); // leaves the set
    await db.update(runsCosts).set({ quantity: "9.5", totalCostInUsdCents: "19.0000000000" }).where(eq(runsCosts.id, ids.k3));
    await db.update(runsCosts).set({ costName: N2 }).where(eq(runsCosts.id, ids.k4));
    await db.update(runsCosts).set({ createdAt: new Date("2026-03-01T01:00:00Z") }).where(eq(runsCosts.id, ids.k7));
    await db.update(runsCosts).set({ costSource: "platform" }).where(eq(runsCosts.id, ids.k8));
    await db.update(runsCosts).set({ runId: ids.a2 }).where(eq(runsCosts.id, ids.k9)); // another run, another brand set
    await expectParity();
  });

  it("follows a brand transfer (run brands + cost org) and deletes", async () => {
    await db.update(runs).set({ brandIds: [BRAND_3, BRAND_2] }).where(eq(runs.id, ids.a));
    await db.update(runs).set({ organizationId: ORG_B }).where(eq(runs.id, ids.a2));
    await db.update(runsCosts).set({ organizationId: ORG_B }).where(eq(runsCosts.runId, ids.a2));
    await db.delete(runsCosts).where(eq(runsCosts.id, ids.k6));
    await db.delete(runsCosts).where(eq(runsCosts.id, ids.k3));
    await expectParity();
    await db.delete(runs).where(eq(runs.id, ids.b)); // cascade: its rows leave once
    await expectParity();
    const [{ n }] = await sql`SELECT COALESCE(SUM(n), 0)::int AS n FROM stats_rollup_consumption_day WHERE cost_name IN (${N1}, ${N2})`;
    const [{ live }] = await sql`SELECT count(*)::int AS live FROM runs_costs WHERE cost_name IN (${N1}, ${N2}) AND status IN ('actual', 'refunded')`;
    expect(n).toBe(live);
  });

  it("a rebuild reproduces the trigger-maintained groups and keeps parity", async () => {
    const snapshot = async () =>
      (await sql`SELECT organization_id, brand_ids, day, cost_name, cost_source, n, quantity::text, refunded_quantity::text,
          billed::text, net_billed::text, refunded::text, net_refunded::text
        FROM stats_rollup_consumption_day WHERE cost_name IN (${N1}, ${N2}) AND n <> 0
        ORDER BY 1, 2, 3, 4, 5`).map((r) => ({ ...r, quantity: new Decimal(r.quantity).toFixed(10), refunded_quantity: new Decimal(r.refunded_quantity).toFixed(10),
          billed: new Decimal(r.billed).toFixed(10), net_billed: new Decimal(r.net_billed).toFixed(10),
          refunded: new Decimal(r.refunded).toFixed(10), net_refunded: new Decimal(r.net_refunded).toFixed(10) }));
    const before = await snapshot();
    expect(before.length).toBeGreaterThan(0);
    await rebuildConsumptionDayRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    expect(await snapshot()).toEqual(before);
    await expectParity();
  });

  it("falls back to the live query while unstamped", async () => {
    await stamp(false);
    const body = await get({ groupBy: "orgId" });
    expect(body.days.length).toBeGreaterThan(0);
    await stamp(true);
  });
});
