import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";

// A run tree of 150,000+ runs (content-generation backfill,
// 2026-10-24): POST /v1/runs/batch and GET /v1/runs/:id threw
// "Maximum call stack size exceeded" building one SQL fragment per descendant id.

const ORG = "0c05acc0-1024-4c0a-8b1e-0000000000d1";
const N = 5_000;
const app = createTestApp();

describe("Run tree reads on a very large tree", () => {
  let rootId: string;

  beforeAll(async () => {
    await cleanTestData([ORG]);
    const root = await insertTestRun({ organizationId: ORG, serviceName: "content-generation-service", taskName: "generate", status: "completed" });
    rootId = root.id;
    await db.execute(sql`
      INSERT INTO runs (id, organization_id, service_name, task_name, status, parent_run_id, started_at)
      SELECT gen_random_uuid(), ${ORG}::uuid, 'chat-service', 'complete', 'completed', ${rootId}::uuid, now()
      FROM generate_series(1, ${N})
    `);
  }, 120_000);

  afterAll(async () => {
    // Children first, chunked: the rollup triggers take a lock per deleted run.
    for (;;) {
      const gone = (await db.execute(sql`
        DELETE FROM runs WHERE id IN (SELECT id FROM runs WHERE organization_id = ${ORG}::uuid AND parent_run_id IS NOT NULL LIMIT 2000) RETURNING id
      `)) as any[];
      if (gone.length === 0) break;
    }
    await cleanTestData([ORG]);
    await closeDb();
  }, 120_000);

  it("POST /v1/runs/batch answers for a root with 5,000 descendants (the ANY-array reads end to end; size limit: tests/unit/uuid-array.test.ts)", async () => {
    const res = await request(app).post("/v1/runs/batch").set(getAuthHeaders({ orgId: ORG })).send({ runIds: [rootId] });
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].descendantRuns).toHaveLength(N);
  }, 120_000);

  it("GET /v1/runs/:id answers for the same root", async () => {
    const res = await request(app).get(`/v1/runs/${rootId}`).set(getAuthHeaders({ orgId: ORG }));
    expect(res.status).toBe(200);
  }, 120_000);
});
