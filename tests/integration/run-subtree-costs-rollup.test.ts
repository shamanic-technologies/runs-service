import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, sql as rawSql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { rebuildSubtreeCostRollup, SUBTREE_COST_ROLLUP_NAME } from "../../src/services/stats-rollup-subtree-cost.js";

// Migration 0086 (BOX-DB-LOAD-1027-RUNS). run_subtree_costs (each run's whole-subtree
// actual + provisioned cost, gross and frozen net) must equal a live walk of the ledger
// for EVERY run, through every write its triggers see, and
// GET /v1/runs?include=subtreeCost must answer byte-for-byte what its live walk answers.

const ORG = "0d86aaaa-1111-4aaa-8aaa-111111111111";
const H = { "x-api-key": "test-api-key", "x-org-id": ORG };
const app = createTestApp();

async function run(parent?: string, task = "node") {
  return insertTestRun({ organizationId: ORG, serviceName: "subtree-rollup-svc", taskName: task, status: "completed", parentRunId: parent });
}

async function cost(runId: string, total: string, status = "actual", net?: string) {
  return insertTestRunCost({
    runId,
    costName: "subtree-rollup-cost",
    quantity: "1",
    unitCostInUsdCents: total,
    totalCostInUsdCents: total,
    status,
    ...(net !== undefined ? { netCostInUsdCents: net, usageDiscountPct: "0.2" } : {}),
  });
}

const n10 = (x: string | null | undefined) => (x === null || x === undefined ? null : Number(x).toFixed(10));

/** Every run of ORG: its subtree's figures walked live (zero rows = absent). */
async function live() {
  const rows = await rawSql`
    WITH RECURSIVE d AS (
      SELECT id, id AS root FROM runs WHERE organization_id = ${ORG}
      UNION ALL
      SELECT c.id, d.root FROM d JOIN runs c ON c.parent_run_id = d.id
    )
    SELECT d.root::text AS run_id, count(*)::text AS n,
      SUM(CASE WHEN rc.status = 'actual' THEN rc.total_cost_in_usd_cents ELSE 0 END)::text AS ga,
      SUM(CASE WHEN rc.status = 'provisioned' THEN rc.total_cost_in_usd_cents ELSE 0 END)::text AS gp,
      SUM(CASE WHEN rc.status = 'actual' THEN COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) ELSE 0 END)::text AS na,
      SUM(CASE WHEN rc.status = 'provisioned' THEN COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) ELSE 0 END)::text AS np
    FROM d JOIN runs_costs rc ON rc.run_id = d.id AND rc.status IN ('actual', 'provisioned')
    GROUP BY d.root ORDER BY 1
  `;
  return rows.map((r) => ({ run_id: r.run_id, n: r.n, ga: n10(r.ga), gp: n10(r.gp), na: n10(r.na), np: n10(r.np) }));
}

/** The rollup rows of every run of ORG, plus any row whose run no longer exists (must be none). */
async function rollup(ids: string[]) {
  const rows = await rawSql`
    SELECT run_id::text, n_rows::text AS n, gross_actual::text AS ga, gross_provisioned::text AS gp,
      net_actual::text AS na, net_provisioned::text AS np
    FROM run_subtree_costs
    WHERE (run_id IN (SELECT id FROM runs WHERE organization_id = ${ORG}) OR run_id = ANY(${ids}::uuid[]))
      AND n_rows <> 0
    ORDER BY 1
  `;
  return rows.map((r) => ({ run_id: r.run_id, n: r.n, ga: n10(r.ga), gp: n10(r.gp), na: n10(r.na), np: n10(r.np) }));
}

const seen: string[] = [];
async function expectParity() {
  expect(await rollup(seen)).toEqual(await live());
}

async function listBody(stamped: boolean) {
  if (!stamped) await rawSql`DELETE FROM stats_rollups WHERE name = ${SUBTREE_COST_ROLLUP_NAME}`;
  try {
    const res = await request(app)
      .get("/v1/runs")
      .query({ serviceName: "subtree-rollup-svc", limit: "500", include: "subtreeCost" })
      .set(H);
    expect(res.status).toBe(200);
    return res.text;
  } finally {
    if (!stamped) {
      await rawSql`INSERT INTO stats_rollups (name, ready_at) VALUES (${SUBTREE_COST_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
    }
  }
}

describe("run_subtree_costs (migration 0086) == live walk", () => {
  let root: string, a: string, a1: string, a2: string, b: string, b1: string;

  beforeAll(async () => {
    await cleanTestData([ORG]);
    await rawSql`INSERT INTO stats_rollups (name, ready_at) VALUES (${SUBTREE_COST_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
    root = (await run(undefined, "root")).id;
    a = (await run(root)).id;
    a1 = (await run(a)).id;
    a2 = (await run(a)).id;
    b = (await run(root)).id;
    b1 = (await run(b)).id;
    seen.push(root, a, a1, a2, b, b1);
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("inserts of every status, net or not, at every depth", async () => {
    await cost(root, "1");
    await cost(a, "2", "actual", "1.6");
    await cost(a1, "3.25", "provisioned", "2.6");
    await cost(a1, "100", "cancelled");
    await cost(a2, "50", "refunded", "40");
    await cost(b1, "0.0000000001");
    await cost(b1, "7", "provisioned");
    await expectParity();
    const [r] = await rawSql`SELECT gross_actual::text AS ga, gross_provisioned::text AS gp FROM run_subtree_costs WHERE run_id = ${root}`;
    expect(n10(r.ga)).toBe("3.0000000001");
    expect(n10(r.gp)).toBe("10.2500000000");
  });

  it("materialize, cancel, refund, net change, move to another run", async () => {
    const p = await cost(a2, "4", "provisioned", "3.2");
    await db.update(runsCosts).set({ status: "actual", totalCostInUsdCents: "4.5", netCostInUsdCents: "3.6" }).where(eq(runsCosts.id, p.id));
    await expectParity();
    const q = await cost(b, "9", "provisioned");
    await db.update(runsCosts).set({ status: "cancelled" }).where(eq(runsCosts.id, q.id));
    await expectParity();
    const s = await cost(b1, "11");
    await db.update(runsCosts).set({ status: "refunded" }).where(eq(runsCosts.id, s.id));
    await db.update(runsCosts).set({ netCostInUsdCents: "0.5" }).where(eq(runsCosts.id, p.id));
    await expectParity();
    await db.update(runsCosts).set({ runId: b1 }).where(eq(runsCosts.id, p.id));
    await expectParity();
    await db.delete(runsCosts).where(eq(runsCosts.id, p.id));
    await expectParity();
  });

  it("reparent moves the subtree", async () => {
    await db.update(runs).set({ parentRunId: a1 }).where(eq(runs.id, b));
    await expectParity();
    await db.update(runs).set({ parentRunId: root }).where(eq(runs.id, b));
    await expectParity();
  });

  it("concurrent cost writes in one tree lose nothing", async () => {
    const leaves = [a1, a2, b1, b];
    await Promise.all(Array.from({ length: 20 }, (_, i) => cost(leaves[i % leaves.length], `${i + 1}.5`, i % 3 === 0 ? "provisioned" : "actual")));
    await expectParity();
  });

  it("GET /v1/runs?include=subtreeCost: rollup body == live body", async () => {
    const stored = await listBody(true);
    const walked = await listBody(false);
    expect(stored).toBe(walked);
    expect(JSON.parse(stored).runs.find((r: { id: string }) => r.id === root).totalCostInUsdCents).not.toBe("0.0000000000");
  });

  it("a rebuild racing writes == live", async () => {
    const racing = Promise.all([cost(a1, "2.5"), cost(b1, "1.25", "provisioned")]);
    await rebuildSubtreeCostRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    await racing;
    await expectParity();
    expect(await listBody(true)).toBe(await listBody(false));
  });

  it("deletes in any order: a leaf, a middle run with its subtree, then the whole org at once", async () => {
    await db.delete(runs).where(eq(runs.id, a2));
    await expectParity();
    // b1 then b in ONE statement (child before parent or the reverse, the planner's order).
    await rawSql`DELETE FROM runs WHERE id IN (${b}, ${b1})`;
    await expectParity();
    await cleanTestData([ORG]);
    expect(await rollup(seen)).toEqual([]);
  });
});
