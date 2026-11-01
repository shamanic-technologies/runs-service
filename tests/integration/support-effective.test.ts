import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { sql as rawSql } from "../../src/db/index.js";
import {
  SUPPORT_EFFECTIVE_STAMP,
  backfillSupportEffective,
  drainSupportPropagationQueue,
} from "../../src/services/support-effective.js";
import { SUBTREE_COST_ROLLUP_NAME } from "../../src/services/stats-rollup-subtree-cost.js";

// Migration 0091: the support function covering each run (nearest mark among itself and its
// ancestors) is kept at write time in run_support_effective, so GET /internal/runs/subtree-costs
// reads it with a PK probe instead of walking up. Every path must agree with the walk.

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});

const ORG = "0091aaaa-1111-4aaa-8aaa-111111111111";
const CAMPAIGN = "camp-support-effective";
const API_KEY = { "x-api-key": "test-api-key" };
const app = createTestApp();

async function run(parentRunId?: string) {
  const r = await insertTestRun({
    organizationId: ORG,
    serviceName: "support-effective-svc",
    taskName: "node",
    parentRunId,
    campaignId: CAMPAIGN,
    status: "completed",
  });
  return r.id;
}
async function mark(runId: string, kind: string) {
  await rawSql`INSERT INTO run_support_marks (run_id, kind, marked_at) VALUES (${runId}::uuid, ${kind}, now())`;
}
async function unmark(runId: string) {
  await rawSql`DELETE FROM run_support_marks WHERE run_id = ${runId}::uuid`;
}
async function effective(ids: string[]) {
  const rows = await rawSql`SELECT run_id::text, kind FROM run_support_effective WHERE run_id = ANY(${ids}::uuid[])`;
  const m = new Map(rows.map((r) => [r.run_id as string, r.kind as string]));
  return ids.map((id) => m.get(id) ?? null);
}
/** Run every queued pass now (the second pass is normally ~60 s later). */
async function drainAll() {
  await drainSupportPropagationQueue();
  await rawSql`UPDATE run_support_propagation_queue SET due_at = now()`;
  await drainSupportPropagationQueue();
}
async function setStamp(name: string, on: boolean) {
  if (on) await rawSql`INSERT INTO stats_rollups (name, ready_at) VALUES (${name}, now()) ON CONFLICT (name) DO NOTHING`;
  else await rawSql`DELETE FROM stats_rollups WHERE name = ${name}`;
}

describe("run_support_effective (migration 0091)", () => {
  // root (marked product_feature) > mid > leaf ; mid > own (marked copilot) > ownChild ; other (unmarked)
  let root: string, mid: string, leaf: string, own: string, ownChild: string, other: string;

  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue([
      { costName: "se-tok", servedFrom: "2026-01-01T00:00:00Z", billedUnitCostInUsdCents: "2", vendorUnitCostInUsdCents: "1" },
    ]);
    root = await run();
    mid = await run(root);
    leaf = await run(mid);
    own = await run(mid);
    ownChild = await run(own);
    other = await run();
    await insertTestRunCost({ runId: leaf, costName: "se-tok", quantity: "3", unitCostInUsdCents: "2", totalCostInUsdCents: "6" });
    await mark(own, "copilot");
    await mark(root, "product_feature");
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("a mark covers its subtree down to a descendant with its own mark, once the queue is drained", async () => {
    await drainAll();
    expect(await effective([root, mid, leaf, own, ownChild, other])).toEqual([
      "product_feature", "product_feature", "product_feature", "copilot", "copilot", null,
    ]);
    const [{ n }] = await rawSql`SELECT count(*)::int AS n FROM run_support_propagation_queue WHERE run_id = ANY(${[root, own]}::uuid[])`;
    expect(n).toBe(0);
  });

  it("a run inserted under a covered parent inherits at insert, with no queue pass", async () => {
    const late = await run(leaf);
    expect(await effective([late])).toEqual(["product_feature"]);
  });

  it("an unmark moves the subtree to the next mark up, or to none", async () => {
    await unmark(own);
    await drainAll();
    expect(await effective([own, ownChild])).toEqual(["product_feature", "product_feature"]);
    await unmark(root);
    await drainAll();
    expect(await effective([root, mid, leaf, own, ownChild])).toEqual([null, null, null, null, null]);
    await mark(root, "product_feature");
    await mark(own, "copilot");
    await drainAll();
  });

  it("the backfill rebuilds the same rows from the marks alone, and stamps", async () => {
    const ids = [root, mid, leaf, own, ownChild, other];
    const before = await effective(ids);
    await rawSql`DELETE FROM run_support_effective WHERE run_id = ANY(${ids}::uuid[])`;
    await backfillSupportEffective({ chunk: 1 });
    expect(await effective(ids)).toEqual(before);
    const [{ ok }] = await rawSql`SELECT EXISTS (SELECT 1 FROM stats_rollups WHERE name = ${SUPPORT_EFFECTIVE_STAMP}) AS ok`;
    expect(ok).toBe(true);
  });

  it("GET /internal/runs/subtree-costs answers the same body from the stores and from the walks", async () => {
    const bodies: string[] = [];
    for (const [cost, support] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      await setStamp(SUBTREE_COST_ROLLUP_NAME, cost);
      await setStamp(SUPPORT_EFFECTIVE_STAMP, support);
      const res = await request(app).get("/internal/runs/subtree-costs").query({ orgId: ORG, campaignId: CAMPAIGN }).set(API_KEY);
      expect(res.status).toBe(200);
      bodies.push(res.text);
    }
    expect(new Set(bodies).size).toBe(1);
    const byId = new Map(JSON.parse(bodies[0]).runs.map((r: any) => [r.id, r]));
    expect((byId.get(leaf) as any).supportFunction).toBe("product_feature");
    expect((byId.get(leaf) as any).vendorActualCostInUsdCents).toBe("3.0000000000");
    expect((byId.get(root) as any).actualCostInUsdCents).toBe("6.0000000000");
    expect((byId.get(ownChild) as any).supportFunction).toBe("copilot");
    expect((byId.get(other) as any).supportFunction).toBeNull();
    await setStamp(SUBTREE_COST_ROLLUP_NAME, false);
  });

  it("GET /internal/runs/vendor answers the same body walking only costed subtrees (stamped) or every run", async () => {
    const bodies: string[] = [];
    for (const cost of [false, true]) {
      await setStamp(SUBTREE_COST_ROLLUP_NAME, cost);
      const res = await request(app).get("/internal/runs/vendor").query({ orgId: ORG, campaignId: CAMPAIGN, limit: "50" }).set(API_KEY);
      expect(res.status).toBe(200);
      bodies.push(res.text);
    }
    expect(bodies[1]).toBe(bodies[0]);
    const byId = new Map(JSON.parse(bodies[0]).runs.map((r: any) => [r.id, r]));
    expect((byId.get(mid) as any).vendorActualCostInUsdCents).toBe("3.0000000000");
    await setStamp(SUBTREE_COST_ROLLUP_NAME, false);
  });
});
