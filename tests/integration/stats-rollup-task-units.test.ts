import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { eq } from "drizzle-orm";
import { db, sql as rawSql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { TASK_UNITS_ROLLUP_NAME, rebuildTaskUnitsRollup } from "../../src/services/stats-rollup-task-units.js";

// Migration 0049: the (run-start day, org, service, task, asking service, cost
// name, cost source) rollup of CHARGED cost rows must equal the same aggregate
// computed live from the ledger, through every write the triggers see, and the
// read must answer what the live join answers.

const ORG = "0d49aaaa-1111-4aaa-8aaa-111111111111";
const ORG2 = "0d49aaaa-2222-4aaa-8aaa-222222222222";
const SVC = "tu-test-chat";
const ASK_A = "tu-test-lead";
const ASK_B = "tu-test-reply";
const JEV = "tu-jev-1.13-tokens-input";
const JEV2 = "tu-jev-1.14-tokens-input";
const CREDIT = "tu-apollo-credit";

const app = createTestApp();
const internal = getInternalAuthHeaders();

const SERVICES = [SVC, ASK_A, ASK_B];

/** The rollup's grain computed LIVE from the ledger (same SELECT as the rebuild). */
async function ledgerGrain() {
  const rows = await rawSql`
    WITH per_run AS (
      SELECT run_id, cost_name, cost_source, count(*) AS n, SUM(quantity) AS quantity,
        SUM(total_cost_in_usd_cents) AS gross, SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) AS net
      FROM runs_costs WHERE status = 'actual' GROUP BY 1, 2, 3
    )
    SELECT (r.started_at AT TIME ZONE 'UTC')::date::text AS day, r.organization_id::text AS org, r.service_name, r.task_name,
      p.service_name AS parent, pr.cost_name, pr.cost_source,
      count(*)::text AS run_count, SUM(pr.n)::text AS n, (SUM(pr.quantity))::numeric::text AS q,
      SUM(pr.gross)::numeric::text AS g, SUM(pr.net)::numeric::text AS net
    FROM per_run pr JOIN runs r ON r.id = pr.run_id LEFT JOIN runs p ON p.id = r.parent_run_id
    WHERE r.service_name = ANY(${SERVICES})
    GROUP BY 1, 2, 3, 4, 5, 6, 7
  `;
  return normalize(rows);
}

async function rollupGrain() {
  const rows = await rawSql`
    SELECT day::text AS day, organization_id::text AS org, service_name, task_name, parent_service_name AS parent,
      cost_name, cost_source, run_count::text, n_actual::text AS n, quantity::text AS q, gross_actual::text AS g, net_actual::text AS net
    FROM stats_rollup_task_units
    WHERE service_name = ANY(${SERVICES}) AND (n_actual <> 0 OR run_count <> 0)
  `;
  return normalize(rows);
}

function normalize(rows: any[]) {
  return rows
    .map((r) => ({
      key: [r.day, r.org, r.service_name, r.task_name, r.parent, r.cost_name, r.cost_source].join("|"),
      run_count: r.run_count,
      n: r.n,
      q: new Decimal(r.q).toFixed(10),
      g: new Decimal(r.g).toFixed(10),
      net: new Decimal(r.net).toFixed(10),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

async function expectParity() {
  expect(await rollupGrain()).toEqual(await ledgerGrain());
}

async function parent(service: string, orgId: string | null = ORG) {
  return insertTestRun({ organizationId: orgId, serviceName: service, taskName: "work" });
}

async function judgment(opts: { parentRunId?: string; task?: string; orgId?: string | null; startedAt?: string } = {}) {
  return insertTestRun({
    organizationId: opts.orgId === undefined ? ORG : opts.orgId,
    serviceName: SVC,
    taskName: opts.task ?? "judgments",
    ...(opts.parentRunId && { parentRunId: opts.parentRunId }),
    startedAt: new Date(opts.startedAt ?? "2026-09-20T10:00:00Z"),
  });
}

async function cost(runId: string, qty: string, opts: { name?: string; status?: string; source?: string; discountPct?: string } = {}) {
  const unit = "0.0001";
  const gross = new Decimal(qty).times(unit);
  return insertTestRunCost({
    runId,
    costName: opts.name ?? JEV,
    costSource: opts.source ?? "platform",
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

/** The read's figures for the typed-judgment shape, computed live with the join the read replaces. */
async function liveJudgments() {
  const rows = await rawSql`
    SELECT to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month, r.task_name, p.service_name AS parent,
      count(DISTINCT r.id)::int AS runs, count(DISTINCT r.organization_id)::int AS orgs, count(*)::int AS n,
      SUM(c.quantity)::text AS q, SUM(c.total_cost_in_usd_cents)::text AS g,
      SUM(COALESCE(c.net_cost_in_usd_cents, c.total_cost_in_usd_cents))::text AS net,
      GROUPING(to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM'), r.task_name, p.service_name) <> 0 AS is_total
    FROM runs r
    JOIN runs_costs c ON c.run_id = r.id AND c.status = 'actual' AND c.cost_name LIKE 'tu-jev-%'
    LEFT JOIN runs p ON p.id = r.parent_run_id
    WHERE r.service_name = ${SVC} AND r.task_name IN ('judgments', 'platform-judgments')
    GROUP BY GROUPING SETS ((1, 2, 3), ())
  `;
  const fig = (r: any) => ({
    runCount: r.runs,
    orgCount: r.orgs,
    costRowCount: r.n,
    quantity: new Decimal(r.q).toFixed(6),
    billedCostInUsdCents: new Decimal(r.g).toFixed(10),
    netBilledCostInUsdCents: new Decimal(r.net).toFixed(10),
  });
  const groups = rows
    .filter((r: any) => !r.is_total)
    .map((r: any) => ({ month: r.month, taskName: r.task_name, parentServiceName: r.parent, ...fig(r) }))
    .sort((a: any, b: any) =>
      [a.month, a.taskName, a.parentServiceName ?? "￿"].join("|") < [b.month, b.taskName, b.parentServiceName ?? "￿"].join("|") ? -1 : 1,
    );
  const total = rows.find((r: any) => r.is_total);
  return { groups, total: total ? fig(total) : null };
}

const judgmentsQuery = {
  serviceName: SVC,
  taskNames: "judgments,platform-judgments",
  costNamePrefix: "tu-jev-",
  groupBy: "month,taskName,parentServiceName",
};

describe("GET /internal/stats/costs/task-units (migration 0049 rollup)", () => {
  beforeAll(async () => {
    await cleanTestData([ORG, ORG2, null]);
    await rawSql`INSERT INTO stats_rollups (name, ready_at) VALUES (${TASK_UNITS_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  });
  afterAll(async () => {
    await cleanTestData([ORG, ORG2, null]);
    await closeDb();
  });

  it("stays equal to the ledger through inserts, transitions, deletes, moves and a rebuild, and the read equals the live join", async () => {
    const a = await parent(ASK_A);
    const b = await parent(ASK_B, ORG2);

    // Two judgments asked by A in Sep, one with two charged rows (counts once).
    const j1 = await judgment({ parentRunId: a.id });
    await cost(j1.id, "1200");
    await cost(j1.id, "300", { discountPct: "0.2" });
    const j2 = await judgment({ parentRunId: a.id, startedAt: "2026-09-30T23:59:59Z" });
    await cost(j2.id, "800");
    // Asked by B (another org), in Oct; a cancelled and a provisioned row count nowhere.
    const j3 = await judgment({ parentRunId: b.id, orgId: ORG2, startedAt: "2026-10-01T00:00:00Z" });
    await cost(j3.id, "500");
    await cost(j3.id, "999", { status: "cancelled" });
    const held = await cost(j3.id, "700", { status: "provisioned" });
    // Platform route, root run, org-less.
    const p1 = await judgment({ task: "platform-judgments", orgId: null, startedAt: "2026-10-02T08:00:00Z" });
    await cost(p1.id, "400", { name: JEV2 });
    // Same run charged under another, non-matching cost name: not in the judgments read.
    await cost(p1.id, "3", { name: CREDIT });
    await expectParity();

    let res = await request(app).get("/internal/stats/costs/task-units").query(judgmentsQuery).set(internal);
    expect(res.status).toBe(200);
    let live = await liveJudgments();
    expect(res.body.groups).toEqual(live.groups);
    expect(res.body.total).toEqual(live.total);
    expect(res.body.total.runCount).toBe(4);
    expect(res.body.total.orgCount).toBe(2);

    // provisioned -> actual (the hold is charged), then a charged row cancelled.
    await db.update(runsCosts).set({ status: "actual" }).where(eq(runsCosts.id, held.id));
    const extra = await cost(j2.id, "50");
    await db.update(runsCosts).set({ status: "cancelled" }).where(eq(runsCosts.id, extra.id));
    await expectParity();

    // Delete one of j1's two rows: j1 still counts once; delete the other: j1 leaves.
    const j1Rows = await db.select().from(runsCosts).where(eq(runsCosts.runId, j1.id));
    await db.delete(runsCosts).where(eq(runsCosts.id, j1Rows[0].id));
    await expectParity();
    await db.delete(runsCosts).where(eq(runsCosts.id, j1Rows[1].id));
    await expectParity();
    await cost(j1.id, "100");

    // Org move (transfer-brand) and a run moved to another start day.
    await db.update(runs).set({ organizationId: ORG2 }).where(eq(runs.id, j2.id));
    await db.update(runs).set({ startedAt: new Date("2026-10-05T12:00:00Z") }).where(eq(runs.id, j3.id));
    await expectParity();

    // Run delete (its cost rows cascade).
    const gone = await judgment({ parentRunId: b.id, orgId: ORG2 });
    await cost(gone.id, "77");
    await db.delete(runs).where(eq(runs.id, gone.id));
    await expectParity();

    res = await request(app).get("/internal/stats/costs/task-units").query(judgmentsQuery).set(internal);
    live = await liveJudgments();
    expect(res.body.groups).toEqual(live.groups);
    expect(res.body.total).toEqual(live.total);

    // A rebuild from the ledger lands on the same table.
    const before = await rollupGrain();
    await rebuildTaskUnitsRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    expect(await rollupGrain()).toEqual(before);
    await expectParity();
  });

  it("counts a run once when many of its rows are charged concurrently, and drops it once all are removed concurrently", async () => {
    const j = await judgment({ startedAt: "2026-09-25T10:00:00Z" });
    const rows = await Promise.all(Array.from({ length: 20 }, (_, i) => cost(j.id, String(10 + i))));
    await expectParity();
    await Promise.all(rows.map((r) => db.delete(runsCosts).where(eq(runsCosts.id, r.id))));
    await expectParity();
    await db.delete(runs).where(eq(runs.id, j.id));
  });

  it("filters by cost name, source and since; serves the reveal-price shape", async () => {
    const e = await insertTestRun({ organizationId: ORG, serviceName: SVC, taskName: "enrichment", startedAt: new Date("2026-09-27T23:00:00Z") });
    await cost(e.id, "5", { name: CREDIT });
    const e2 = await insertTestRun({ organizationId: ORG, serviceName: SVC, taskName: "enrichment", startedAt: new Date("2026-09-28T01:00:00Z") });
    await cost(e2.id, "2", { name: CREDIT });
    await cost(e2.id, "1", { name: CREDIT });
    await cost(e2.id, "9", { name: CREDIT, source: "org" });

    const res = await request(app)
      .get("/internal/stats/costs/task-units")
      .query({ serviceName: SVC, taskNames: "enrichment", costNames: CREDIT, costSource: "platform", since: "2026-09-28" })
      .set(internal);
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
    expect(res.body.total).toEqual({
      runCount: 1,
      orgCount: 1,
      costRowCount: 2,
      quantity: "3.000000",
      billedCostInUsdCents: "0.0003000000",
      netBilledCostInUsdCents: "0.0003000000",
    });
  });

  it("validates its query and answers 503 until the rollup is built", async () => {
    const get = (q: Record<string, string>) => request(app).get("/internal/stats/costs/task-units").query(q).set(internal);
    expect((await get({})).status).toBe(400);
    expect((await get({ serviceName: SVC, groupBy: "orgId" })).status).toBe(400);
    expect((await get({ serviceName: SVC, costNames: "a", costNamePrefix: "b" })).status).toBe(400);
    expect((await get({ serviceName: SVC, since: "2026-9-1" })).status).toBe(400);
    expect((await get({ serviceName: SVC, costSource: "byok" })).status).toBe(400);
    expect((await request(app).get("/internal/stats/costs/task-units").query({ serviceName: SVC })).status).toBe(401);

    await rawSql`DELETE FROM stats_rollups WHERE name = ${TASK_UNITS_ROLLUP_NAME}`;
    try {
      expect((await get({ serviceName: SVC })).status).toBe(503);
    } finally {
      await rawSql`INSERT INTO stats_rollups (name, ready_at) VALUES (${TASK_UNITS_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
    }
  });
});
