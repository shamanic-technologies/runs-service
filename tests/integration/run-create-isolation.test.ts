import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { readSql } from "../../src/db/index.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, closeDb } from "../helpers/test-db.js";

// Run creation never queues behind run-tree reads (prod 2026-10-17: twenty ~55 s
// `POST /v1/runs/batch` calls held the whole write pool and a `POST /v1/runs`
// waited ~48 s, stalling the onboarding's first step). The reads have their own
// pool: with every one of its connections busy, a run is still created at once,
// and a read waits for a read connection.

const ORG_ID = "7a330000-5555-4aaa-8aaa-555555555555";
const READ_POOL_SIZE = 10;
const HOLD_SECONDS = 3;

const app = createTestApp();

beforeAll(async () => {
  await cleanTestData([ORG_ID]);
});

afterAll(async () => {
  await cleanTestData([ORG_ID]);
  await closeDb();
});

describe("run creation vs a saturated read pool", () => {
  it("creates a run while every read connection is busy, and reads wait for a read connection", async () => {
    const root = await insertTestRun({ organizationId: ORG_ID, serviceName: "lead-service", taskName: "lead-serve" });

    const holds = Array.from({ length: READ_POOL_SIZE }, () => readSql`SELECT pg_sleep(${HOLD_SECONDS})`.execute());
    // Let the holds take every read connection.
    await new Promise((r) => setTimeout(r, 300));

    const readStart = Date.now();
    const read = request(app)
      .post("/v1/runs/batch")
      .set(getAuthHeaders({ orgId: ORG_ID }))
      .send({ runIds: [root.id] })
      .then((res) => ({ res, ms: Date.now() - readStart }));

    const createStart = Date.now();
    const created = await request(app)
      .post("/v1/runs")
      .set(getAuthHeaders({ orgId: ORG_ID }))
      .send({ serviceName: "brand-service", taskName: "field-extraction" });
    const createMs = Date.now() - createStart;

    expect(created.status).toBe(201);
    expect(createMs).toBeLessThan(1000);

    const { res: readRes, ms: readMs } = await read;
    expect(readRes.status).toBe(200);
    expect(readRes.body.runs.map((r: { id: string }) => r.id)).toEqual([root.id]);
    // The read only got a connection once a hold released it.
    expect(readMs).toBeGreaterThan((HOLD_SECONDS - 1) * 1000);

    await Promise.all(holds);
  }, 20_000);
});
