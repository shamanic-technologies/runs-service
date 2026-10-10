import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { runs } from "../../src/db/schema.js";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";

// GET /internal/stats/task-outcomes — fleet-wide (every org + org-less platform
// runs) outcome, duration and whole-subtree actual cost per normalized task of
// ONE service, over each task's most recent `sample` runs.

const ORG_A = "7a5c0000-1111-4aaa-8aaa-111111111111";
const ORG_B = "7a5c0000-2222-4aaa-8aaa-222222222222";
const SUFFIX = randomUUID().slice(0, 8);
const SERVICE = `task-outcomes-svc-${SUFFIX}`;
const CHILD_SERVICE = `task-outcomes-child-${SUFFIX}`;
const OFFER_1 = "d5ec1b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const OFFER_2 = "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D"; // upper case: still an id
const T0 = Date.parse("2026-10-01T10:00:00.000Z");

const app = createTestApp();

async function run(opts: {
  orgId: string | null;
  serviceName?: string;
  taskName: string;
  status: "completed" | "failed" | "running";
  startedAtMs: number;
  durationMs?: number;
  parentRunId?: string;
}) {
  const r = await insertTestRun({
    organizationId: opts.orgId,
    serviceName: opts.serviceName ?? SERVICE,
    taskName: opts.taskName,
    status: opts.status,
    parentRunId: opts.parentRunId,
    startedAt: new Date(opts.startedAtMs),
  });
  if (opts.durationMs !== undefined) {
    await db.update(runs).set({ completedAt: new Date(opts.startedAtMs + opts.durationMs) }).where(eq(runs.id, r.id));
  }
  return r;
}

async function cost(runId: string, total: string, status = "actual", costSource = "platform") {
  await insertTestRunCost({
    runId,
    costName: `test-cost-${status}`,
    costSource,
    quantity: "1",
    unitCostInUsdCents: total,
    totalCostInUsdCents: total,
    status,
  });
}

async function get(query: Record<string, string>) {
  return request(app).get("/internal/stats/task-outcomes").query(query).set(getInternalAuthHeaders());
}

async function cleanup() {
  await cleanTestData([ORG_A, ORG_B]);
  // Org-less runs of this file only (never every platform run).
  await db.delete(runs).where(inArray(runs.serviceName, [SERVICE, CHILD_SERVICE]));
}

beforeAll(async () => {
  await cleanup();

  // ── "GET /v1/offers/{id}/revenue": three raw task names, two orgs + org-less.
  // Org A, completed in 1000 ms. Own actual 1.0, a child (another service) with
  // actual 2.5 and a grandchild with actual 0.5. Cancelled / provisioned /
  // refunded rows anywhere in the tree are excluded.
  const a = await run({ orgId: ORG_A, taskName: `GET /v1/offers/${OFFER_1}/revenue`, status: "completed", startedAtMs: T0, durationMs: 1000 });
  await cost(a.id, "1.0000000000");
  await cost(a.id, "9.0000000000", "cancelled");
  const child = await run({ orgId: ORG_A, serviceName: CHILD_SERVICE, taskName: "child-work", status: "completed", startedAtMs: T0 + 10, durationMs: 100, parentRunId: a.id });
  await cost(child.id, "2.5000000000", "actual", "org");
  await cost(child.id, "7.0000000000", "provisioned");
  const grandchild = await run({ orgId: ORG_A, serviceName: CHILD_SERVICE, taskName: "grandchild-work", status: "failed", startedAtMs: T0 + 20, durationMs: 50, parentRunId: child.id });
  await cost(grandchild.id, "0.5000000000");
  await cost(grandchild.id, "3.0000000000", "refunded");
  // Org B, failed, no cost at all (counts as 0 in the mean).
  await run({ orgId: ORG_B, taskName: `GET /v1/offers/${OFFER_2}/revenue`, status: "failed", startedAtMs: T0 + 1000, durationMs: 500 });
  // Org-less platform run, completed in 3000 ms, own actual 0.25. The newest of the task.
  const p = await run({ orgId: null, taskName: `GET /v1/offers/${OFFER_1}/revenue`, status: "completed", startedAtMs: T0 + 2000, durationMs: 3000 });
  await cost(p.id, "0.2500000000");

  // ── "enrichment": five runs, newest first: failed 100 ms, running, completed
  // 200 ms (actual 1.0), then two older completed 1000 ms runs (actual 100 each)
  // that a sample of 3 leaves out.
  const e1 = await run({ orgId: ORG_A, taskName: "enrichment", status: "completed", startedAtMs: T0, durationMs: 1000 });
  await cost(e1.id, "100.0000000000");
  const e2 = await run({ orgId: ORG_B, taskName: "enrichment", status: "completed", startedAtMs: T0 + 100, durationMs: 1000 });
  await cost(e2.id, "100.0000000000");
  const e3 = await run({ orgId: ORG_A, taskName: "enrichment", status: "completed", startedAtMs: T0 + 200, durationMs: 200 });
  await cost(e3.id, "1.0000000000");
  await run({ orgId: null, taskName: "enrichment", status: "running", startedAtMs: T0 + 300 });
  await run({ orgId: ORG_B, taskName: "enrichment", status: "failed", startedAtMs: T0 + 400, durationMs: 100 });
});

afterAll(async () => {
  await cleanup();
  await closeDb();
});

describe("GET /internal/stats/task-outcomes", () => {
  it("groups by normalized task fleet-wide and measures whole-subtree actual cost", async () => {
    const res = await get({ serviceName: SERVICE });
    expect(res.status).toBe(200);
    expect(res.body.serviceName).toBe(SERVICE);
    expect(res.body.sample).toBe(200);
    // Ordered by totalRunCount desc; child-service tasks never appear.
    expect(res.body.tasks.map((t: any) => t.taskName)).toEqual(["enrichment", "GET /v1/offers/{id}/revenue"]);

    expect(res.body.tasks[1]).toEqual({
      taskName: "GET /v1/offers/{id}/revenue",
      totalRunCount: 3,
      sampleSize: 3,
      completedCount: 2,
      failedCount: 1,
      runningCount: 0,
      successRate: 2 / 3,
      avgDurationMs: 2000,
      sumCompletedDurationMs: 4000,
      // (1.0 + 2.5 + 0.5) + 0 + 0.25 = 4.25 over 3 runs.
      avgCostInUsdCents: "1.4166666667",
      sumCostInUsdCents: "4.2500000000",
      lastRunAt: new Date(T0 + 2000).toISOString(),
    });

    expect(res.body.tasks[0]).toEqual({
      taskName: "enrichment",
      totalRunCount: 5,
      sampleSize: 5,
      completedCount: 3,
      failedCount: 1,
      runningCount: 1,
      successRate: 0.75,
      avgDurationMs: 733, // (1000 + 1000 + 200) / 3 = 733.33
      sumCompletedDurationMs: 2200,
      avgCostInUsdCents: "40.2000000000",
      sumCostInUsdCents: "201.0000000000",
      lastRunAt: new Date(T0 + 400).toISOString(),
    });
  });

  it("measures only the most recent `sample` runs per task, totalRunCount stays all-time", async () => {
    const res = await get({ serviceName: SERVICE, sample: "3" });
    expect(res.status).toBe(200);
    expect(res.body.sample).toBe(3);
    const enrichment = res.body.tasks.find((t: any) => t.taskName === "enrichment");
    expect(enrichment).toEqual({
      taskName: "enrichment",
      totalRunCount: 5,
      sampleSize: 3,
      completedCount: 1,
      failedCount: 1,
      runningCount: 1,
      successRate: 0.5,
      avgDurationMs: 200,
      sumCompletedDurationMs: 200,
      avgCostInUsdCents: "0.3333333333",
      sumCostInUsdCents: "1.0000000000",
      lastRunAt: new Date(T0 + 400).toISOString(),
    });
  });

  it("null rates when nothing ended or completed", async () => {
    const res = await get({ serviceName: SERVICE, sample: "1" });
    const enrichment = res.body.tasks.find((t: any) => t.taskName === "enrichment");
    // Newest enrichment run is the failed one: ended, none completed.
    expect(enrichment).toMatchObject({ sampleSize: 1, failedCount: 1, successRate: 0, avgDurationMs: null, sumCompletedDurationMs: 0, sumCostInUsdCents: "0.0000000000", avgCostInUsdCents: "0.0000000000" });
    const offers = res.body.tasks.find((t: any) => t.taskName === "GET /v1/offers/{id}/revenue");
    expect(offers).toMatchObject({ sampleSize: 1, completedCount: 1, successRate: 1, avgDurationMs: 3000, sumCostInUsdCents: "0.2500000000" });
  });

  it("a service with no runs is 200 with no tasks", async () => {
    const res = await get({ serviceName: `no-such-service-${SUFFIX}` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ serviceName: `no-such-service-${SUFFIX}`, sample: 200, tasks: [] });
  });

  it("rejects a missing serviceName or a sample out of range", async () => {
    expect((await get({})).status).toBe(400);
    expect((await get({ serviceName: "" })).status).toBe(400);
    for (const sample of ["0", "1001", "-1", "abc", "1.5"]) {
      expect((await get({ serviceName: SERVICE, sample })).status).toBe(400);
    }
    expect((await get({ serviceName: SERVICE, sample: "1000" })).status).toBe(200);
  });

  it("requires the service API key and no org header", async () => {
    const res = await request(app).get("/internal/stats/task-outcomes").query({ serviceName: SERVICE });
    expect(res.status).toBe(401);
  });
});
