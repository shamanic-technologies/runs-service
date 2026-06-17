import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  runs,
  runsCosts,
  runEvents,
  runLifecycleEvents,
  costLifecycleEvents,
} from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestRun,
  insertTestRunCost,
  closeDb,
} from "../helpers/test-db.js";

const ORG_ID = "12121212-1212-4121-a121-121212121212";
const OTHER_ORG_ID = "34343434-3434-4343-a343-343434343434";
const ORG_IDS = [ORG_ID, OTHER_ORG_ID];

async function cleanOrgBronze() {
  await db.execute(sql`
    WITH org_run_ids AS (
      SELECT run_id
        FROM run_lifecycle_events
       WHERE identity->>'orgId' IN (${ORG_ID}, ${OTHER_ORG_ID})
          OR payload->>'organizationId' IN (${ORG_ID}, ${OTHER_ORG_ID})
          OR payload->>'orgId' IN (${ORG_ID}, ${OTHER_ORG_ID})
    )
    DELETE FROM cost_lifecycle_events
     WHERE run_id IN (SELECT run_id FROM org_run_ids)
        OR identity->>'orgId' IN (${ORG_ID}, ${OTHER_ORG_ID})
        OR payload->>'organizationId' IN (${ORG_ID}, ${OTHER_ORG_ID})
        OR payload->>'orgId' IN (${ORG_ID}, ${OTHER_ORG_ID})
  `);

  await db.execute(sql`
    DELETE FROM run_lifecycle_events
     WHERE identity->>'orgId' IN (${ORG_ID}, ${OTHER_ORG_ID})
        OR payload->>'organizationId' IN (${ORG_ID}, ${OTHER_ORG_ID})
        OR payload->>'orgId' IN (${ORG_ID}, ${OTHER_ORG_ID})
  `);
}

async function insertBronzeForRun(runId: string, costId: string) {
  await db.insert(runLifecycleEvents).values({
    runId,
    eventType: "run.created",
    payload: {
      runId,
      parentRunId: null,
      organizationId: ORG_ID,
      userId: null,
      brandIds: null,
      campaignId: null,
      workflowSlug: null,
      featureSlug: null,
      serviceName: "teardown-test",
      taskName: "tracked-run",
      idempotencyKey: null,
    },
    identity: { orgId: ORG_ID },
  });

  await db.insert(costLifecycleEvents).values({
    runId,
    costId,
    eventType: "cost.added",
    payload: {
      costId,
      costName: "tokens",
      costSource: "platform",
      quantity: "1",
      unitCostInUsdCents: "1.0000000000",
      totalCostInUsdCents: "1.0000000000",
      status: "actual",
      idempotencyKey: null,
    },
    identity: { orgId: ORG_ID },
  });
}

describe("DELETE /internal/runs/by-org/:orgId", () => {
  const app = createTestApp();
  const internalHeaders = getInternalAuthHeaders();
  const orgHeaders = getAuthHeaders({ orgId: ORG_ID });

  beforeEach(async () => {
    await cleanTestData(ORG_IDS);
    await cleanOrgBronze();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanTestData(ORG_IDS);
    await cleanOrgBronze();
    await closeDb();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).delete(`/internal/runs/by-org/${ORG_ID}`);

    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid org UUID", async () => {
    const res = await request(app)
      .delete("/internal/runs/by-org/not-a-uuid")
      .set(internalHeaders);

    expect(res.status).toBe(400);
  });

  it("returns success for an org with no run state", async () => {
    const res = await request(app)
      .delete(`/internal/runs/by-org/${ORG_ID}`)
      .set(internalHeaders);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orgId: ORG_ID,
      tombstonedRuns: 0,
      deletedRuns: 0,
    });
  });

  it("tombstones bronze and removes current run, cost, and event projections for the org", async () => {
    const run = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "teardown-test",
      taskName: "tracked-run",
      status: "completed",
    });
    const cost = await insertTestRunCost({
      runId: run.id,
      costName: "tokens",
      quantity: "1",
      unitCostInUsdCents: "1.0000000000",
      totalCostInUsdCents: "1.0000000000",
      status: "actual",
    });
    await insertBronzeForRun(run.id, cost.id);

    const eventRes = await request(app)
      .post(`/v1/runs/${run.id}/events`)
      .set(orgHeaders)
      .send({ service: "teardown-test", event: "progress", detail: "started" });
    expect(eventRes.status).toBe(201);

    const beforeUsage = await request(app)
      .get("/internal/org-usage-total")
      .set(internalHeaders)
      .query({ org_id: ORG_ID });
    expect(beforeUsage.body.spent_cents).toBe("1.0000000000");

    const res = await request(app)
      .delete(`/internal/runs/by-org/${ORG_ID}`)
      .set(internalHeaders);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orgId: ORG_ID,
      tombstonedRuns: 1,
      deletedRuns: 1,
    });

    const afterUsage = await request(app)
      .get("/internal/org-usage-total")
      .set(internalHeaders)
      .query({ org_id: ORG_ID });
    expect(afterUsage.body.spent_cents).toBe("0.0000000000");

    const runRows = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(runRows).toHaveLength(0);

    const costRows = await db.select().from(runsCosts).where(eq(runsCosts.runId, run.id));
    expect(costRows).toHaveLength(0);

    const eventRows = await db.select().from(runEvents).where(eq(runEvents.runId, run.id));
    expect(eventRows).toHaveLength(0);

    const tombstones = await db
      .select()
      .from(runLifecycleEvents)
      .where(and(eq(runLifecycleEvents.runId, run.id), eq(runLifecycleEvents.eventType, "run.org_teardown")));
    expect(tombstones).toHaveLength(1);

    const retainedCostEvents = await db
      .select()
      .from(costLifecycleEvents)
      .where(eq(costLifecycleEvents.runId, run.id));
    expect(retainedCostEvents).toHaveLength(1);
  });

  it("is safe to retry after a successful teardown", async () => {
    const run = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "teardown-test",
      taskName: "retry-run",
    });
    const cost = await insertTestRunCost({
      runId: run.id,
      costName: "tokens",
      quantity: "1",
      unitCostInUsdCents: "1.0000000000",
      totalCostInUsdCents: "1.0000000000",
    });
    await insertBronzeForRun(run.id, cost.id);

    const first = await request(app)
      .delete(`/internal/runs/by-org/${ORG_ID}`)
      .set(internalHeaders);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ tombstonedRuns: 1, deletedRuns: 1 });

    const second = await request(app)
      .delete(`/internal/runs/by-org/${ORG_ID}`)
      .set(internalHeaders);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      orgId: ORG_ID,
      tombstonedRuns: 0,
      deletedRuns: 0,
    });

    const tombstones = await db
      .select()
      .from(runLifecycleEvents)
      .where(and(eq(runLifecycleEvents.runId, run.id), eq(runLifecycleEvents.eventType, "run.org_teardown")));
    expect(tombstones).toHaveLength(1);
  });

  it("returns non-2xx when the DB operation fails", async () => {
    vi.spyOn(db, "transaction").mockImplementationOnce((async () => {
      throw new Error("boom");
    }) as any);

    const res = await request(app)
      .delete(`/internal/runs/by-org/${ORG_ID}`)
      .set(internalHeaders);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});
