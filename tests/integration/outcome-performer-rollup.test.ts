import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { PERFORMER_ROLLUP_NAME, rebuildPerformerDayRollup } from "../../src/services/outcome-performers.js";

// LEDGER-LOAD-1107-RUNS: GET /internal/stats/outcome-performers from stats_rollup_performer_day
// (migration 0106). Through every write that moves an entry (declare, relabel / redate / performer
// change, void, reversal, a run's tags moving, a run deleted), the rollup body == the live body.

const app = createTestApp();
const ORG = "0c05acc0-1107-4c0a-8b1e-0000000000d1";
const ORG_B = "0c05acc0-1107-4c0a-8b1e-0000000000d2";
const SINCE = "2026-03-01";
const UNTIL = "2026-03-10";
const at = (d: number, h = 10) => `2026-03-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`;

const QUERIES = [
  "groupBy=outcomeKey,serviceName",
  "groupBy=outcomeKey,performerKind,workflowSlug",
  "groupBy=day,outcomeKey",
  "groupBy=brandId,campaignId,performerBasis,performerName",
  "groupBy=orgId,featureSlug,taskName",
  `groupBy=outcomeKey&orgId=${ORG}`,
  "groupBy=outcomeKey,brandId&brandId=brand-p1",
  "groupBy=outcomeKey&campaignId=cmp-p1",
  "groupBy=day&performerKind=none",
  "groupBy=day&performerKind=client_team",
  "groupBy=outcomeKey&workflowSlug=wf-p1",
  "groupBy=outcomeKey&outcomeKey=meeting_booked",
];

async function body(q: string, rollup: boolean) {
  if (!rollup) process.env.PERFORMER_ROLLUP = "off";
  try {
    const res = await request(app).get(`/internal/stats/outcome-performers?since=${SINCE}&until=${UNTIL}&${q}`).set(getInternalAuthHeaders());
    expect(res.status, res.text).toBe(200);
    return res.text;
  } finally {
    delete process.env.PERFORMER_ROLLUP;
  }
}

async function expectParity(step: string) {
  for (const q of QUERIES) expect(await body(q, true), `${step}: ${q}`).toBe(await body(q, false));
}

async function occ(runId: string, key: string, day: number, opts: { performer?: [string, string | null, string | null]; quantity?: string; direction?: string } = {}) {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO run_outcomes (id, run_id, direction, outcome_key, subject_service, subject_id, quantity, declared_at, recorded_at,
      performer_kind, performer_workflow_slug, performer_name)
    VALUES (${id}::uuid, ${runId}::uuid, ${opts.direction ?? "produced"}, ${key}, 'lead-service', ${randomUUID()}, ${opts.quantity ?? "1"},
      ${at(day)}::timestamptz, ${at(day)}::timestamptz, ${opts.performer?.[0] ?? null}, ${opts.performer?.[1] ?? null}, ${opts.performer?.[2] ?? null})
  `);
  return id;
}

describe("outcome performers rollup == live read (LEDGER-LOAD-1107-RUNS)", () => {
  let r1: string, r2: string, r3: string, r4: string;
  const ids: string[] = [];

  beforeAll(async () => {
    await cleanTestData([ORG, ORG_B]);
    // global-setup emptied run_outcomes and the rollup together: exact from here, stamp it.
    await db.execute(sql`INSERT INTO stats_rollups (name, ready_at) VALUES (${PERFORMER_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`);
    const started = new Date(`${SINCE}T00:00:00Z`);
    r1 = (await insertTestRun({ organizationId: ORG, serviceName: "lead-service", taskName: "outcome-recording", brandIds: ["brand-p1", "brand-p2"], campaignId: "cmp-p1", workflowSlug: "wf-p1", featureSlug: "feat-p", status: "completed", startedAt: started })).id;
    r2 = (await insertTestRun({ organizationId: ORG, serviceName: "instantly-service", taskName: "send", brandIds: ["brand-p1"], status: "completed", startedAt: started })).id;
    r3 = (await insertTestRun({ organizationId: ORG_B, serviceName: "social-service", taskName: "post", status: "completed", startedAt: started })).id;
    r4 = (await insertTestRun({ organizationId: null, serviceName: "human-service", taskName: "refill", workflowSlug: "wf-p2", status: "completed", startedAt: started })).id;
  });

  afterAll(async () => {
    await cleanTestData([ORG, ORG_B]);
    await db.execute(sql`DELETE FROM runs WHERE id = ${r4}::uuid`);
    await closeDb();
  });

  it("declarations, one statement or many", async () => {
    ids.push(await occ(r1, "meeting_booked", 2));
    ids.push(await occ(r1, "meeting_booked", 2, { performer: ["client_team", null, "hubspot"] }));
    ids.push(await occ(r1, "lead_found", 3, { quantity: "2.5" }));
    ids.push(await occ(r2, "message_sent", 3, { performer: ["script", "wf-x", null] }));
    ids.push(await occ(r2, "message_sent", 4));
    ids.push(await occ(r3, "linkedin_post_published", 5, { performer: ["platform", null, "social-service"] }));
    ids.push(await occ(r4, "lead_found", 6));
    await occ(r1, "lead_found", 6, { direction: "consumed" });
    // one multi-row statement (the projection's shape)
    await db.execute(sql`
      INSERT INTO run_outcomes (id, run_id, direction, outcome_key, subject_service, subject_id, quantity, declared_at)
      SELECT gen_random_uuid(), ${r2}::uuid, 'produced', 'message_sent', 'lead-service', 's-' || g, 1, ${at(7)}::timestamptz + g * interval '1 minute'
      FROM generate_series(1, 30) g
    `);
    await expectParity("declared");
    const n = (await db.execute(sql`SELECT count(*)::int AS n FROM stats_rollup_performer_day`)) as any[];
    expect(n[0].n).toBeGreaterThan(5);
  });

  it("relabel, redate, performer stated / corrected", async () => {
    await db.execute(sql`UPDATE run_outcomes SET outcome_key = 'email_sent' WHERE id = ${ids[4]}::uuid`);
    await db.execute(sql`UPDATE run_outcomes SET declared_at = ${at(1)}::timestamptz WHERE id = ${ids[2]}::uuid`);
    await db.execute(sql`UPDATE run_outcomes SET performer_kind = 'crm', performer_name = 'pipedrive' WHERE id = ${ids[0]}::uuid`);
    await db.execute(sql`UPDATE run_outcomes SET performer_kind = 'mailbox', performer_workflow_slug = NULL WHERE id = ${ids[3]}::uuid`);
    await expectParity("updated");
  });

  it("reversals: -1 on the reversal day; an updated reversed occurrence moves both entries", async () => {
    await db.execute(sql`
      INSERT INTO run_outcome_reversals (occurrence_id, run_id, reversed_at, recorded_at, reason, reversed_by)
      VALUES (${ids[1]}::uuid, ${r1}::uuid, ${at(8)}::timestamptz, now(), 'sale withdrawn', 'test'),
             (${ids[5]}::uuid, ${r3}::uuid, ${at(9)}::timestamptz, now(), 'post removed', 'test')
    `);
    await expectParity("reversed");
    await db.execute(sql`UPDATE run_outcomes SET outcome_key = 'paid_client' WHERE id = ${ids[1]}::uuid`);
    await expectParity("reversed occurrence relabelled");
  });

  it("a run's tags move (brand transfer, feature correction)", async () => {
    await db.execute(sql`UPDATE runs SET organization_id = ${ORG_B}::uuid, brand_ids = ARRAY['brand-p3'] WHERE id = ${r1}::uuid`);
    await db.execute(sql`UPDATE runs SET feature_slug = 'feat-q', workflow_slug = 'wf-p1' WHERE id = ${r2}::uuid`);
    await db.execute(sql`UPDATE runs SET status = 'failed' WHERE id = ${r3}::uuid`);
    await expectParity("run moved");
  });

  it("a void (occurrences deleted, the reversal cascades) and a run deleted", async () => {
    await db.execute(sql`DELETE FROM run_outcomes WHERE run_id = ${r1}::uuid`);
    await expectParity("voided");
    await db.execute(sql`DELETE FROM runs WHERE id = ${r3}::uuid`);
    await expectParity("run deleted");
    const zero = (await db.execute(sql`
      SELECT COALESCE(SUM(n), 0)::int AS n FROM stats_rollup_performer_day WHERE organization_id = ${ORG_B}::uuid AND service_name = 'social-service'
    `)) as any[];
    expect(zero[0].n).toBe(0);
  });

  it("concurrent declarations on one group count once each", async () => {
    await Promise.all(Array.from({ length: 20 }, () => occ(r2, "message_sent", 10)));
    await expectParity("concurrent");
  });

  it("a rebuild lands on the same rows the triggers kept", async () => {
    const rows = async () =>
      (await db.execute(sql`
        SELECT day::text, outcome_key, organization_id::text, brand_ids::text, campaign_id, feature_slug, service_name, task_name,
               performer_kind, performer_basis, performer_workflow_slug, performer_name, n::text, quantity::text
        FROM stats_rollup_performer_day WHERE n <> 0 OR quantity <> 0 ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
      `)) as any[];
    const kept = await rows();
    await rebuildPerformerDayRollup(process.env.RUNS_SERVICE_DATABASE_URL!);
    expect((await rows()).map((r) => JSON.stringify({ ...r, quantity: Number(r.quantity) }))).toEqual(kept.map((r) => JSON.stringify({ ...r, quantity: Number(r.quantity) })));
    await expectParity("rebuilt");
  });
});
