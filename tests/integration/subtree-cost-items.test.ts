import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, sql as rawSql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import {
  SUBTREE_COST_ITEMS_ROLLUP_NAME,
  SUBTREE_COST_ROLLUP_NAME,
  rebuildSubtreeCostItemsRollup,
} from "../../src/services/stats-rollup-subtree-cost.js";
import { SUPPORT_EFFECTIVE_STAMP } from "../../src/services/support-effective.js";

// Migration 0092: run_subtree_cost_items (each run's whole-subtree ACTUAL cost rows per cost name,
// billed unit, cost-row UTC hour) must equal a live walk for EVERY run through every write its
// triggers see, and GET /internal/runs/subtree-costs must answer byte-for-byte the same body from
// the stores as from the walks, a version changing inside an hour included.

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});

const ORG = "0092aaaa-1111-4aaa-8aaa-111111111111";
const CAMPAIGN = "camp-subtree-cost-items";
const API_KEY = { "x-api-key": "test-api-key" };
const app = createTestApp();

async function run(parentRunId?: string) {
  const r = await insertTestRun({
    organizationId: ORG, serviceName: "items-svc", taskName: "node", parentRunId, campaignId: CAMPAIGN, status: "completed",
  });
  return r.id;
}
async function cost(runId: string, name: string, qty: string, unit: string, at: string, status = "actual") {
  const total = (Number(qty) * Number(unit)).toFixed(10);
  const r = await insertTestRunCost({ runId, costName: name, quantity: qty, unitCostInUsdCents: unit, totalCostInUsdCents: total, status, createdAt: new Date(at) });
  return r.id as string;
}
const n10 = (x: unknown) => Number(x).toFixed(10);

/** Every run of ORG: its subtree's actual rows walked live, per item key. */
async function live() {
  const rows = await rawSql`
    WITH RECURSIVE d AS (
      SELECT id, id AS root FROM runs WHERE organization_id = ${ORG}
      UNION ALL
      SELECT c.id, d.root FROM d JOIN runs c ON c.parent_run_id = d.id
    )
    SELECT d.root::text AS run_id, rc.cost_name, rc.unit_cost_in_usd_cents::text AS unit,
      date_trunc('hour', rc.created_at, 'UTC') AS h, count(*)::text AS n, SUM(rc.quantity)::text AS qty, SUM(rc.total_cost_in_usd_cents)::text AS gross
    FROM d JOIN runs_costs rc ON rc.run_id = d.id AND rc.status = 'actual'
    GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4
  `;
  return rows.map((r) => [r.run_id, r.cost_name, n10(r.unit), new Date(r.h).toISOString(), r.n, n10(r.qty), n10(r.gross)].join("|"));
}
async function stored() {
  const rows = await rawSql`
    SELECT i.run_id::text, i.cost_name, i.unit::text, i.cost_hour AS h, i.n::text, i.qty::text, i.gross::text
    FROM run_subtree_cost_items i
    WHERE i.run_id IN (SELECT id FROM runs WHERE organization_id = ${ORG}) AND (i.n <> 0 OR i.qty <> 0 OR i.gross <> 0)
    ORDER BY 1, 2, 3, 4
  `;
  return rows.map((r) => [r.run_id, r.cost_name, n10(r.unit), new Date(r.h).toISOString(), r.n, n10(r.qty), n10(r.gross)].join("|"));
}
async function setStamp(name: string, on: boolean) {
  if (on) await rawSql`INSERT INTO stats_rollups (name, ready_at) VALUES (${name}, now()) ON CONFLICT (name) DO NOTHING`;
  else await rawSql`DELETE FROM stats_rollups WHERE name = ${name}`;
}

describe("run_subtree_cost_items (migration 0092)", () => {
  let root: string, mid: string, leaf: string, other: string, held: string;

  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue([
      { costName: "it-tok", servedFrom: "2026-01-01T00:00:00Z", billedUnitCostInUsdCents: "2", vendorUnitCostInUsdCents: "1" },
      // A vendor price change inside the 10:00 hour on 06-01: rows of that hour straddle it.
      { costName: "it-tok", servedFrom: "2026-06-01T10:30:00Z", billedUnitCostInUsdCents: "2", vendorUnitCostInUsdCents: "1.5" },
      { costName: "it-unknown", servedFrom: "2026-01-01T00:00:00Z", billedUnitCostInUsdCents: "3", vendorUnitCostInUsdCents: null },
    ]);
    root = await run();
    mid = await run(root);
    leaf = await run(mid);
    other = await run();
    await cost(leaf, "it-tok", "3", "2", "2026-05-01T09:15:00Z");
    await cost(leaf, "it-tok", "1.5", "2", "2026-05-01T09:45:00Z");
    await cost(mid, "it-unknown", "2", "3", "2026-05-01T09:20:00Z");
    await cost(other, "it-tok", "4", "2", "2026-06-01T10:10:00Z"); // straddled hour: 1 cent vendor
    await cost(other, "it-tok", "2", "2", "2026-06-01T10:50:00Z"); // straddled hour: 1.5 cent vendor
    held = await cost(mid, "it-tok", "5", "2", "2026-05-01T11:00:00Z", "provisioned");
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("equals a live walk after inserts, a status flip, a cost delete, a reparent and a run delete", async () => {
    expect(await stored()).toEqual(await live());
    await db.update(runsCosts).set({ status: "actual" }).where(eq(runsCosts.id, held));
    expect(await stored()).toEqual(await live());
    await db.delete(runsCosts).where(eq(runsCosts.id, held));
    expect(await stored()).toEqual(await live());
    await db.update(runs).set({ parentRunId: other }).where(eq(runs.id, mid));
    expect(await stored()).toEqual(await live());
    await db.update(runs).set({ parentRunId: root }).where(eq(runs.id, mid));
    const gone = await run(leaf);
    await cost(gone, "it-tok", "7", "2", "2026-05-02T08:00:00Z");
    expect(await stored()).toEqual(await live());
    await db.delete(runs).where(eq(runs.id, gone));
    expect(await stored()).toEqual(await live());
  });

  it("a rebuild from the ledger lands on the same rows, and stamps", async () => {
    const before = await stored();
    await rebuildSubtreeCostItemsRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    expect(await stored()).toEqual(before);
    const [{ ok }] = await rawSql`SELECT EXISTS (SELECT 1 FROM stats_rollups WHERE name = ${SUBTREE_COST_ITEMS_ROLLUP_NAME}) AS ok`;
    expect(ok).toBe(true);
  });

  it("GET /internal/runs/subtree-costs answers the same body under every stamp combination", async () => {
    const bodies: string[] = [];
    for (const cost of [false, true]) {
      for (const items of [false, true]) {
        for (const support of [false, true]) {
          await setStamp(SUBTREE_COST_ROLLUP_NAME, cost);
          await setStamp(SUBTREE_COST_ITEMS_ROLLUP_NAME, items);
          await setStamp(SUPPORT_EFFECTIVE_STAMP, support);
          const res = await request(app).get("/internal/runs/subtree-costs").query({ orgId: ORG, campaignId: CAMPAIGN }).set(API_KEY);
          expect(res.status, `cost=${cost} items=${items} support=${support}`).toBe(200);
          bodies.push(res.text);
        }
      }
    }
    for (const b of bodies) expect(b).toBe(bodies[0]);
    const byId = new Map(JSON.parse(bodies[0]).runs.map((r: any) => [r.id, r]));
    expect((byId.get(root) as any).vendorActualCostInUsdCents).toBe("4.5000000000"); // (3 + 1.5) x 1
    expect((byId.get(root) as any).unpricedActualCostInUsdCents).toBe("6.0000000000"); // unknown vendor
    expect((byId.get(other) as any).vendorActualCostInUsdCents).toBe("7.0000000000"); // 4 x 1 + 2 x 1.5
    await setStamp(SUBTREE_COST_ROLLUP_NAME, true);
    await setStamp(SUBTREE_COST_ITEMS_ROLLUP_NAME, true);
  });
});
