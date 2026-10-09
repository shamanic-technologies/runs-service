import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { eq } from "drizzle-orm";
import { db, sql as rawSql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { ORG_TASK_ROLLUP_NAME, rebuildOrgTaskRollup } from "../../src/services/stats-rollup-org-task.js";

// Migration 0043: the org usage read (GET /v1/stats/costs grouped by
// serviceName / taskName / campaignId, whole org) served from the (org, service,
// task, campaign, UTC day) rollup must answer byte-for-byte what the live query
// answers. Every case reads twice — stamp present, then absent — and compares
// the raw bodies.

const ORG = "0d43cccc-1111-4aaa-8aaa-111111111111";
const ORG2 = "0d43cccc-2222-4aaa-8aaa-222222222222";
const BRAND = randomUUID();
const C1 = randomUUID();
const C2 = randomUUID();
const C3 = randomUUID();

const app = createTestApp();

async function setReady(ready: boolean) {
  if (ready) {
    await rawSql`INSERT INTO stats_rollups (name, ready_at) VALUES (${ORG_TASK_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  } else {
    await rawSql`DELETE FROM stats_rollups WHERE name = ${ORG_TASK_ROLLUP_NAME}`;
  }
}

async function both(query: Record<string, string>, orgId = ORG) {
  const get = () => request(app).get("/v1/stats/costs").query(query).set(getAuthHeaders({ orgId }));
  await setReady(true);
  const fast = await get();
  await setReady(false);
  try {
    const live = await get();
    return { fast, live };
  } finally {
    await setReady(true);
  }
}

const TASKS: Array<[string, string]> = [
  ["workflow", "execute-workflow"],
  ["chat-service", "complete"],
  ["lead-service", "enrich"],
];

async function run(at: string, opts: { task?: number; campaignId?: string | null; orgId?: string } = {}) {
  const [serviceName, taskName] = TASKS[opts.task ?? 0];
  return insertTestRun({
    organizationId: opts.orgId ?? ORG,
    serviceName,
    taskName,
    brandIds: [BRAND],
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
  // Several days, three (service, task) pairs, two campaigns + no campaign,
  // every cost status, discounts, a group with runs but no cost row.
  const times = [
    "2026-10-01T00:00:00.000Z", "2026-10-01T23:59:59.999Z", "2026-10-02T04:00:00.000Z",
    "2026-10-02T04:00:00.500Z", "2026-10-03T12:15:00.000Z", "2026-10-04T23:59:59.000Z",
    "2026-10-05T00:00:00.000Z", "2026-10-06T18:10:00.000Z", "2026-10-07T19:00:01.000Z",
    "2026-10-08T06:30:00.000Z", "2026-10-08T07:30:00.000Z",
  ];
  for (const [i, t] of times.entries()) {
    const r = await run(t, { task: i % 3, campaignId: i % 4 === 0 ? C2 : i % 5 === 0 ? null : C1 });
    if (i % 2 === 0) await cost(r.id, String(i + 1), "6", { discountPct: i % 4 === 0 ? "0.1" : undefined });
    if (i % 3 === 0) await cost(r.id, "2", "5", { status: "provisioned" });
    if (i === 5) await cost(r.id, "1", "7", { status: "cancelled" });
  }
  // Runs, no cost: '0' money, still a group.
  await run("2026-10-02T10:00:00.000Z", { task: 2, campaignId: C2 });
  await run("2026-10-03T12:20:00.000Z", { orgId: ORG2 });

  // A run removed from its day: that day's min/max goes stale (the group keeps
  // its 12:30 run, so the rollup's 12:40 max would be wrong if served).
  await run("2026-10-03T12:30:00.000Z", { task: 1, campaignId: C3 });
  const gone = await run("2026-10-03T12:40:00.000Z", { task: 1, campaignId: C3 });
  await cost(gone.id, "9", "6");
  await db.delete(runs).where(eq(runs.id, gone.id));
  // A run moved to another campaign with its cost.
  const m = await run("2026-10-04T08:05:00.000Z");
  await cost(m.id, "3", "6");
  await db.update(runs).set({ campaignId: C2 }).where(eq(runs.id, m.id));
  // A run moved to another org (what transfer-brand does) with its cost.
  const o = await run("2026-10-04T09:05:00.000Z", { task: 2 });
  await cost(o.id, "5", "6");
  await db.update(runs).set({ organizationId: ORG2 }).where(eq(runs.id, o.id));
  // A cost refunded after the fact.
  const rv = await run("2026-10-05T09:00:00.000Z");
  const c = await cost(rv.id, "4", "6");
  await db.update(runsCosts).set({ status: "refunded" }).where(eq(runsCosts.id, c.id));
});

afterAll(async () => {
  await cleanTestData([ORG, ORG2]);
  await closeDb();
});

const cases: Array<[string, Record<string, string>]> = [
  ["org usage (features-service GET /orgs/usage)", { groupBy: "serviceName,taskName,campaignId" }],
  ["service + task", { groupBy: "serviceName,taskName" }],
  ["task only", { groupBy: "taskName" }],
  ["service, filtered by task", { groupBy: "serviceName", taskName: "complete" }],
  ["campaign, filtered by service", { groupBy: "campaignId", serviceName: "workflow" }],
  ["campaign family", { groupBy: "serviceName,campaignId", campaignIds: `${C1},${C2}` }],
  ["one campaign", { groupBy: "taskName,campaignId", campaignId: C2 }],
];

describe("GET /v1/stats/costs from the org-task rollup", () => {
  for (const [name, query] of cases) {
    it(`identical to the live query: ${name}`, async () => {
      const { fast, live } = await both(query);
      expect(fast.status).toBe(200);
      expect(live.status).toBe(200);
      expect(fast.text).toBe(live.text);
      expect(fast.body.groups.length).toBeGreaterThan(0);
    });
  }

  it("another org sees only its own runs (incl. the one moved in)", async () => {
    const { fast, live } = await both({ groupBy: "serviceName,taskName,campaignId" }, ORG2);
    expect(fast.text).toBe(live.text);
    expect(fast.body.groups).toHaveLength(2);
  });

  it("a bound or a filter the rollup does not carry keeps the live query", async () => {
    for (const q of [
      { groupBy: "serviceName,taskName,campaignId", startedAfter: "2026-10-03T00:00:00.000Z" },
      { groupBy: "serviceName,taskName", brandId: BRAND },
      { groupBy: "serviceName,taskName", featureSlug: "nope" },
    ]) {
      const { fast, live } = await both(q);
      expect(fast.text).toBe(live.text);
    }
  });

  it("a rebuild from the ledger lands on the same bytes and clears stale min/max", async () => {
    const q = { groupBy: "serviceName,taskName,campaignId" };
    await setReady(false);
    const live = await request(app).get("/v1/stats/costs").query(q).set(getAuthHeaders({ orgId: ORG }));
    await rebuildOrgTaskRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    const stale = await rawSql`SELECT count(*)::int AS n FROM stats_rollup_org_task WHERE minmax_stale`;
    expect(stale[0].n).toBe(0);
    const after = await request(app).get("/v1/stats/costs").query(q).set(getAuthHeaders({ orgId: ORG }));
    expect(after.text).toBe(live.text);
  });

  it("serves from the rollup: a group present only in the rollup shows up when stamped", async () => {
    // Proves the fast path is really taken (not silently falling back to live).
    await rawSql`
      INSERT INTO stats_rollup_org_task (organization_id, service_name, task_name, campaign_id, day, run_count, min_started_at, max_started_at)
      VALUES (${ORG}, 'ghost-service', 'ghost-task', NULL, '2026-01-01', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`;
    try {
      const { fast, live } = await both({ groupBy: "serviceName" });
      expect(fast.body.groups.map((g: any) => g.dimensions.serviceName)).toContain("ghost-service");
      expect(live.body.groups.map((g: any) => g.dimensions.serviceName)).not.toContain("ghost-service");
    } finally {
      await rawSql`DELETE FROM stats_rollup_org_task WHERE service_name = 'ghost-service'`;
    }
  });
});
