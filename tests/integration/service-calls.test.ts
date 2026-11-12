import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";

// LLM-RATING-PER-ENGINE-1112-RUNS: features-service reads every LLM call (chat-service run) the fleet
// ever made, with its cost lines and the decision it was part of, then only what changed; and the Units
// each decision produced, own and one hop downstream, so it can rate each LLM per Engine from history.

const ORG = "0c11e112-1112-4c0a-8b1e-000000000001";
const SVC = "chat-service-llm-rating-test"; // own service name: the feed is fleet-wide
const X_SCRIPT = "x_post_published/dy_x_post/v3";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});
const stepCatalogue = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/outcome-catalogue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/outcome-catalogue.js")>();
  return { ...actual, unknownOutcomeKeys: stepCatalogue.fn };
});

const VERSIONS = [
  { costName: "anthropic-fable-5.1-tokens-output", provider: "anthropic", servedFrom: "2026-01-01T00:00:00Z", billedUnitCostInUsdCents: "0.01", vendorUnitCostInUsdCents: "0.002" },
  { costName: "anthropic-sonnet-5.5-tokens-output", provider: "anthropic", servedFrom: "2026-01-01T00:00:00Z", billedUnitCostInUsdCents: "0.005", vendorUnitCostInUsdCents: null },
];

const app = createTestApp();
const H = getInternalAuthHeaders();
const at = (iso: string) => new Date(iso);

async function feed(cursor?: string, limit = 2, extra = "") {
  const q = new URLSearchParams({ serviceName: SVC, limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  const res = await request(app).get(`/internal/stats/service-calls?${q}${extra}`).set(H);
  expect(res.status).toBe(200);
  return res.body;
}

async function drain(cursor?: string, limit = 2) {
  const calls: any[] = [];
  let c = cursor;
  for (let i = 0; i < 50; i++) {
    const page = await feed(c, limit);
    calls.push(...page.calls);
    c = page.nextCursor;
    if (page.caughtUp) return { calls, cursor: c! };
  }
  throw new Error("feed never caught up");
}

const units = async (ids: string[]) => {
  const res = await request(app).post("/internal/stats/decision-units").set(H).send({ decisionRunIds: ids });
  expect(res.status).toBe(200);
  return res.body.decisions as any[];
};

describe("LLM-RATING-PER-ENGINE-1112: every LLM call + the Units of its decision", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    process.env.SERVICE_CALLS_LAG_MS = "0";
    await cleanTestData([ORG]);
    await db.execute(sql`DELETE FROM runs WHERE service_name = ${SVC}`);
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockResolvedValue([]);

    // Script era: a campaign tick holding two X post decisions.
    const tick = await insertTestRun({ organizationId: ORG, serviceName: "campaign-service", taskName: "campaign-trigger", campaignId: "camp-x", status: "completed", startedAt: at("2026-11-08T10:00:00Z") });
    for (const [k, model, startedAt] of [["a", "fable", "2026-11-08T10:00:01Z"], ["b", "sonnet", "2026-11-08T10:00:02Z"]] as const) {
      const script = await insertTestRun({ organizationId: ORG, serviceName: "workflow", taskName: "script:x_post_published/dy_x_post", campaignId: "camp-x", scriptSlug: X_SCRIPT, parentRunId: tick.id, status: "completed", startedAt: at(startedAt) });
      const call = await insertTestRun({ organizationId: ORG, serviceName: SVC, taskName: "complete", campaignId: "camp-x", scriptSlug: X_SCRIPT, parentRunId: script.id, status: "completed", startedAt: at(startedAt) });
      const unit = model === "fable" ? "0.01" : "0.005";
      await insertTestRunCost({ runId: call.id, costName: `anthropic-${model === "fable" ? "fable-5.1" : "sonnet-5.5"}-tokens-output`, quantity: "1000", unitCostInUsdCents: unit, totalCostInUsdCents: (1000 * Number(unit)).toFixed(10), createdAt: at(startedAt) });
      const publish = await insertTestRun({ organizationId: ORG, serviceName: "social-service", taskName: "x-post-publish", campaignId: "camp-x", scriptSlug: X_SCRIPT, parentRunId: script.id, status: "completed", startedAt: at(startedAt) });
      ids[`script_${k}`] = script.id;
      ids[`call_${k}`] = call.id;
      ids[`publish_${k}`] = publish.id;
    }
    ids.tick = tick.id;
    // A platform call made for script a's run: it inherits nothing, its decision is still script a.
    const platformCall = await insertTestRun({ organizationId: null, serviceName: SVC, taskName: "platform-complete", parentRunId: ids.script_a, status: "running", startedAt: at("2026-11-08T10:00:03Z") });
    ids.platform = platformCall.id;
    // A nested script of the same Engine (a Rating fallthrough candidate) is its own decision.
    const nested = await insertTestRun({ organizationId: ORG, serviceName: "workflow", taskName: "script:x_post_published/dy_x_post_alt", campaignId: "camp-x", scriptSlug: "x_post_published/dy_x_post_alt/v1", parentRunId: ids.script_a, status: "completed", startedAt: at("2026-11-08T10:00:04Z") });
    const nestedPublish = await insertTestRun({ organizationId: ORG, serviceName: "social-service", taskName: "x-post-publish", scriptSlug: "x_post_published/dy_x_post_alt/v1", parentRunId: nested.id, status: "completed", startedAt: at("2026-11-08T10:00:04Z") });
    ids.nested = nested.id;
    ids.nestedPublish = nestedPublish.id;

    // Workflow era: an email decision whose send is answered later by a reply judged in another tree.
    const wf = await insertTestRun({ organizationId: ORG, serviceName: "workflow", taskName: "execute-workflow", workflowSlug: "sales-cold-email-outreach", campaignId: "camp-e", parentRunId: tick.id, status: "completed", startedAt: at("2026-10-20T09:00:00Z") });
    const write = await insertTestRun({ organizationId: ORG, serviceName: SVC, taskName: "complete", workflowSlug: "sales-cold-email-outreach", campaignId: "camp-e", parentRunId: wf.id, status: "completed", startedAt: at("2026-10-20T09:00:01Z") });
    const send = await insertTestRun({ organizationId: ORG, serviceName: "instantly-service", taskName: "send", workflowSlug: "sales-cold-email-outreach", campaignId: "camp-e", parentRunId: wf.id, status: "completed", startedAt: at("2026-10-20T09:00:02Z") });
    const replyJudge = await insertTestRun({ organizationId: ORG, serviceName: "instantly-service", taskName: "reply-judging", status: "completed", startedAt: at("2026-10-22T09:00:00Z") });
    ids.wf = wf.id;
    ids.write = write.id;
    ids.send = send.id;
    ids.replyJudge = replyJudge.id;

    // Staff support work: a marked eval run and its call.
    const evalRun = await insertTestRun({ organizationId: ORG, serviceName: "features-service", taskName: "eval", status: "completed", startedAt: at("2026-11-01T00:00:00Z") });
    await db.execute(sql`INSERT INTO run_support_marks (run_id, kind, marked_at) VALUES (${evalRun.id}::uuid, 'staff_experiment', now())`);
    const evalCall = await insertTestRun({ organizationId: ORG, serviceName: SVC, taskName: "judgments", parentRunId: evalRun.id, status: "completed", startedAt: at("2026-11-01T00:00:01Z") });
    ids.evalCall = evalCall.id;

    const declare = (service: string, runs: unknown[]) =>
      request(app).post("/v1/platform-runs/outcomes/batch").set(getPlatformAuthHeaders({ serviceName: service })).send({ runs });
    expect((await declare("social-service", [
      { runId: ids.publish_a, produced: [{ outcomeKey: "x_post_published", subjectService: "social-service", subjectId: "post-a" }] },
      { runId: ids.publish_b, produced: [{ outcomeKey: "x_post_published", subjectService: "social-service", subjectId: "post-b" }] },
      { runId: ids.nestedPublish, produced: [{ outcomeKey: "x_post_published", subjectService: "social-service", subjectId: "post-n" }] },
    ])).status).toBe(201);
    expect((await declare("instantly-service", [
      { runId: ids.send, produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: "lead-1" }] },
    ])).status).toBe(201);
    expect((await declare("instantly-service", [
      { runId: ids.replyJudge, produced: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "lead-1" }, { outcomeKey: "conversation", subjectService: "lead-service", subjectId: "lead-2" }],
        consumed: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: "lead-1" }] },
    ])).status).toBe(201);
  });

  afterAll(async () => {
    delete process.env.SERVICE_CALLS_LAG_MS;
    // Bronze survives the silver cleanup: other files count fleet-wide events (outcome-reversal.test.ts).
    const mine = `{${Object.values(ids).join(",")}}`;
    await db.execute(sql`DELETE FROM outcome_declaration_events WHERE run_id = ANY(${mine}::uuid[])`);
    await db.execute(sql`DELETE FROM run_lifecycle_events WHERE run_id = ANY(${mine}::uuid[])`);
    await db.execute(sql`DELETE FROM runs WHERE service_name = ${SVC}`);
    await cleanTestData([ORG]);
    await closeDb();
  });

  let cursor: string;

  it("history: every call of the service once, oldest first, with costs, vendor money, script, decision and support mark", async () => {
    const { calls, cursor: c } = await drain(undefined, 2);
    cursor = c;
    expect(calls.map((x) => x.runId)).toEqual([ids.write, ids.evalCall, ids.call_a, ids.call_b, ids.platform]);
    const byId = Object.fromEntries(calls.map((x) => [x.runId, x]));

    expect(byId[ids.call_a]).toMatchObject({
      scriptSlug: X_SCRIPT, campaignId: "camp-x", orgId: ORG, rootRunId: ids.tick, decisionRunId: ids.script_a, decisionBasis: "script", supportFunction: null,
    });
    expect(byId[ids.call_a].costs).toEqual([expect.objectContaining({
      costName: "anthropic-fable-5.1-tokens-output", status: "actual", quantity: "1000.000000",
      totalCostInUsdCents: "10.0000000000", vendorUnitCostInUsdCents: "0.002", vendorTotalCostInUsdCents: "2.0000000000",
    })]);
    // Unknown vendor cost is stated as null, never the billed price.
    expect(byId[ids.call_b].costs[0]).toMatchObject({ costName: "anthropic-sonnet-5.5-tokens-output", vendorTotalCostInUsdCents: null, totalCostInUsdCents: "5.0000000000" });
    expect(byId[ids.call_b].decisionRunId).toBe(ids.script_b);
    // The platform call inherits no script: its decision is still the script run that asked for it.
    expect(byId[ids.platform]).toMatchObject({ scriptSlug: null, orgId: null, decisionRunId: ids.script_a, decisionBasis: "script", costs: [] });
    // Workflow era: the execute-workflow run is the decision (the campaign tick above it is not).
    expect(byId[ids.write]).toMatchObject({ workflowSlug: "sales-cold-email-outreach", decisionRunId: ids.wf, decisionBasis: "workflow", rootRunId: ids.tick });
    // Staff support work is flagged through its ancestor's mark.
    expect(byId[ids.evalCall]).toMatchObject({ supportFunction: "staff_experiment", decisionBasis: "root" });
  });

  it("changes: a later read serves only the runs a fact touched since, whole again", async () => {
    expect((await feed(cursor)).calls).toEqual([]);
    await db.execute(sql`INSERT INTO run_lifecycle_events (run_id, event_type, payload) VALUES (${ids.platform}::uuid, 'run.completed', '{}'::jsonb)`);
    // A fact on a run of another service is not served.
    await db.execute(sql`INSERT INTO run_lifecycle_events (run_id, event_type, payload) VALUES (${ids.send}::uuid, 'run.completed', '{}'::jsonb)`);
    const { calls, cursor: next } = await drain(cursor, 2);
    expect(calls.map((x) => x.runId)).toEqual([ids.platform]);
    expect(calls[0]).toMatchObject({ status: "completed", decisionRunId: ids.script_a });
    expect((await feed(next)).calls).toEqual([]);
  });

  it("a cursor is bound to its filter; a garbage cursor is a 400", async () => {
    const other = await request(app).get(`/internal/stats/service-calls?serviceName=${SVC}&taskNames=complete&cursor=${cursor}`).set(H);
    expect(other.status).toBe(400);
    const junk = await request(app).get(`/internal/stats/service-calls?serviceName=${SVC}&cursor=nope`).set(H);
    expect(junk.status).toBe(400);
    expect((await request(app).get(`/internal/stats/service-calls`).set(H)).status).toBe(400);
  });

  it("taskNames narrows the feed (a page covers one day of starts at most: follow nextCursor)", async () => {
    const seen: string[] = [];
    let c: string | undefined;
    for (let i = 0; i < 50; i++) {
      const q = new URLSearchParams({ serviceName: SVC, taskNames: "judgments,platform-complete", limit: "100" });
      if (c) q.set("cursor", c);
      const res = await request(app).get(`/internal/stats/service-calls?${q}`).set(H);
      expect(res.status).toBe(200);
      seen.push(...res.body.calls.map((x: any) => x.runId));
      c = res.body.nextCursor;
      if (res.body.caughtUp) break;
    }
    expect(seen).toEqual([ids.evalCall, ids.platform]);
  });

  it("decision Units: the publish declared by the script's child is the script's; a nested script keeps its own", async () => {
    const [a, b, n] = await units([ids.script_a, ids.script_b, ids.nested]);
    expect(a.units.map((u: any) => [u.outcomeKey, u.subjectId, u.credit])).toEqual([["x_post_published", "post-a", "own"]]);
    expect(b.units.map((u: any) => u.subjectId)).toEqual(["post-b"]);
    expect(n.units.map((u: any) => u.subjectId)).toEqual(["post-n"]);
    const [missing] = await units(["00000000-0000-4000-8000-000000000999"]);
    expect(missing).toEqual({ decisionRunId: "00000000-0000-4000-8000-000000000999", found: false, units: [] });
  });

  it("decision Units: a reply is credited to the email decision it answers, for the same lead only", async () => {
    const [wf] = await units([ids.wf]);
    expect(wf.units.map((u: any) => [u.outcomeKey, u.subjectId, u.credit])).toEqual([
      ["message_sent", "lead-1", "own"],
      ["conversation", "lead-1", "downstream"],
    ]);
    expect(wf.units[1].via).toMatchObject({ outcomeKey: "message_sent", consumingRunId: ids.replyJudge });
  });

  it("a reversed Unit stops counting, and the change feed names its decision", async () => {
    const start = await request(app).get(`/internal/stats/decision-units/changes`).set(H);
    expect(start.status).toBe(200);
    expect(start.body.decisionRunIds).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    const rev = await request(app)
      .post("/v1/platform-runs/outcomes/reversals")
      .set({ ...getPlatformAuthHeaders({ serviceName: "instantly-service" }), "x-org-id": ORG })
      .send({ reversedBy: "test", reversals: [{ runId: ids.replyJudge, outcomeKey: "conversation", subjectService: "lead-service", subjectId: "lead-1", reason: "not a reply" }] });
    expect(rev.status).toBe(201);
    const [wf] = await units([ids.wf]);
    expect(wf.units.map((u: any) => u.outcomeKey)).toEqual(["message_sent"]);
    const changes = await request(app).get(`/internal/stats/decision-units/changes?cursor=${start.body.nextCursor}`).set(H);
    expect(changes.status).toBe(200);
    // The reply run's own decision (its top-level run) and the email decision whose send it consumed.
    expect(changes.body.decisionRunIds).toEqual([ids.wf, ids.replyJudge].sort());
    expect(changes.body.caughtUp).toBe(true);
  });
});
