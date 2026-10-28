import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { sql } from "../../src/db/index.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

// BOX-DB-LOAD-1027-RUNS (migration 0087). Campaign reads filtered on a service and wanting the newest
// runs (campaign-service's gate check by campaignId + serviceName + status; features-service's
// observedPicks by campaignIds + serviceName) must reach the page through
// idx_runs_campaign_service_started_cover (0088: + status, org INCLUDEd), never a heap fetch of every run of the campaign or of the org's
// service runs.

const ORG_ID = "7a330000-0087-4aaa-8aaa-000000000087";
const CAMPAIGN_ID = "c4a00000-0087-4aaa-8aaa-000000000087";
// The campaign holds 10% of the org's runs (prod: 39k of the owner org's 1M), so no org-wide walk is cheap.
const TOTAL_RUNS = 30000;

const app = createTestApp();

beforeAll(async () => {
  await cleanInChunks();
  await sql`
    INSERT INTO runs (organization_id, campaign_id, service_name, task_name, status, started_at)
    SELECT ${ORG_ID}::uuid,
           CASE WHEN g % 10 = 0 THEN ${CAMPAIGN_ID} ELSE 'other-' || (g % 40) END,
           (ARRAY['campaign-service', 'workflow', 'lead-service'])[1 + g % 3], 't', 'completed',
           now() - (g || ' seconds')::interval
    FROM generate_series(1, ${TOTAL_RUNS}) g
  `;
  await sql`VACUUM (ANALYZE) runs`;
}, 120_000);

// One DELETE of every run would take a per-run advisory lock in the audience rollup trigger
// (0052) for each of them: past max_locks_per_transaction. Delete in chunks.
async function cleanInChunks() {
  for (;;) {
    const gone = await sql`
      DELETE FROM runs WHERE id IN (SELECT id FROM runs WHERE organization_id = ${ORG_ID} LIMIT 1000) RETURNING 1
    `;
    if (gone.length === 0) break;
  }
  await cleanTestData([ORG_ID]);
}

afterAll(async () => {
  await cleanInChunks();
  await closeDb();
}, 300_000);

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
    expect(text).toContain("idx_runs_campaign_service_started_cover");
    expect(text).not.toContain("Seq Scan");
  });

  it("filters a rare status on the index tuple (index-only), not by a heap fetch per run (migration 0088)", async () => {
    const plan = await sql`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM runs
      WHERE organization_id = ${ORG_ID} AND campaign_id = ${CAMPAIGN_ID}
        AND service_name = ${"campaign-service"} AND status = ${"running"}
      ORDER BY started_at DESC, id DESC
      LIMIT ${200}
    `;
    const text = JSON.stringify(plan);
    expect(text).toContain("Index Only Scan");
    expect(text).toContain("idx_runs_campaign_service_started_cover");
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
