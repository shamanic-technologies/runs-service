import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, sql } from "../../src/db/index.js";
import { runEvents } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { cleanTestData, insertTestRun, closeDb } from "../helpers/test-db.js";
import {
  purgeExpiredRunEvents,
  RUN_EVENTS_RETENTION_DAYS,
} from "../../src/services/run-events-retention.js";

const ORG_ID = "3a7f1c22-9b41-4d5e-8f0a-6c2d9e13b7a4";

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function insertEvent(runId: string, createdAt: Date, event: string) {
  const [row] = await db
    .insert(runEvents)
    .values({ runId, service: "test-service", event, orgId: ORG_ID, createdAt })
    .returning();
  return row;
}

describe("run_events retention", () => {
  beforeEach(async () => {
    await cleanTestData([ORG_ID]);
    await sql`DELETE FROM run_lifecycle_events WHERE source_service = 'retention-test'`;
  });

  afterAll(async () => {
    await cleanTestData([ORG_ID]);
    await sql`DELETE FROM run_lifecycle_events WHERE source_service = 'retention-test'`;
    await closeDb();
  });

  it("deletes telemetry older than the retention window and keeps the rest", async () => {
    const run = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "test-service",
      taskName: "retention",
    });

    const expiredA = await insertEvent(run.id, daysAgo(RUN_EVENTS_RETENTION_DAYS + 1), "expired-a");
    const expiredB = await insertEvent(run.id, daysAgo(365), "expired-b");
    const kept = await insertEvent(run.id, daysAgo(RUN_EVENTS_RETENTION_DAYS - 1), "kept");
    const fresh = await insertEvent(run.id, new Date(), "fresh");

    const result = await purgeExpiredRunEvents();

    expect(result.deleted).toBeGreaterThanOrEqual(2);
    expect(result.hitChunkCap).toBe(false);

    const remaining = await db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(eq(runEvents.runId, run.id));
    const remainingIds = remaining.map((r) => r.id).sort();
    expect(remainingIds).toEqual([kept.id, fresh.id].sort());
    expect(remainingIds).not.toContain(expiredA.id);
    expect(remainingIds).not.toContain(expiredB.id);
  });

  it("never touches the bronze lifecycle log, at any age", async () => {
    // The lifecycle log is what silver is projected FROM — purging it would
    // destroy the ability to rebuild runs / runs_costs.
    const run = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "test-service",
      taskName: "retention-lifecycle",
    });
    await insertEvent(run.id, daysAgo(400), "expired-telemetry");

    // 'run.completed' rather than 'run.created': the projection trigger fires on
    // insert, and a synthetic 'run.created' would try to project a row with no
    // service_name. This one just re-stamps the status of the run we made above.
    await sql`
      INSERT INTO run_lifecycle_events (run_id, event_type, payload, source_service, occurred_at)
      VALUES (${run.id}, 'run.completed', '{}'::jsonb, 'retention-test', ${daysAgo(400).toISOString()}::timestamptz)
    `;

    const costsBefore = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM cost_lifecycle_events`;

    await purgeExpiredRunEvents();

    const lifecycle = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM run_lifecycle_events WHERE source_service = 'retention-test'
    `;
    expect(lifecycle[0].count).toBe("1");

    // The sweep must not reach the cost lifecycle log either, at any age.
    const costsAfter = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM cost_lifecycle_events`;
    expect(costsAfter[0].count).toBe(costsBefore[0].count);
  });

  it("is idempotent — a second sweep deletes nothing", async () => {
    const run = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "test-service",
      taskName: "retention-idempotent",
    });
    await insertEvent(run.id, daysAgo(90), "expired");

    await purgeExpiredRunEvents();
    const second = await purgeExpiredRunEvents();

    expect(second.deleted).toBe(0);
    expect(second.chunks).toBe(1);
  });

  it("honours an explicit retention window", async () => {
    const run = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "test-service",
      taskName: "retention-window",
    });
    const twoDaysOld = await insertEvent(run.id, daysAgo(2), "two-days-old");

    // 30-day window keeps it...
    await purgeExpiredRunEvents();
    let remaining = await db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(eq(runEvents.runId, run.id));
    expect(remaining.map((r) => r.id)).toEqual([twoDaysOld.id]);

    // ...a 1-day window does not.
    await purgeExpiredRunEvents(sql, 1);
    remaining = await db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(eq(runEvents.runId, run.id));
    expect(remaining).toEqual([]);
  });
});
