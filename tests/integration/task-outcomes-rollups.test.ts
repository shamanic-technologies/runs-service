import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, sql as rawSql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { rebuildRootCostRollup, ROOT_COST_ROLLUP_NAME } from "../../src/services/stats-rollup-root-cost.js";
import { rebuildRunDayRollup, RUN_DAY_ROLLUP_NAME } from "../../src/services/stats-rollup-run-day.js";

// Migration 0054. stats_rollup_root_cost (whole-subtree actual cost per top-level
// run) must equal a live walk of the ledger through every write the triggers
// see, and GET /internal/stats/task-outcomes must answer byte-for-byte what its
// live query answers, on every combination of its two rollups (org_task,
// root_cost). Same for stats_rollup_run_day / _platform_cost_day and
// GET /public/stats/runs.

const ORG = "0d54aaaa-1111-4aaa-8aaa-111111111111";
const ORG2 = "0d54aaaa-2222-4aaa-8aaa-222222222222";
const SUFFIX = randomUUID().slice(0, 8);
const SVC = `to-rollup-svc-${SUFFIX}`;
const OTHER = `to-rollup-other-${SUFFIX}`;
const CAMPAIGN = `to-rollup-campaign-${SUFFIX}`;
const ORG_TASK = "org_task";
const DAY = 86_400_000;
const T0 = Date.parse("2026-09-20T10:00:00.000Z");

const app = createTestApp();
const internal = getInternalAuthHeaders();
const URL_ = () => process.env.RUNS_SERVICE_DATABASE_URL!;

async function run(o: {
  service?: string;
  task: string;
  at: number;
  status?: string;
  parent?: string;
  org?: string | null;
  campaign?: string;
}) {
  return insertTestRun({
    organizationId: o.org === undefined ? ORG : o.org,
    serviceName: o.service ?? SVC,
    taskName: o.task,
    status: o.status ?? "completed",
    parentRunId: o.parent,
    startedAt: new Date(o.at),
    campaignId: o.campaign,
  });
}

async function cost(runId: string, total: string, status = "actual", costSource = "platform") {
  return insertTestRunCost({
    runId,
    costName: "to-rollup-cost",
    costSource,
    quantity: "1",
    unitCostInUsdCents: total,
    totalCostInUsdCents: total,
    status,
  });
}

/** Whole-subtree actual cost of every top-level run, walked live. */
async function liveRootCost() {
  const rows = await rawSql`
    WITH RECURSIVE d AS (
      SELECT id, id AS root FROM runs WHERE parent_run_id IS NULL
      UNION ALL
      SELECT c.id, d.root FROM d JOIN runs c ON c.parent_run_id = d.id
    )
    SELECT d.root::text AS root, count(*)::text AS n, SUM(rc.total_cost_in_usd_cents)::numeric(30,10)::text AS g
    FROM d JOIN runs_costs rc ON rc.run_id = d.id AND rc.status = 'actual'
    GROUP BY d.root ORDER BY 1
  `;
  return rows.map((r) => ({ ...r }));
}

async function rollupRootCost() {
  const zeroed = await rawSql`SELECT count(*)::int AS n FROM stats_rollup_root_cost WHERE n_actual = 0 AND gross_actual <> 0`;
  expect(zeroed[0].n).toBe(0);
  const rows = await rawSql`
    SELECT root_run_id::text AS root, n_actual::text AS n, gross_actual::numeric(30,10)::text AS g
    FROM stats_rollup_root_cost WHERE n_actual <> 0 ORDER BY 1
  `;
  return rows.map((r) => ({ ...r }));
}

async function liveRunDay() {
  const runsDay = await rawSql`
    SELECT (started_at AT TIME ZONE 'UTC')::date::text AS day, status, count(*)::text AS n FROM runs GROUP BY 1, 2 ORDER BY 1, 2
  `;
  const costDay = await rawSql`
    SELECT (run_started_at AT TIME ZONE 'UTC')::date::text AS day, count(*)::text AS n, SUM(total_cost_in_usd_cents)::numeric(30,10)::text AS g
    FROM runs_costs WHERE is_platform_projected GROUP BY 1 ORDER BY 1
  `;
  return { runsDay: runsDay.map((r) => ({ ...r })), costDay: costDay.map((r) => ({ ...r })) };
}

async function rollupRunDay() {
  const runsDay = await rawSql`
    SELECT day::text AS day, status, run_count::text AS n FROM stats_rollup_run_day WHERE run_count <> 0 ORDER BY 1, 2
  `;
  const costDay = await rawSql`
    SELECT day::text AS day, n_rows::text AS n, gross::numeric(30,10)::text AS g FROM stats_rollup_platform_cost_day WHERE n_rows <> 0 ORDER BY 1
  `;
  return { runsDay: runsDay.map((r) => ({ ...r })), costDay: costDay.map((r) => ({ ...r })) };
}

async function expectParity() {
  expect(await rollupRootCost()).toEqual(await liveRootCost());
  expect(await rollupRunDay()).toEqual(await liveRunDay());
}

async function withoutStamps<T>(names: string[], fn: () => Promise<T>): Promise<T> {
  const held = await rawSql`SELECT name, ready_at FROM stats_rollups WHERE name = ANY(${names})`;
  await rawSql`DELETE FROM stats_rollups WHERE name = ANY(${names})`;
  try {
    return await fn();
  } finally {
    for (const h of held) {
      await rawSql`INSERT INTO stats_rollups (name, ready_at) VALUES (${h.name}, ${h.ready_at}) ON CONFLICT (name) DO NOTHING`;
    }
  }
}

async function taskOutcomes(sample: string) {
  const res = await request(app).get("/internal/stats/task-outcomes").query({ serviceName: SVC, sample }).set(internal);
  expect(res.status).toBe(200);
  return res.body;
}

/** The read on every rollup combination answers exactly what the live query answers. */
async function expectTaskOutcomesParity(sample: string) {
  const both = await taskOutcomes(sample);
  const live = await withoutStamps([ORG_TASK, ROOT_COST_ROLLUP_NAME], () => taskOutcomes(sample));
  const orgTaskOnly = await withoutStamps([ROOT_COST_ROLLUP_NAME], () => taskOutcomes(sample));
  const rootCostOnly = await withoutStamps([ORG_TASK], () => taskOutcomes(sample));
  expect(both).toEqual(live);
  expect(orgTaskOnly).toEqual(live);
  expect(rootCostOnly).toEqual(live);
  return live;
}

async function publicRuns() {
  const res = await request(app).get("/public/stats/runs");
  expect(res.status).toBe(200);
  return res.body;
}

async function expectPublicRunsParity() {
  const fromRollup = await publicRuns();
  const live = await withoutStamps([RUN_DAY_ROLLUP_NAME], publicRuns);
  expect(fromRollup).toEqual(live);
  return live;
}

async function cleanup() {
  await cleanTestData([ORG, ORG2]);
  // Org-less runs of this file only, leaves first (parent FK).
  for (let i = 0; i < 6; i++) {
    await db.delete(runs).where(inArray(runs.serviceName, [SVC, OTHER])).catch(() => undefined);
  }
}

describe("migration 0054 rollups: task-outcomes subtree cost + public run series", () => {
  beforeAll(async () => {
    await cleanup();
    for (const name of [ORG_TASK, ROOT_COST_ROLLUP_NAME, RUN_DAY_ROLLUP_NAME]) {
      await rawSql`INSERT INTO stats_rollups (name, ready_at) VALUES (${name}, now()) ON CONFLICT (name) DO NOTHING`;
    }
  });
  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  it("stays equal to the ledger, and both reads equal their live query, through writes, deletes, a reparent and a rebuild", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];

    // Top-level roots of SVC across days, two campaigns (NULL and set), org-less too.
    const roots: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await run({
        task: `POST /v1/things/${ids[i % 3]}`,
        at: T0 + Math.floor(i / 2) * DAY + i * 1000,
        status: i % 3 === 0 ? "failed" : "completed",
        org: i === 5 ? null : ORG,
        campaign: i % 2 === 0 ? CAMPAIGN : undefined,
      });
      roots.push(r.id);
      await cost(r.id, `${i + 1}.2500000000`);
      await cost(r.id, "9.0000000000", "provisioned");
      // A subtree 3 levels deep under each root, costs at every level.
      const c1 = await run({ service: OTHER, task: "child", at: T0 + i * 1000 + 10, parent: r.id });
      await cost(c1.id, "0.5000000000", "actual", "org");
      const c2 = await run({ service: OTHER, task: "grandchild", at: T0 + i * 1000 + 20, parent: c1.id, status: "running" });
      await cost(c2.id, "0.1000000000");
      await cost(c2.id, "3.0000000000", "cancelled");
      // A NON-top-level SVC run (sampled, walked live) with its own subtree.
      const nested = await run({ task: "nested-work", at: T0 + i * 1000 + 30, parent: c2.id, campaign: CAMPAIGN });
      await cost(nested.id, "2.0000000000");
      const leaf = await run({ service: OTHER, task: "leaf", at: T0 + i * 1000 + 40, parent: nested.id });
      await cost(leaf.id, "0.0300000000");
    }
    // The task's newest run starts exactly at UTC midnight: the cutoff day's first instant.
    await run({ task: `POST /v1/things/${ids[1]}`, at: Date.parse("2026-09-26T00:00:00.000Z"), org: ORG2 });
    // Same-instant ties: the (started_at DESC, id DESC) order decides the sample.
    for (let i = 0; i < 3; i++) await run({ task: "tie", at: T0 + 4 * DAY, org: i === 0 ? null : ORG2 });

    await expectParity();
    for (const sample of ["1", "2", "3", "200"]) await expectTaskOutcomesParity(sample);
    await expectPublicRunsParity();

    // Status transitions and amount edits.
    const [held] = await db.select().from(runsCosts).where(eq(runsCosts.status, "provisioned")).limit(1);
    await db.update(runsCosts).set({ status: "actual" }).where(eq(runsCosts.id, held.id));
    await db.update(runsCosts).set({ totalCostInUsdCents: "4.4400000000" }).where(eq(runsCosts.id, held.id));
    const extra = await cost(roots[1], "7.0000000000");
    await db.update(runsCosts).set({ status: "cancelled" }).where(eq(runsCosts.id, extra.id));
    await db.update(runs).set({ status: "failed" }).where(eq(runs.id, roots[2]));
    await db.update(runs).set({ startedAt: new Date(T0 + 7 * DAY) }).where(eq(runs.id, roots[3]));
    await expectParity();

    // Reparent a subtree (nested of root 0, with its leaf) under root 4.
    const nestedRows = await db.select().from(runs).where(eq(runs.taskName, "nested-work"));
    const moved = nestedRows.find((n) => n.serviceName === SVC)!;
    const [target] = await db.select().from(runs).where(eq(runs.parentRunId, roots[4]));
    await db.update(runs).set({ parentRunId: target.id }).where(eq(runs.id, moved.id));
    // ...and a subtree promoted to top level.
    const [promoted] = await db.select().from(runs).where(eq(runs.parentRunId, roots[5]));
    await db.update(runs).set({ parentRunId: null }).where(eq(runs.id, promoted.id));
    await expectParity();
    await expectTaskOutcomesParity("2");

    // Multi-row deletes in one statement, whatever the row order: a whole tree,
    // and a mid-level subtree under a surviving root.
    const tree = await rawSql`
      WITH RECURSIVE d AS (SELECT id FROM runs WHERE id = ${roots[0]} UNION ALL SELECT c.id FROM d JOIN runs c ON c.parent_run_id = d.id)
      SELECT id FROM d
    `;
    await rawSql`DELETE FROM runs WHERE id = ANY(${tree.map((r) => r.id)}::uuid[])`;
    const [mid] = await db.select().from(runs).where(eq(runs.parentRunId, roots[1]));
    const sub = await rawSql`
      WITH RECURSIVE d AS (SELECT id FROM runs WHERE id = ${mid.id} UNION ALL SELECT c.id FROM d JOIN runs c ON c.parent_run_id = d.id)
      SELECT id FROM d
    `;
    // Children listed first, then the parents: the planner deletes in ctid order either way.
    await rawSql`DELETE FROM runs WHERE id = ANY(${sub.map((r) => r.id).reverse()}::uuid[])`;
    // A single cost row removed directly.
    const [one] = await db.select().from(runsCosts).where(eq(runsCosts.runId, roots[2]));
    await db.delete(runsCosts).where(eq(runsCosts.id, one.id));
    await expectParity();
    for (const sample of ["1", "2", "200"]) await expectTaskOutcomesParity(sample);
    await expectPublicRunsParity();

    // A rebuild from the ledger lands on the same tables.
    const before = await rollupRootCost();
    const beforeDay = await rollupRunDay();
    await rebuildRootCostRollup(URL_());
    await rebuildRunDayRollup(URL_());
    expect(await rollupRootCost()).toEqual(before);
    expect(await rollupRunDay()).toEqual(beforeDay);
    await expectParity();
    await expectTaskOutcomesParity("2");
    await expectPublicRunsParity();
  });

  it("a cost row without run_started_at still fails the public read loud on the rollup path", async () => {
    const r = await run({ task: "no-start", at: T0 });
    await insertTestRunCost({
      runId: r.id,
      costName: "to-rollup-cost",
      quantity: "1",
      unitCostInUsdCents: "1",
      totalCostInUsdCents: "1",
      runStartedAt: null,
    });
    try {
      expect((await request(app).get("/public/stats/runs")).status).toBe(500);
      await withoutStamps([RUN_DAY_ROLLUP_NAME], async () => {
        expect((await request(app).get("/public/stats/runs")).status).toBe(500);
      });
    } finally {
      await db.delete(runs).where(eq(runs.id, r.id));
    }
    await expectParity();
  });
});
