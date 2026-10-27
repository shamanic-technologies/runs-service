import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { sql } from "../../src/db/index.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, closeDb } from "../helpers/test-db.js";

// RUNS-LIST-TIMEOUT-1027 (migration 0085). campaign-service's gate check reads
// GET /v1/runs?serviceName=campaign-service&taskName=<campaign id>&status=running&limit=200
// before every campaign run. On idx_runs_org_service it heap-fetched every campaign-service run
// of the org (175k for the owner org) to test task + status: 15-64 s for an empty answer, a 500
// past the statement timeout, and the campaign never ran. The read must reach the task's
// running runs through idx_runs_org_service_task_status, never a walk of the org's service runs.

const ORG_ID = "7a330000-0085-4aaa-8aaa-000000000085";
const CAMPAIGN_ID = "8d3d1ade-0085-4fef-97fb-000000000085";
const OTHER_TASKS = 400;
const RUNS_PER_OTHER_TASK = 10;

const app = createTestApp();

beforeAll(async () => {
  await cleanTestData([ORG_ID]);
  // Many campaign-service runs of the org, all of OTHER campaigns, all ended.
  await sql`
    INSERT INTO runs (organization_id, service_name, task_name, status, started_at)
    SELECT ${ORG_ID}::uuid, 'campaign-service', 'task-' || (g % ${OTHER_TASKS}),
           CASE WHEN g % 7 = 0 THEN 'failed' ELSE 'completed' END,
           now() - (g || ' seconds')::interval
    FROM generate_series(1, ${OTHER_TASKS * RUNS_PER_OTHER_TASK}) g
  `;
  await sql`ANALYZE runs`;
}, 120_000);

afterAll(async () => {
  await cleanTestData([ORG_ID]);
  await closeDb();
});

describe("GET /v1/runs — a campaign's running runs (RUNS-LIST-TIMEOUT-1027)", () => {
  it("plans the gate-check page on idx_runs_org_service_task_status, not a scan of the org's service runs", async () => {
    const plan = await sql`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM runs
      WHERE organization_id = ${ORG_ID} AND service_name = ${"campaign-service"}
        AND task_name = ${CAMPAIGN_ID} AND status = ${"running"}
      ORDER BY started_at DESC, id DESC
      LIMIT ${200}
    `;
    const text = JSON.stringify(plan);
    expect(text).toContain("idx_runs_org_service_task_status");
    expect(text).not.toContain("Seq Scan");
    expect(text).not.toContain("\"idx_runs_org_service\"");
  });

  it("answers empty when the campaign has no running run, and lists exactly its running runs otherwise", async () => {
    const path =
      `/v1/runs?serviceName=campaign-service&taskName=${CAMPAIGN_ID}&status=running&limit=200`;

    const empty = await request(app).get(path).set(getAuthHeaders({ orgId: ORG_ID }));
    expect(empty.status).toBe(200);
    expect(empty.body.runs).toEqual([]);

    await insertTestRun({ organizationId: ORG_ID, serviceName: "campaign-service", taskName: CAMPAIGN_ID, status: "completed" });
    const running = await insertTestRun({
      organizationId: ORG_ID, serviceName: "campaign-service", taskName: CAMPAIGN_ID, status: "running",
    });

    const res = await request(app).get(path).set(getAuthHeaders({ orgId: ORG_ID }));
    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual([running.id]);
  });
});
