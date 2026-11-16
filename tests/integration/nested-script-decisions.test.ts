import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { inArray, sql } from "drizzle-orm";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { runs } from "../../src/db/schema.js";
import { buildOutcomeChains } from "../../src/services/outcome-chains.js";
import { computeLedgerDay, storeLedgerDay, utcDay } from "../../src/services/outcome-ledger.js";

// SERVED-MODEL-1116-NESTED-RUNS (migration 0116): a script ASKED by another script (workflow-service opens the asked
// script's run under the asking script's run, stating its own slug) is its OWN decision. runs.script_slug keeps the
// outermost script (the ledger's whole-chain dimension, unchanged); runs.decision_script_slug names the innermost one.

const ORG = "0c11e116-1116-4c0a-8b1e-000000000001";
const BRAND = "0c11e116-1116-4c0a-8b1e-0000000000b1";
const BOOK = "nst1116_meeting_booked/dy_book_meeting/v3";
const GLM = "nst1116_message_sent/dy_answer_lead__glm/v1";
const SENT = "nst1116_message_sent";
const CHAT = "nst1116-chat";

const stepCatalogue = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/outcome-catalogue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/outcome-catalogue.js")>();
  return { ...actual, unknownOutcomeKeys: stepCatalogue.fn };
});
const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});
const VERSIONS = [{ costName: "nst1116-tokens", provider: "acme", servedFrom: "2024-01-01T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" }];

const app = createTestApp();
const H = getInternalAuthHeaders();
const TODAY = utcDay(new Date());
const ids: Record<string, string> = {};

async function get(path: string) {
  const res = await request(app).get(path).set(H);
  expect(res.status).toBe(200);
  return res.body;
}
const slugs = async (list: string[]) =>
  Object.fromEntries(
    (await db.select({ id: runs.id, s: runs.scriptSlug, d: runs.decisionScriptSlug }).from(runs).where(inArray(runs.id, list))).map((r) => [r.id, [r.s, r.d]]),
  );
/** Every chat-service call of the history phase (runs started up to the first page's instant). */
async function chatCalls(): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await get(`/internal/stats/service-calls?serviceName=${CHAT}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    if (page.phase !== "history") return out;
    out.push(...page.calls);
    cursor = page.nextCursor;
  }
  throw new Error("history never ended");
}
const cost = (runId: string, total: string) =>
  insertTestRunCost({ runId, costName: "nst1116-tokens", quantity: "1", unitCostInUsdCents: total, totalCostInUsdCents: total, status: "actual" });

describe("SERVED-MODEL-1116-NESTED-RUNS: a script asked by another script is its own decision", () => {
  beforeAll(async () => {
    await cleanTestData([ORG]);
    stepCatalogue.fn.mockResolvedValue([]);
    catalog.fn.mockResolvedValue(VERSIONS);
    process.env.SERVICE_CALLS_LAG_MS = "0"; // the runs below start now: serve them in the history phase
  });

  afterAll(async () => {
    delete process.env.SERVICE_CALLS_LAG_MS;
    const mine = `{${Object.values(ids).join(",")}}`;
    await db.execute(sql`DELETE FROM outcome_declaration_events WHERE run_id = ANY(${mine}::uuid[])`);
    await db.execute(sql`DELETE FROM run_lifecycle_events WHERE identity->>'orgId' = ${ORG}`);
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("POST /v1/runs: the asked script's run and its chat child decide for the asked script; script_slug keeps the outer one", async () => {
    const h = getAuthHeaders({ orgId: ORG });
    const book = await request(app).post("/v1/runs").set(h).send({ serviceName: "workflow", taskName: "script:nst1116_meeting_booked/dy_book_meeting", scriptSlug: BOOK, brandIds: [BRAND] });
    expect(book.status).toBe(201);
    expect([book.body.scriptSlug, book.body.decisionScriptSlug]).toEqual([BOOK, BOOK]);
    const bookChat = await request(app).post("/v1/runs").set({ ...h, "x-run-id": book.body.id }).send({ serviceName: CHAT, taskName: "complete" });
    expect([bookChat.body.scriptSlug, bookChat.body.decisionScriptSlug]).toEqual([BOOK, BOOK]);
    const asked = await request(app).post("/v1/runs").set({ ...h, "x-run-id": book.body.id }).send({ serviceName: "workflow", taskName: "script:nst1116_message_sent/dy_answer_lead__glm", scriptSlug: GLM });
    expect(asked.status).toBe(201);
    expect([asked.body.scriptSlug, asked.body.decisionScriptSlug]).toEqual([BOOK, GLM]);
    const askedChat = await request(app).post("/v1/runs").set({ ...h, "x-run-id": asked.body.id }).send({ serviceName: CHAT, taskName: "complete" });
    expect([askedChat.body.scriptSlug, askedChat.body.decisionScriptSlug]).toEqual([BOOK, GLM]);
    Object.assign(ids, { book: book.body.id, bookChat: bookChat.body.id, asked: asked.body.id, askedChat: askedChat.body.id });

    await cost(ids.bookChat, "10");
    await cost(ids.askedChat, "7");
    expect((await request(app).post("/v1/platform-runs/outcomes/batch").set(getPlatformAuthHeaders({ serviceName: "workflow" })).send({
      runs: [{ runId: ids.asked, produced: [{ outcomeKey: SENT, subjectService: "lead-service", subjectId: "nst1116-l1" }] }],
    })).status).toBe(201);
  });

  it("script reach: the asked script has its own decision with its own cost; the asker no longer pays for it", async () => {
    await buildOutcomeChains();
    const glm = await get(`/internal/stats/outcome-chains/script-reach?scriptSlugs=${GLM}`);
    expect(glm.groups.map((g: any) => [g.producedOutcomes, g.runs, Number(g.costInUsdCents)])).toEqual([[[SENT], 1, 7]]);
    const book = await get(`/internal/stats/outcome-chains/script-reach?scriptSlugs=${BOOK}`);
    expect(book.groups.map((g: any) => [g.producedOutcomes, g.runs, Number(g.costInUsdCents)])).toEqual([[[], 1, 10]]);
    // a reported Unit resolves to the asked script's decision
    const res = await request(app).post("/internal/stats/outcome-chains/unit-decisions").set(H).send({
      units: [{ outcomeKey: SENT, subjectService: "lead-service", subjectId: "nst1116-l1" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.units[0]).toMatchObject({ status: "script_decision", decisionRunId: ids.asked, decision: { scriptSlug: GLM } });
  });

  it("decision units + service calls: the chat call is the asked script's", async () => {
    const units = await request(app).post("/internal/stats/decision-units").set(H).send({ decisionRunIds: [ids.asked, ids.book] });
    expect(units.status).toBe(200);
    expect(units.body.decisions.map((d: any) => [d.decisionRunId, d.units.map((u: any) => u.outcomeKey)])).toEqual([
      [ids.asked, [SENT]],
      [ids.book, []],
    ]);
    const byRun = Object.fromEntries((await chatCalls()).map((c: any) => [c.runId, [c.scriptSlug, c.outermostScriptSlug, c.decisionRunId]]));
    expect(byRun[ids.askedChat]).toEqual([GLM, BOOK, ids.asked]);
    expect(byRun[ids.bookChat]).toEqual([BOOK, BOOK, ids.book]);
  });

  it("the ledger's whole-chain read is unchanged: outcome-costs keeps the asked script's spend and Units under the OUTER script", async () => {
    await storeLedgerDay(await computeLedgerDay(TODAY, VERSIONS as any));
    const res = await request(app).get(`/internal/stats/outcome-costs?orgId=${ORG}&since=${TODAY}&until=${TODAY}&groupBy=outcomeKey,scriptSlug`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.produced.map((g: any) => [g.dimensions.outcomeKey, g.dimensions.scriptSlug, g.occurrences, g.cost.grossCents])).toEqual([
      [SENT, BOOK, 1, "7.0000000000"],
    ]);
    expect(res.body.produced.some((g: any) => g.dimensions.scriptSlug === GLM)).toBe(false);
  });

  it("history: script-statements re-states a recorded nested run as its own decision, whatever the order, idempotently", async () => {
    // Recorded before 0116: the asked script's run and its child carry the OUTER slug, no decision script.
    const at = new Date(`${TODAY}T00:00:00Z`);
    const outer = await insertTestRun({ organizationId: ORG, serviceName: "workflow", taskName: "script:x", scriptSlug: BOOK, status: "completed", startedAt: at });
    const outerChat = await insertTestRun({ organizationId: ORG, serviceName: CHAT, taskName: "complete", scriptSlug: BOOK, parentRunId: outer.id, status: "completed", startedAt: at });
    const nested = await insertTestRun({ organizationId: ORG, serviceName: "workflow", taskName: "script:y", scriptSlug: BOOK, parentRunId: outer.id, status: "completed", startedAt: at });
    const nestedChat = await insertTestRun({ organizationId: ORG, serviceName: CHAT, taskName: "complete", scriptSlug: BOOK, parentRunId: nested.id, status: "completed", startedAt: at });
    const deeper = await insertTestRun({ organizationId: ORG, serviceName: "workflow", taskName: "script:z", scriptSlug: BOOK, parentRunId: nested.id, status: "completed", startedAt: at });
    Object.assign(ids, { outer: outer.id, outerChat: outerChat.id, nested: nested.id, nestedChat: nestedChat.id, deeper: deeper.id });
    const all = [outer.id, outerChat.id, nested.id, nestedChat.id, deeper.id];
    const DEEP = "nst1116_email_found/dy_verify/v2";
    const state = (items: Array<{ rootRunId: string; scriptSlug: string }>) =>
      request(app).post("/internal/runs/script-statements").set(H).send({ items, reason: "nested decisions", statedBy: "workflow-service" });

    // The deepest asked script first, then the middle one, then the outer one with the middle in the same call.
    const d = await state([{ rootRunId: deeper.id, scriptSlug: DEEP }]);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ statedRuns: 0, alreadyNamed: [{ runId: deeper.id, scriptSlug: BOOK }], decisionStatedRuns: 1 });
    const m = await state([{ rootRunId: outer.id, scriptSlug: BOOK }, { rootRunId: nested.id, scriptSlug: GLM }]);
    expect(m.body.decisionStatedRuns).toBe(2);
    expect(await slugs(all)).toEqual({
      [outer.id]: [BOOK, null],
      [outerChat.id]: [BOOK, null],
      [nested.id]: [BOOK, GLM],
      [nestedChat.id]: [BOOK, GLM],
      [deeper.id]: [BOOK, DEEP],
    });
    // Idempotent; the outer one stated again moves nothing it does not own.
    const again = await state([{ rootRunId: outer.id, scriptSlug: BOOK }, { rootRunId: nested.id, scriptSlug: GLM }, { rootRunId: deeper.id, scriptSlug: DEEP }]);
    expect(again.body).toMatchObject({ statedRuns: 0, decisionStatedRuns: 0 });
    // One bronze fact per moved run.
    const events = (await db.execute(sql`SELECT count(*)::int AS n FROM run_lifecycle_events WHERE event_type = 'run.decision_script_stated' AND run_id = ANY(${`{${all.join(",")}}`}::uuid[])`)) as any[];
    expect(events[0].n).toBe(3);

    // The decision reads follow: the restated run is its own decision.
    await buildOutcomeChains();
    const units = await request(app).post("/internal/stats/decision-units").set(H).send({ decisionRunIds: [nested.id] });
    expect(units.body.decisions[0].found).toBe(true);
    const byRun = Object.fromEntries((await chatCalls()).map((c: any) => [c.runId, [c.scriptSlug, c.decisionRunId]]));
    expect(byRun[nestedChat.id]).toEqual([GLM, nested.id]);
    expect(byRun[outerChat.id]).toEqual([BOOK, outer.id]);
  });
});
