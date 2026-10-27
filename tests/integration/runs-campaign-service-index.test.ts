import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { sql } from "../../src/db/index.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

// BOX-DB-LOAD-1027-RUNS (migration 0087). Campaign reads filtered on a service and wanting the newest
// runs (campaign-service's gate check by campaignId + serviceName + status; features-service's
// observedPicks by campaignIds + serviceName) must reach the page through
// idx_runs_campaign_service_started, never a heap fetch of every run of the campaign or of the org's
// service runs.

const ORG_ID = "7a330000-0087-4aaa-8aaa-000000000087";
const CAMPAIGN_ID = "c4a00000-0087-4aaa-8aaa-000000000087";
const TOTAL_RUNS = 6000;

const app = createTestApp();

beforeAll(async () => {
  await cleanTestData([ORG_ID]);
  await sql`
    INSERT INTO runs (organization_id, campaign_id, service_name, task_name, status, started_at)
    SELECT ${ORG_ID}::uuid,
           CASE WHEN g % 5 = 0 THEN 'other-' || (g % 40) ELSE ${CAMPAIGN_ID} END,
           (ARRAY['campaign-service', 'workflow', 'lead-service'])[1 + g % 3], 't', 'completed',
           now() - (g || ' seconds')::interval
    FROM generate_series(1, ${TOTAL_RUNS}) g
  `;
  await sql`ANALYZE runs`;
}, 120_000);

afterAll(async () => {
  await cleanTestData([ORG_ID]);
  await closeDb();
});

describe("campaign x service reads (migration 0087)", () => {
  it("plans the gate-check page on idx_runs_campaign_service_started", async () => {
    const plan = await sql`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM runs
      WHERE organization_id = ${ORG_ID} AND campaign_id = ${CAMPAIGN_ID}
        AND service_name = ${"campaign-service"} AND status = ${"completed"}
      ORDER BY started_at DESC, id DESC
      LIMIT ${51}
    `;
    const text = JSON.stringify(plan);
    expect(text).toContain("idx_runs_campaign_service_started");
    expect(text).not.toContain("Seq Scan");
  });

  it("serves the newest runs of the campaign's service, in order", async () => {
    const res = await request(app)
      .get(`/v1/runs?campaignId=${CAMPAIGN_ID}&serviceName=campaign-service&status=completed&limit=5`)
      .set(getAuthHeaders({ orgId: ORG_ID }));
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(5);
    const expected = await sql`
      SELECT id::text FROM runs WHERE organization_id = ${ORG_ID} AND campaign_id = ${CAMPAIGN_ID}
        AND service_name = 'campaign-service' ORDER BY started_at DESC, id DESC LIMIT 5
    `;
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual(expected.map((r) => r.id));
  });
});
