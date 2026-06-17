import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  runEvents,
  runLifecycleEvents,
  runs,
  runsCosts,
} from "../../src/db/schema.js";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";

const ORG_ID = "99999999-1111-4999-a999-111111111111";
const OTHER_ORG_ID = "99999999-2222-4999-a999-222222222222";
const ORG_IDS = [ORG_ID, OTHER_ORG_ID];

async function cleanBronze() {
  await db.execute(sql`
    DELETE FROM run_lifecycle_events
     WHERE identity->>'orgId' IN (${ORG_ID}, ${OTHER_ORG_ID})
        OR payload->>'organizationId' IN (${ORG_ID}, ${OTHER_ORG_ID})
  `);
  await db.execute(sql`
    DELETE FROM cost_lifecycle_events
     WHERE identity->>'orgId' IN (${ORG_ID}, ${OTHER_ORG_ID})
  `);
}

async function runCount(orgId: string) {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(runs)
    .where(eq(runs.organizationId, orgId));
  return row.count;
}

describe("DELETE /internal/runs/by-org/:orgId", () => {
  const app = createTestApp();
  const headers = getInternalAuthHeaders();

  beforeEach(async () => {
    await cleanTestData(ORG_IDS);
    await cleanBronze();
  });

  afterAll(async () => {
    await cleanTestData(ORG_IDS);
    await cleanBronze();
    await closeDb();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).delete(`/internal/runs/by-org/${ORG_ID}`);

    expect(res.status).toBe(401);
  });

  it("returns 400 when orgId is invalid", async () => {
    const res = await request(app)
      .delete("/internal/runs/by-org/not-a-uuid")
      .set(headers);

    expect(res.status).toBe(400);
  });

  it("tombstones org runs and removes live run/cost/event state", async () => {
    const parent = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "client-service",
      taskName: "org-delete-parent",
      status: "completed",
    });
    const child = await insertTestRun({
      organizationId: ORG_ID,
      parentRunId: parent.id,
      serviceName: "lead-service",
      taskName: "org-delete-child",
      status: "completed",
    });
    await insertTestRunCost({
      runId: parent.id,
      costName: "parent-cost",
      quantity: "1",
      unitCostInUsdCents: "1.0000000000",
      totalCostInUsdCents: "1.0000000000",
    });
    await insertTestRunCost({
      runId: child.id,
      costName: "child-cost",
      quantity: "1",
      unitCostInUsdCents: "2.0000000000",
      totalCostInUsdCents: "2.0000000000",
    });
    await db.insert(runEvents).values({
      runId: parent.id,
      service: "client-service",
      event: "org-delete-started",
      orgId: ORG_ID,
    });

    const otherRun = await insertTestRun({
      organizationId: OTHER_ORG_ID,
      serviceName: "client-service",
      taskName: "other-org-run",
      status: "completed",
    });
    await insertTestRunCost({
      runId: otherRun.id,
      costName: "other-cost",
      quantity: "1",
      unitCostInUsdCents: "9.0000000000",
      totalCostInUsdCents: "9.0000000000",
    });

    const beforeUsage = await request(app)
      .get("/internal/org-usage-total")
      .set(headers)
      .query({ org_id: ORG_ID });
    expect(beforeUsage.body.spent_cents).toBe("3.0000000000");

    const res = await request(app)
      .delete(`/internal/runs/by-org/${ORG_ID}`)
      .set({ ...headers, "x-service-name": "client-service" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orgId: ORG_ID, deletedRuns: 2, tombstoneEvents: 2 });

    expect(await runCount(ORG_ID)).toBe("0");
    expect(await runCount(OTHER_ORG_ID)).toBe("1");

    const deletedCosts = await db
      .select()
      .from(runsCosts)
      .where(inArray(runsCosts.runId, [parent.id, child.id]));
    expect(deletedCosts).toHaveLength(0);

    const deletedEvents = await db
      .select()
      .from(runEvents)
      .where(inArray(runEvents.runId, [parent.id, child.id]));
    expect(deletedEvents).toHaveLength(0);

    const tombstones = await db
      .select()
      .from(runLifecycleEvents)
      .where(inArray(runLifecycleEvents.runId, [parent.id, child.id]));
    expect(tombstones.map((event) => event.eventType).sort()).toEqual([
      "run.org_deleted",
      "run.org_deleted",
    ]);
    expect(tombstones.every((event) => event.sourceService === "client-service")).toBe(true);

    const afterUsage = await request(app)
      .get("/internal/org-usage-total")
      .set(headers)
      .query({ org_id: ORG_ID });
    expect(afterUsage.body.spent_cents).toBe("0.0000000000");
  });

  it("is idempotent when the org has no runs", async () => {
    const first = await request(app).delete(`/internal/runs/by-org/${ORG_ID}`).set(headers);
    const second = await request(app).delete(`/internal/runs/by-org/${ORG_ID}`).set(headers);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual({ orgId: ORG_ID, deletedRuns: 0, tombstoneEvents: 0 });
    expect(second.body).toEqual({ orgId: ORG_ID, deletedRuns: 0, tombstoneEvents: 0 });
  });

  it("fails loud and rolls back when a run cannot be deleted", async () => {
    const parent = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "client-service",
      taskName: "parent-with-external-child",
    });
    await insertTestRun({
      organizationId: OTHER_ORG_ID,
      parentRunId: parent.id,
      serviceName: "client-service",
      taskName: "cross-org-child",
    });

    const res = await request(app).delete(`/internal/runs/by-org/${ORG_ID}`).set(headers);

    expect(res.status).toBe(500);
    expect(await runCount(ORG_ID)).toBe("1");

    const tombstones = await db
      .select()
      .from(runLifecycleEvents)
      .where(eq(runLifecycleEvents.runId, parent.id));
    expect(tombstones).toHaveLength(0);
  });
});
