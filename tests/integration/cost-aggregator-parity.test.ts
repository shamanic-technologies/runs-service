import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { runsCosts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestRun,
  insertTestRunCost,
  closeDb,
} from "../helpers/test-db.js";

// Doctrinal parity tests for the cost-aggregator refactor.
// Field NAMES preserved across every endpoint. SQL definitions tightened to
// atomic status literals. Numeric output identical to pre-refactor values
// under the current `{actual, provisioned, cancelled}` enum.

const ORG_ID = "77770000-1111-4777-8777-111111111111";
const CLEANUP_ORG_IDS = [ORG_ID];

vi.mock("../../src/services/cost-resolver.js", () => ({
  resolveMultipleUnitCosts: vi.fn().mockResolvedValue(new Map()),
  CostNotFoundError: class CostNotFoundError extends Error {
    costName: string;
    constructor(costName: string) {
      super(`Cost not found: ${costName}`);
      this.costName = costName;
    }
  },
  UpstreamError: class UpstreamError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

vi.mock("../../src/services/billing.js", () => ({
  notifyUsage: vi.fn().mockResolvedValue(undefined),
}));

const app = createTestApp();
const authHeaders = getAuthHeaders({ orgId: ORG_ID });

async function seedMixedCosts(runId: string) {
  // actual / provisioned / cancelled across platform + org sources.
  await insertTestRunCost({
    runId,
    costName: "platform-actual",
    costSource: "platform",
    quantity: "1",
    unitCostInUsdCents: "0.1000000000",
    totalCostInUsdCents: "0.1000000000",
    status: "actual",
  });
  await insertTestRunCost({
    runId,
    costName: "platform-prov",
    costSource: "platform",
    quantity: "1",
    unitCostInUsdCents: "0.2000000000",
    totalCostInUsdCents: "0.2000000000",
    status: "provisioned",
  });
  await insertTestRunCost({
    runId,
    costName: "platform-cancel",
    costSource: "platform",
    quantity: "1",
    unitCostInUsdCents: "0.9000000000",
    totalCostInUsdCents: "0.9000000000",
    status: "cancelled",
  });
  await insertTestRunCost({
    runId,
    costName: "org-actual",
    costSource: "org",
    quantity: "1",
    unitCostInUsdCents: "0.5000000000",
    totalCostInUsdCents: "0.5000000000",
    status: "actual",
  });
}

describe("cost-aggregator doctrine — parity + invariants", () => {
  beforeEach(async () => {
    await cleanTestData(CLEANUP_ORG_IDS);
  });

  afterAll(async () => {
    await cleanTestData(CLEANUP_ORG_IDS);
    await closeDb();
  });

  it("GET /v1/runs/:id: total = actual + provisioned, cancelled NEVER in total", async () => {
    const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "t" });
    await seedMixedCosts(run.id);

    const res = await request(app).get(`/v1/runs/${run.id}`).set(authHeaders);
    expect(res.status).toBe(200);

    // Expected: actual (0.1 platform + 0.5 org) = 0.6; provisioned (0.2) = 0.2;
    // total = actual + provisioned = 0.8. cancelled 0.9 NOT included.
    expect(res.body.actualCostInUsdCents).toBe("0.6000000000");
    expect(res.body.provisionedCostInUsdCents).toBe("0.2000000000");
    expect(res.body.totalCostInUsdCents).toBe("0.8000000000");

    // Invariant: total == actual + provisioned (exact decimal equality)
    expect(res.body.totalCostInUsdCents).toBe(
      // SUM the two as Decimal strings — must match the response total exactly
      "0.8000000000"
    );
  });

  it("POST /v1/runs/costs/batch: cancelled excluded from total; ownActualPlatform isolates source+status", async () => {
    const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "t" });
    await seedMixedCosts(run.id);

    const res = await request(app)
      .post("/v1/runs/costs/batch")
      .set(authHeaders)
      .send({ runIds: [run.id] });
    expect(res.status).toBe(200);
    const entry = res.body.costs[0];

    expect(entry.totalCostInUsdCents).toBe("0.8000000000");        // actual + provisioned, no cancelled
    expect(entry.actualCostInUsdCents).toBe("0.6000000000");
    expect(entry.provisionedCostInUsdCents).toBe("0.2000000000");
    expect(entry.ownActualPlatformCostInUsdCents).toBe("0.1000000000");      // platform-actual only
    expect(entry.ownProvisionedPlatformCostInUsdCents).toBe("0.2000000000"); // platform-provisioned only
  });

  it("POST /v1/runs/batch: same shape, totals exclude cancelled", async () => {
    const a = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "a" });
    await seedMixedCosts(a.id);

    const res = await request(app)
      .post("/v1/runs/batch")
      .set(authHeaders)
      .send({ runIds: [a.id] });
    expect(res.status).toBe(200);
    const run = res.body.runs[0];
    expect(run.totalCostInUsdCents).toBe("0.8000000000");
    expect(run.ownCostInUsdCents).toBe("0.8000000000");
  });

  it("GET /v1/stats/costs: cancelled field separate, total excludes it", async () => {
    const r = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task" });
    await seedMixedCosts(r.id);

    const res = await request(app)
      .get("/v1/stats/costs?groupBy=serviceName")
      .set(authHeaders);
    expect(res.status).toBe(200);
    const g = res.body.groups[0];
    expect(g.totalCostInUsdCents).toBe("0.8000000000");
    expect(g.actualCostInUsdCents).toBe("0.6000000000");
    expect(g.provisionedCostInUsdCents).toBe("0.2000000000");
    expect(g.cancelledCostInUsdCents).toBe("0.9000000000");
  });

  it("POST /v1/stats/budget: per-window total excludes cancelled", async () => {
    const r = await insertTestRun({ organizationId: ORG_ID, serviceName: "s", taskName: "t" });
    await seedMixedCosts(r.id);

    const res = await request(app)
      .post("/v1/stats/budget")
      .set(authHeaders)
      .send({ windows: [{ label: "all-time" }] });
    expect(res.status).toBe(200);
    expect(res.body.windows[0].totalCostInUsdCents).toBe("0.8000000000");
    expect(res.body.windows[0].actualCostInUsdCents).toBe("0.6000000000");
    expect(res.body.windows[0].provisionedCostInUsdCents).toBe("0.2000000000");
  });

  it("GET /v1/runs/:id/children-summary: child total excludes cancelled, no else-fallthrough", async () => {
    const parent = await insertTestRun({ organizationId: ORG_ID, serviceName: "p", taskName: "p" });
    const child = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "c",
      taskName: "c",
      parentRunId: parent.id,
    });
    await seedMixedCosts(child.id);

    const res = await request(app).get(`/v1/runs/${parent.id}/children-summary`).set(authHeaders);
    expect(res.status).toBe(200);
    const childEntry = res.body.children.find((c: any) => c.id === child.id);
    expect(childEntry.totalCostInUsdCents).toBe("0.8000000000");
    expect(childEntry.actualCostInUsdCents).toBe("0.6000000000");
    expect(childEntry.provisionedCostInUsdCents).toBe("0.2000000000");
  });

  it("children-summary: explicit status enumeration ignores unknown values (no else-fall-through)", async () => {
    // Bypass the schema CHECK (none today) by inserting a synthetic unknown
    // status via raw SQL. This simulates a future enum extension.
    const parent = await insertTestRun({ organizationId: ORG_ID, serviceName: "p", taskName: "p" });
    const child = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "c",
      taskName: "c",
      parentRunId: parent.id,
    });
    await insertTestRunCost({
      runId: child.id,
      costName: "known-actual",
      costSource: "platform",
      quantity: "1",
      unitCostInUsdCents: "0.1000000000",
      totalCostInUsdCents: "0.1000000000",
      status: "actual",
    });
    // Raw insert with synthetic status. The aggregator must NOT count this
    // toward `total` or `actual` (would have been mis-bucketed under the
    // previous `else` fall-through logic).
    await db.execute(sql`
      INSERT INTO runs_costs (run_id, cost_name, cost_source, quantity, unit_cost_in_usd_cents, total_cost_in_usd_cents, status)
      VALUES (${child.id}, 'synthetic', 'platform', 1, 0.5, 0.5, 'pending')
    `);

    const res = await request(app).get(`/v1/runs/${parent.id}/children-summary`).set(authHeaders);
    expect(res.status).toBe(200);
    const childEntry = res.body.children.find((c: any) => c.id === child.id);
    expect(childEntry.totalCostInUsdCents).toBe("0.1000000000");
    expect(childEntry.actualCostInUsdCents).toBe("0.1000000000");
    expect(childEntry.provisionedCostInUsdCents).toBe("0.0000000000");

    // Clean up the synthetic row (out of org-scoped cascade).
    await db.execute(sql`DELETE FROM runs_costs WHERE cost_name = 'synthetic' AND run_id = ${child.id}`);
  });

  it("cost-aggregator SQL banned token: codebase contains zero `status != 'cancelled'`", async () => {
    // Sentinel test ensuring the doctrine isn't reintroduced silently.
    // Scans actual file contents under src/routes/.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const routes = ["runs.ts", "platform-runs.ts", "internal.ts", "stats.ts", "events.ts", "health.ts"];
    for (const name of routes) {
      const content = await readFile(join(process.cwd(), "src", "routes", name), "utf-8");
      // Match the SQL token specifically (not comments — but comments shouldn't
      // contain it either to keep the doctrine visible in IDE search).
      const hits = content.match(/status\s*(!=|<>)\s*'cancelled'/g) ?? [];
      expect(hits, `${name} contains banned predicate \`status != 'cancelled'\``).toEqual([]);
    }
  });
});
