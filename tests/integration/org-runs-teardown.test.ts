import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db, sql } from "../../src/db/index.js";
import {
  costLifecycleEvents,
  runEvents,
  runLifecycleEvents,
  runs,
  runsCosts,
} from "../../src/db/schema.js";

const ORG_ID = "55555555-5555-4555-a555-555555555555";
const OTHER_ORG_ID = "66666666-6666-4666-a666-666666666666";
const EMPTY_ORG_ID = "77777777-7777-4777-a777-777777777777";
const ORPHAN_RUN_ID = "88888888-8888-4888-a888-888888888888";
const ORG_IDS = [ORG_ID, OTHER_ORG_ID, EMPTY_ORG_ID];

async function cleanBronzeData() {
  await sql`
    DELETE FROM cost_lifecycle_events
     WHERE identity->>'orgId' = ANY(${ORG_IDS})
  `;
  await sql`
    DELETE FROM run_lifecycle_events
     WHERE identity->>'orgId' = ANY(${ORG_IDS})
        OR payload->>'organizationId' = ANY(${ORG_IDS})
  `;
}

describe("DELETE /internal/runs/by-org/:orgId", () => {
  const app = createTestApp();
  const headers = getInternalAuthHeaders();

  beforeEach(async () => {
    await cleanBronzeData();
    await cleanTestData(ORG_IDS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanBronzeData();
    await cleanTestData(ORG_IDS);
    await closeDb();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).delete(`/internal/runs/by-org/${ORG_ID}`);

    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid org UUID", async () => {
    const res = await request(app)
      .delete("/internal/runs/by-org/not-a-uuid")
      .set(headers);

    expect(res.status).toBe(400);
  });

  it("deletes org-scoped run, cost, run-event, and bronze lifecycle state", async () => {
    const run1 = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc",
      taskName: "task-1",
      status: "completed",
    });
    const run2 = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc",
      taskName: "task-2",
      status: "failed",
    });
    const otherRun = await insertTestRun({
      organizationId: OTHER_ORG_ID,
      serviceName: "svc",
      taskName: "other",
      status: "completed",
    });

    const cost1 = await insertTestRunCost({
      runId: run1.id,
      costName: "openai-input",
      quantity: "1",
      unitCostInUsdCents: "2.0000000000",
      totalCostInUsdCents: "2.0000000000",
    });
    await insertTestRunCost({
      runId: run2.id,
      costName: "openai-output",
      quantity: "1",
      unitCostInUsdCents: "3.0000000000",
      totalCostInUsdCents: "3.0000000000",
    });
    const otherCost = await insertTestRunCost({
      runId: otherRun.id,
      costName: "openai-input",
      quantity: "1",
      unitCostInUsdCents: "4.0000000000",
      totalCostInUsdCents: "4.0000000000",
    });

    await db.insert(runEvents).values([
      { runId: run1.id, service: "svc", event: "step.done", detail: "done", level: "info", orgId: ORG_ID },
      { runId: otherRun.id, service: "svc", event: "step.done", detail: "done", level: "info", orgId: OTHER_ORG_ID },
    ]);

    await db.insert(runLifecycleEvents).values([
      { runId: run1.id, eventType: "run.completed", payload: { reason: "test" }, identity: { orgId: ORG_ID } },
      {
        runId: ORPHAN_RUN_ID,
        eventType: "run.failed",
        payload: { organizationId: ORG_ID },
        identity: { orgId: ORG_ID },
      },
      {
        runId: otherRun.id,
        eventType: "run.completed",
        payload: { reason: "test" },
        identity: { orgId: OTHER_ORG_ID },
      },
    ]);

    await db.insert(costLifecycleEvents).values([
      {
        runId: run1.id,
        costId: cost1.id,
        eventType: "cost.materialized",
        payload: { reason: "test" },
        identity: { orgId: ORG_ID },
      },
      {
        runId: otherRun.id,
        costId: otherCost.id,
        eventType: "cost.materialized",
        payload: { reason: "test" },
        identity: { orgId: OTHER_ORG_ID },
      },
    ]);

    const res = await request(app).delete(`/internal/runs/by-org/${ORG_ID}`).set(headers);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orgId: ORG_ID,
      deleted: {
        runs: 2,
        costs: 2,
        runEvents: 1,
        runLifecycleEvents: 2,
        costLifecycleEvents: 1,
      },
    });

    expect(await db.select({ id: runs.id }).from(runs).where(eq(runs.organizationId, ORG_ID))).toHaveLength(0);
    expect(
      await db.select({ id: runsCosts.id }).from(runsCosts).where(inArray(runsCosts.runId, [run1.id, run2.id]))
    ).toHaveLength(0);
    expect(await db.select({ id: runEvents.id }).from(runEvents).where(eq(runEvents.runId, run1.id))).toHaveLength(0);
    expect(
      await db
        .select({ id: runLifecycleEvents.id })
        .from(runLifecycleEvents)
        .where(inArray(runLifecycleEvents.runId, [run1.id, ORPHAN_RUN_ID]))
    ).toHaveLength(0);
    expect(
      await db.select({ id: costLifecycleEvents.id }).from(costLifecycleEvents).where(eq(costLifecycleEvents.runId, run1.id))
    ).toHaveLength(0);

    expect(await db.select({ id: runs.id }).from(runs).where(eq(runs.id, otherRun.id))).toHaveLength(1);
    expect(await db.select({ id: runsCosts.id }).from(runsCosts).where(eq(runsCosts.id, otherCost.id))).toHaveLength(1);
    expect(await db.select({ id: runEvents.id }).from(runEvents).where(eq(runEvents.runId, otherRun.id))).toHaveLength(1);
    expect(
      await db.select({ id: runLifecycleEvents.id }).from(runLifecycleEvents).where(eq(runLifecycleEvents.runId, otherRun.id))
    ).toHaveLength(1);
    expect(
      await db.select({ id: costLifecycleEvents.id }).from(costLifecycleEvents).where(eq(costLifecycleEvents.runId, otherRun.id))
    ).toHaveLength(1);

    const second = await request(app).delete(`/internal/runs/by-org/${ORG_ID}`).set(headers);
    expect(second.status).toBe(200);
    expect(second.body.deleted).toEqual({
      runs: 0,
      costs: 0,
      runEvents: 0,
      runLifecycleEvents: 0,
      costLifecycleEvents: 0,
    });
  });

  it("succeeds when the org has no runs or lifecycle rows", async () => {
    const res = await request(app).delete(`/internal/runs/by-org/${EMPTY_ORG_ID}`).set(headers);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orgId: EMPTY_ORG_ID,
      deleted: {
        runs: 0,
        costs: 0,
        runEvents: 0,
        runLifecycleEvents: 0,
        costLifecycleEvents: 0,
      },
    });
  });

  it("returns non-2xx when the database operation fails", async () => {
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("database unavailable") as never);

    const res = await request(app).delete(`/internal/runs/by-org/${ORG_ID}`).set(headers);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
  });
});
