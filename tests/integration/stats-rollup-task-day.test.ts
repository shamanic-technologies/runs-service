import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { eq } from "drizzle-orm";
import { db, sql as rawSql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { TASK_DAY_ROLLUP_NAME, rebuildTaskDayRollup } from "../../src/services/stats-rollup-task-day.js";

// Migration 0096 (SPEND-BY-ACTION-TIMEOUT-1106): GET /v1/stats/costs/timeseries
// split per (day, service, task) for an org + brand + feature slugs + campaign set,
// served from the task-day rollup, must answer byte-for-byte what the live query
// answers. Every case reads twice (stamp present, then absent) and compares raw
// bodies; and per day, the tasks sum to the unsplit day on every money field.

const ORG = "0d96cccc-1111-4aaa-8aaa-111111111111";
const ORG2 = "0d96cccc-2222-4aaa-8aaa-222222222222";
const BRAND = randomUUID();
const BRAND2 = randomUUID();
const C1 = randomUUID();
const C2 = randomUUID();
const C3 = randomUUID();
const FEATURES = "sales-cold-email-outreach,lead-sourcing";

const app = createTestApp();

const MONEY = [
  "totalCostInUsdCents",
  "actualCostInUsdCents",
  "provisionedCostInUsdCents",
  "cancelledCostInUsdCents",
  "refundedCostInUsdCents",
  "netTotalCostInUsdCents",
  "netActualCostInUsdCents",
  "netProvisionedCostInUsdCents",
  "netRefundedCostInUsdCents",
] as const;

async function setReady(ready: boolean) {
  if (ready) {
    await rawSql`INSERT INTO stats_rollups (name, ready_at) VALUES (${TASK_DAY_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  } else {
    await rawSql`DELETE FROM stats_rollups WHERE name = ${TASK_DAY_ROLLUP_NAME}`;
  }
}

const get = (query: Record<string, string>, orgId = ORG) =>
  request(app).get("/v1/stats/costs/timeseries").query(query).set(getAuthHeaders({ orgId }));

async function both(query: Record<string, string>, orgId = ORG) {
  await setReady(true);
  const fast = await get(query, orgId);
  await setReady(false);
  try {
    const live = await get(query, orgId);
    return { fast, live };
  } finally {
    await setReady(true);
  }
}

const TASKS: Array<[string, string, string]> = [
  ["lead-service", "lead-serve", "lead-sourcing"],
  ["instantly", "email-send-step-1", "sales-cold-email-outreach"],
  ["instantly", "email-send-step-2", "sales-cold-email-outreach"],
];

async function run(at: string, opts: { task?: number; campaignId?: string | null; orgId?: string; brands?: string[]; feature?: string } = {}) {
  const [serviceName, taskName, featureSlug] = TASKS[opts.task ?? 0];
  return insertTestRun({
    organizationId: opts.orgId ?? ORG,
    serviceName,
    taskName,
    featureSlug: opts.feature ?? featureSlug,
    brandIds: opts.brands ?? [BRAND],
    campaignId: opts.campaignId === null ? undefined : (opts.campaignId ?? C1),
    startedAt: new Date(at),
  });
}

async function cost(runId: string, qty: string, unit: string, opts: { status?: string; discountPct?: string } = {}) {
  const gross = new Decimal(qty).times(unit);
  return insertTestRunCost({
    runId,
    costName: "tok",
    quantity: qty,
    unitCostInUsdCents: unit,
    totalCostInUsdCents: gross.toFixed(10),
    ...(opts.discountPct && {
      netCostInUsdCents: gross.times(new Decimal(1).minus(opts.discountPct)).toFixed(10),
      usageDiscountPct: opts.discountPct,
    }),
    status: opts.status ?? "actual",
  });
}

beforeAll(async () => {
  await cleanTestData([ORG, ORG2]);
  await setReady(true);
  const times = [
    "2026-10-01T00:00:00.000Z", "2026-10-01T23:59:59.999Z", "2026-10-02T04:00:00.000Z",
    "2026-10-02T04:00:00.500Z", "2026-10-03T12:15:00.000Z", "2026-10-04T23:59:59.000Z",
    "2026-10-05T00:00:00.000Z", "2026-10-06T18:10:00.000Z", "2026-10-07T19:00:01.000Z",
    "2026-10-08T06:30:00.000Z", "2026-10-08T07:30:00.000Z", "2026-10-12T07:30:00.000Z",
  ];
  for (const [i, t] of times.entries()) {
    const r = await run(t, {
      task: i % 3,
      campaignId: i % 4 === 0 ? C2 : i % 5 === 0 ? null : C1,
      brands: i % 6 === 0 ? [BRAND2, BRAND] : [BRAND],
    });
    if (i % 2 === 0) await cost(r.id, String(i + 1), "6.1234567891", { discountPct: i % 4 === 0 ? "0.1" : undefined });
    if (i % 3 === 0) await cost(r.id, "2", "5", { status: "provisioned" });
    if (i === 5) await cost(r.id, "1", "7", { status: "cancelled" });
  }
  // Runs with no cost row: counted runs, not committed.
  await run("2026-10-02T10:00:00.000Z", { task: 2, campaignId: C2 });
  // Other brand / other feature / other org: filtered out.
  const ob = await run("2026-10-02T11:00:00.000Z", { brands: [BRAND2] });
  await cost(ob.id, "1", "100");
  const of = await run("2026-10-02T11:00:00.000Z", { feature: "other-feature" });
  await cost(of.id, "1", "100");
  await run("2026-10-03T12:20:00.000Z", { orgId: ORG2 });

  // Removed run: that day's min/max goes stale (read live).
  await run("2026-10-03T12:30:00.000Z", { task: 1, campaignId: C3 });
  const gone = await run("2026-10-03T12:40:00.000Z", { task: 1, campaignId: C3 });
  await cost(gone.id, "9", "6");
  await db.delete(runs).where(eq(runs.id, gone.id));
  // Moved to another campaign with its cost; brand set rewritten (transfer-brand).
  const m = await run("2026-10-04T08:05:00.000Z", { task: 2 });
  await cost(m.id, "3", "6");
  await db.update(runs).set({ campaignId: C2 }).where(eq(runs.id, m.id));
  const bt = await run("2026-10-04T08:10:00.000Z", { task: 1, brands: [BRAND2] });
  await cost(bt.id, "3", "6");
  await db.update(runs).set({ brandIds: [BRAND] }).where(eq(runs.id, bt.id));
  // Moved to another org with its cost.
  const o = await run("2026-10-04T09:05:00.000Z", { task: 2 });
  await cost(o.id, "5", "6");
  await db.update(runs).set({ organizationId: ORG2 }).where(eq(runs.id, o.id));
  // Status transitions: provisioned -> actual (stays committed), actual -> refunded
  // and provisioned -> cancelled (no longer committed), a deleted committed row.
  const p = await run("2026-10-05T09:00:00.000Z", { task: 1 });
  const pc = await cost(p.id, "4", "6", { status: "provisioned" });
  await db.update(runsCosts).set({ status: "actual" }).where(eq(runsCosts.id, pc.id));
  const rv = await run("2026-10-05T09:10:00.000Z", { task: 1 });
  const rc = await cost(rv.id, "4", "6");
  await db.update(runsCosts).set({ status: "refunded" }).where(eq(runsCosts.id, rc.id));
  const cx = await run("2026-10-05T09:20:00.000Z", { task: 2 });
  const cc = await cost(cx.id, "4", "6", { status: "provisioned" });
  await db.update(runsCosts).set({ status: "cancelled" }).where(eq(runsCosts.id, cc.id));
  const dl = await run("2026-10-05T09:30:00.000Z", { task: 2 });
  const d1 = await cost(dl.id, "1", "6");
  await cost(dl.id, "1", "6");
  await db.delete(runsCosts).where(eq(runsCosts.id, d1.id));
  const dz = await run("2026-10-05T09:40:00.000Z", { task: 2 });
  const dz1 = await cost(dz.id, "1", "6");
  await db.delete(runsCosts).where(eq(runsCosts.id, dz1.id));
});

afterAll(async () => {
  await cleanTestData([ORG, ORG2]);
  await setReady(true);
  await closeDb();
});

const base = { brandId: BRAND, featureSlugs: FEATURES };
const cases: Array<[string, Record<string, string>]> = [
  ["spend by action, campaign set (features-service)", { ...base, interval: "day", groupBy: "serviceName,taskName", campaignIds: `${C1},${C2},${C3}` }],
  ["spend by action, one campaign", { ...base, interval: "day", groupBy: "serviceName,taskName", campaignIds: C1 }],
  ["spend by action, whole brand", { ...base, groupBy: "serviceName,taskName" }],
  ["by campaign and task", { ...base, groupBy: "campaignId,taskName", campaignIds: `${C1},${C2}` }],
  ["by week", { ...base, interval: "week", groupBy: "serviceName,taskName" }],
  ["by month, no brand", { featureSlugs: FEATURES, interval: "month", groupBy: "serviceName,taskName" }],
  ["unsplit day, feature filtered", { ...base, campaignIds: `${C1},${C2},${C3}` }],
  ["task filter", { ...base, groupBy: "serviceName", taskName: "email-send-step-2" }],
  ["single feature slug", { brandId: BRAND, featureSlug: "lead-sourcing", groupBy: "serviceName,taskName" }],
];

describe("GET /v1/stats/costs/timeseries from the task-day rollup", () => {
  for (const [name, query] of cases) {
    it(`identical to the live query: ${name}`, async () => {
      const { fast, live } = await both(query);
      expect(fast.status).toBe(200);
      expect(live.status).toBe(200);
      expect(fast.text).toBe(live.text);
      expect(fast.body.buckets.length).toBeGreaterThan(0);
    });
  }

  it("per day, the tasks sum to the unsplit day on every money field and run count", async () => {
    const scope = { ...base, campaignIds: `${C1},${C2},${C3}` };
    const [split, whole] = await Promise.all([get({ ...scope, groupBy: "serviceName,taskName" }), get(scope)]);
    expect(whole.body.buckets.length).toBeGreaterThan(3);
    for (const day of whole.body.buckets) {
      const parts = split.body.buckets.filter((b: any) => b.period === day.period);
      for (const f of MONEY) {
        const sum = parts.reduce((acc: Decimal, b: any) => acc.plus(b[f]), new Decimal(0));
        expect(sum.toFixed(10), `${day.period} ${f}`).toBe(day[f]);
      }
      expect(parts.reduce((n: number, b: any) => n + b.runCount, 0)).toBe(day.runCount);
    }
  });

  it("committed runs: refunded, cancelled and cost-less runs are not actions", async () => {
    const res = await get({ ...base, groupBy: "serviceName,taskName", campaignIds: C1 });
    const oct5 = res.body.buckets.filter((b: any) => b.period === "2026-10-05");
    const byTask = Object.fromEntries(oct5.map((b: any) => [b.taskName, [b.runCount, b.committedRunCount]]));
    // step-1: p (provisioned -> actual) committed, rv (refunded) not.
    expect(byTask["email-send-step-1"]).toEqual([2, 1]);
    // step-2: cx cancelled not, dl (one committed row left) yes, dz (row deleted) not.
    expect(byTask["email-send-step-2"]).toEqual([3, 1]);
  });

  it("another org sees only its own runs (incl. the one moved in)", async () => {
    const { fast, live } = await both({ groupBy: "serviceName,taskName" }, ORG2);
    expect(fast.text).toBe(live.text);
    expect(fast.body.buckets).toHaveLength(2);
  });

  it("concurrent first committed rows of one run count it once", async () => {
    const r = await run("2026-10-20T10:00:00.000Z", { task: 1 });
    await Promise.all(Array.from({ length: 20 }, () => cost(r.id, "1", "1")));
    const rows = await rawSql`
      SELECT committed_run_count::int AS c FROM stats_rollup_task_day
      WHERE organization_id = ${ORG} AND day = '2026-10-20' AND task_name = 'email-send-step-1'`;
    expect(rows.map((x: any) => x.c)).toEqual([1]);
    const ids = (await rawSql`SELECT id FROM runs_costs WHERE run_id = ${r.id}`).map((x: any) => x.id);
    await Promise.all(ids.map((id: string) => db.delete(runsCosts).where(eq(runsCosts.id, id))));
    const after = await rawSql`
      SELECT committed_run_count::int AS c FROM stats_rollup_task_day
      WHERE organization_id = ${ORG} AND day = '2026-10-20' AND task_name = 'email-send-step-1'`;
    expect(after.map((x: any) => x.c)).toEqual([0]);
    await db.delete(runs).where(eq(runs.id, r.id));
  });

  it("a bound, a workflow filter or another timezone keeps the live query", async () => {
    for (const q of [
      { ...base, groupBy: "serviceName,taskName", startedAfter: "2026-10-03T00:00:00.000Z" },
      { ...base, groupBy: "serviceName,taskName", workflowSlug: "nope" },
      { ...base, groupBy: "serviceName,taskName", tz: "Europe/Paris" },
    ]) {
      const { fast, live } = await both(q);
      expect(fast.text).toBe(live.text);
    }
  });

  it("a rebuild from the ledger lands on the same bytes and clears stale min/max", async () => {
    const q = { ...base, groupBy: "serviceName,taskName" };
    await setReady(false);
    const live = await get(q);
    await rebuildTaskDayRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    const stale = await rawSql`SELECT count(*)::int AS n FROM stats_rollup_task_day WHERE minmax_stale`;
    expect(stale[0].n).toBe(0);
    const after = await get(q);
    expect(after.text).toBe(live.text);
  });

  it("serves from the rollup: a row present only in the rollup shows up when stamped", async () => {
    await rawSql`
      INSERT INTO stats_rollup_task_day (organization_id, campaign_id, feature_slug, service_name, task_name, day, brand_ids, run_count, min_started_at, max_started_at)
      VALUES (${ORG}, NULL, 'lead-sourcing', 'ghost-service', 'ghost-task', '2026-01-01', ARRAY[${BRAND}]::text[], 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`;
    try {
      const { fast, live } = await both({ ...base, groupBy: "serviceName" });
      expect(fast.body.buckets.map((b: any) => b.serviceName)).toContain("ghost-service");
      expect(live.body.buckets.map((b: any) => b.serviceName)).not.toContain("ghost-service");
    } finally {
      await rawSql`DELETE FROM stats_rollup_task_day WHERE service_name = 'ghost-service'`;
    }
  });
});
