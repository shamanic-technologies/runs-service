import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";

// RUN-DOOR-DECLARER-1110: a producer (B) called through a run door declares Units on the CALLER's
// run (A, e.g. a workflow script run) over the ORG route. Prod 2026-11-10: scraping-service declared
// 29 backlink_earned Units on a workflow run with x-service-name: scraping-service, runs-service
// recorded the declarer as `workflow`, and scraping-service could neither reverse nor scoped-void them.
// Now B is the declarer; A (the run's owner) keeps holding those rows as before; a third service C is refused.

const ORG = "0c05acc0-1110-4c0a-8b1e-000000001110";
const KEY = "backlink_earned";

const stepCatalogue = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/outcome-catalogue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/outcome-catalogue.js")>();
  return { ...actual, unknownOutcomeKeys: stepCatalogue.fn };
});

const app = createTestApp();
const A = "workflow";
const B = "scraping-service";
const C = "instantly-service";

const unit = (subjectId: string) => ({ outcomeKey: KEY, subjectService: B, subjectId });
const orgAs = (serviceName?: string) => ({ ...getAuthHeaders({ orgId: ORG }), ...(serviceName && { "x-service-name": serviceName }) });
const declareOrg = (runId: string, serviceName: string | undefined, subjects: string[]) =>
  request(app).post(`/v1/runs/${runId}/outcomes`).set(orgAs(serviceName)).send({ produced: subjects.map(unit) });
const reverse = (serviceName: string, runId: string, subjectId: string) =>
  request(app)
    .post("/v1/platform-runs/outcomes/reversals")
    .set(getPlatformAuthHeaders({ serviceName }))
    .send({ reversedBy: `${serviceName} test`, reversals: [{ runId, outcomeKey: KEY, subjectService: B, subjectId, reason: "not an earned backlink" }] });
const scopedVoid = (serviceName: string, runId: string) =>
  request(app)
    .post(`/v1/runs/${runId}/outcomes/void`)
    .set(orgAs(serviceName))
    .send({ reason: "wrong Units", voidedBy: `${serviceName} test`, scope: { direction: "produced", outcomeKey: KEY } });
const ownerRun = () => insertTestRun({ organizationId: ORG, serviceName: A, taskName: "script:backlink_earned/test", status: "completed" });
const liveSubjects = async (runId: string) =>
  ((await db.execute(sql`
    SELECT o.subject_id FROM run_outcomes o
    WHERE o.run_id = ${runId}::uuid
      AND NOT EXISTS (SELECT 1 FROM run_outcome_reversals x WHERE x.occurrence_id = o.id)
    ORDER BY o.subject_id
  `)) as any[]).map((r) => r.subject_id as string);
const declaredEvents = async (runId: string) =>
  ((await db.execute(sql`
    SELECT source_service, payload->>'runOwnerHolds' AS holds FROM outcome_declaration_events
    WHERE run_id = ${runId}::uuid AND event_type = 'outcomes.declared' ORDER BY occurred_at
  `)) as any[]).map((e) => [e.source_service, e.holds]);

describe("RUN-DOOR-DECLARER-1110: a service declaring on another service's run over the org route holds its rows", () => {
  beforeAll(async () => {
    await cleanTestData([ORG]);
    stepCatalogue.fn.mockResolvedValue([]);
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("records the calling service as the declarer, the run's owner holding the rows too", async () => {
    const run = await ownerRun();
    expect((await declareOrg(run.id, B, ["l-1", "l-2"])).status).toBe(201);
    expect(await declaredEvents(run.id)).toEqual([[B, "true"]]);
  });

  it("B reverses one of its Units (201); C is refused (403, nothing written)", async () => {
    const run = await ownerRun();
    expect((await declareOrg(run.id, B, ["l-1", "l-2", "l-3"])).status).toBe(201);
    const third = await reverse(C, run.id, "l-1");
    expect(third.status).toBe(403);
    expect(third.body.error).toBe("not_occurrence_declarer");
    expect(await liveSubjects(run.id)).toEqual(["l-1", "l-2", "l-3"]);
    const own = await reverse(B, run.id, "l-1");
    expect(own.status).toBe(201);
    expect(own.body.reversedCount).toBe(1);
    expect(await liveSubjects(run.id)).toEqual(["l-2", "l-3"]);
    // The run's owner keeps the right it had when it was recorded as the declarer.
    const owner = await reverse(A, run.id, "l-2");
    expect(owner.status).toBe(201);
    expect(await liveSubjects(run.id)).toEqual(["l-3"]);
  });

  it("B scoped-voids its own key (201); C is refused (403 not_run_declarer)", async () => {
    const run = await ownerRun();
    expect((await declareOrg(run.id, B, ["l-1", "l-2"])).status).toBe(201);
    const third = await scopedVoid(C, run.id);
    expect(third.status).toBe(403);
    expect(third.body.error).toBe("not_run_declarer");
    const own = await scopedVoid(B, run.id);
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({ status: "voided", voidedCount: 2 });
    expect(await liveSubjects(run.id)).toEqual([]);
  });

  it("the run's owner still scoped-voids and whole-voids rows B declared over the org route", async () => {
    const scoped = await ownerRun();
    expect((await declareOrg(scoped.id, B, ["l-1"])).status).toBe(201);
    const v = await scopedVoid(A, scoped.id);
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ status: "voided", voidedCount: 1 });
    const whole = await ownerRun();
    expect((await declareOrg(whole.id, B, ["l-1"])).status).toBe(201);
    const w = await request(app).post(`/v1/runs/${whole.id}/outcomes/void`).set(orgAs(A)).send({ reason: "wrong", voidedBy: "workflow test" });
    expect(w.status).toBe(201);
    expect(await liveSubjects(whole.id)).toEqual([]);
  });

  it("no x-service-name on the org route: the run's owner is the declarer, as before", async () => {
    const run = await ownerRun();
    expect((await declareOrg(run.id, undefined, ["l-1"])).status).toBe(201);
    expect(await declaredEvents(run.id)).toEqual([[A, null]]);
    expect((await reverse(B, run.id, "l-1")).status).toBe(403);
    expect((await reverse(A, run.id, "l-1")).status).toBe(201);
  });

  it("the run's owner declaring on its own run over the org route: no co-holder flag", async () => {
    const run = await ownerRun();
    expect((await declareOrg(run.id, A, ["l-1"])).status).toBe(201);
    expect(await declaredEvents(run.id)).toEqual([[A, null]]);
  });

  it("platform route unchanged: B's rows on A's run are B's alone", async () => {
    const run = await ownerRun();
    const d = await request(app).post(`/v1/platform-runs/${run.id}/outcomes`).set(getPlatformAuthHeaders({ serviceName: B })).send({ produced: [unit("l-1"), unit("l-2")] });
    expect(d.status).toBe(201);
    expect(await declaredEvents(run.id)).toEqual([[B, null]]);
    expect((await reverse(A, run.id, "l-1")).status).toBe(403);
    expect((await reverse(B, run.id, "l-1")).status).toBe(201);
  });
});
