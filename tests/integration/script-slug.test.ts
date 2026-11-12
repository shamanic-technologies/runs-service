import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { inArray, sql } from "drizzle-orm";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { runs } from "../../src/db/schema.js";
import { addDays, computeLedgerDay, daysToCompute, storeLedgerDay, utcDay } from "../../src/services/outcome-ledger.js";

// MON-SCRIPT-PRICES-2-1111 (migration 0111): every run names the stored script it works for, so the ledger measures
// each script apart. Stated at run open (outermost script wins), filled on history by bronze statements, grouped by the
// outcome totals (`scriptSlug`, `sourceScriptSlug`).

const ORG = "5c41b700-1111-4c0a-8b1e-0000000000e1";
const A = "email_sent/dy_a/v1";
const B = "email_sent/dy_b/v2";
const I = "email_reply_received/dy_inbound/v1";

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
const VERSIONS = [{ costName: "tok", provider: "acme", servedFrom: "2024-01-01T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" }];

const app = createTestApp();
const TODAY = utcDay(new Date());
const D1 = addDays(TODAY, -1);
const D2 = addDays(TODAY, -2);

async function cost(runId: string, qty: string, day: string) {
  await insertTestRunCost({ runId, costName: "tok", quantity: qty, unitCostInUsdCents: "5", totalCostInUsdCents: new Decimal(qty).times(5).toFixed(10), status: "actual", createdAt: new Date(`${day}T00:00:01Z`) });
}
const run = (day: string, extra: Partial<Parameters<typeof insertTestRun>[0]> = {}) =>
  insertTestRun({ organizationId: ORG, serviceName: "svc", taskName: "task", status: "completed", startedAt: new Date(`${day}T00:00:00Z`), ...extra });
const lead = (outcomeKey: string, subjectId: string) => ({ outcomeKey, subjectService: "lead-service", subjectId });
async function declare(runId: string, body: unknown) {
  const res = await request(app).post(`/v1/runs/${runId}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send(body);
  expect([200, 201]).toContain(res.status);
}
const totals = (query: string) => request(app).get(`/internal/stats/outcome-costs?orgId=${ORG}&since=${D2}&until=${TODAY}&${query}`).set(getInternalAuthHeaders());
const sumGross = (rows: any[], f: string) => rows.reduce((x: Decimal, g: any) => x.plus(g[f].grossCents), new Decimal(0)).toFixed(10);
const scriptOf = async (ids: string[]) => Object.fromEntries((await db.select({ id: runs.id, s: runs.scriptSlug }).from(runs).where(inArray(runs.id, ids))).map((r) => [r.id, r.s]));

describe("a run names its script (MON-SCRIPT-PRICES-2-1111)", () => {
  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockResolvedValue([]);
  });
  afterAll(async () => {
    await cleanTestData([ORG]);
    await db.execute(sql`DELETE FROM run_lifecycle_events WHERE identity->>'orgId' = ${ORG}`);
    await closeDb();
  });

  it("POST /v1/runs stores the stated script; a child inherits it; a nested script rides the OUTER one", async () => {
    const headers = getAuthHeaders({ orgId: ORG });
    const bad = await request(app).post("/v1/runs").set(headers).send({ serviceName: "workflow", taskName: "script:x", scriptSlug: "not a script" });
    expect(bad.status).toBe(400);
    const outer = await request(app).post("/v1/runs").set(headers).send({ serviceName: "workflow", taskName: "script:email_sent/dy_a", scriptSlug: A });
    expect(outer.status).toBe(201);
    expect(outer.body.scriptSlug).toBe(A);
    const child = await request(app).post("/v1/runs").set({ ...headers, "x-run-id": outer.body.id }).send({ serviceName: "chat-service", taskName: "complete" });
    expect(child.body.scriptSlug).toBe(A);
    const nested = await request(app).post("/v1/runs").set({ ...headers, "x-run-id": child.body.id }).send({ serviceName: "workflow", taskName: "script:email_found/dy_verify", scriptSlug: "email_found/dy_verify/v2" });
    expect(nested.status).toBe(201);
    expect(nested.body.scriptSlug).toBe(A);
    const none = await request(app).post("/v1/runs").set(headers).send({ serviceName: "svc", taskName: "t" });
    expect(none.body.scriptSlug).toBeNull();
  });

  it("the outcome totals group by the script of each row's run and of the consumed input's producer; every figure sums to the flat read", async () => {
    // script A sends 2 (10c), script B sends 1 (5c) + a run that produced nothing (5c), on D2; a child of A spends too.
    const a = await run(D2, { campaignId: "cmp", scriptSlug: A });
    await cost(a.id, "2", D2);
    await declare(a.id, { occurredAt: "run_started_at", produced: [lead("message_sent", "s-a"), lead("message_sent", "s-b")] });
    const aChild = await run(D2, { campaignId: "cmp", scriptSlug: A, parentRunId: a.id });
    await cost(aChild.id, "1", D2);
    const b = await run(D2, { campaignId: "cmp", scriptSlug: B });
    await cost(b.id, "1", D2);
    await declare(b.id, { occurredAt: "run_started_at", produced: [lead("message_sent", "s-c")] });
    // D1: the inbound script judges replies to s-a and s-c
    const r = await run(D1, { campaignId: "cmp", scriptSlug: I });
    await cost(r.id, "2", D1);
    await declare(r.id, { produced: [lead("conversation", "s-a"), lead("conversation", "s-c")], consumed: [lead("message_sent", "s-a"), lead("message_sent", "s-c")] });
    for (const day of [D2, D1, TODAY]) await storeLedgerDay(await computeLedgerDay(day, VERSIONS as any));

    const flat = await totals("groupBy=");
    const by = await totals("groupBy=outcomeKey,scriptSlug");
    expect(by.status).toBe(200);
    expect(by.body.complete).toBe(true);
    expect(sumGross(by.body.produced, "cost")).toBe(sumGross(flat.body.produced, "cost"));
    const produced = Object.fromEntries(by.body.produced.map((g: any) => [`${g.dimensions.outcomeKey}|${g.dimensions.scriptSlug}`, [g.occurrences, g.cost.grossCents]]));
    expect(produced[`message_sent|${A}`]).toEqual([2, "15.0000000000"]);
    expect(produced[`message_sent|${B}`]).toEqual([1, "5.0000000000"]);
    expect(produced[`conversation|${I}`]).toEqual([2, "10.0000000000"]);
    const consumed = await totals("groupBy=scriptSlug,sourceScriptSlug");
    expect(consumed.status).toBe(200);
    const rows = consumed.body.consumed
      .filter((g: any) => g.dimensions.consumedOutcomeKey === "message_sent")
      .map((g: any) => [g.dimensions.scriptSlug, g.dimensions.sourceScriptSlug, g.consumptions])
      .sort((x: any[], y: any[]) => (x[1] < y[1] ? -1 : 1));
    expect(rows).toEqual([
      [I, A, "1.0000000000"],
      [I, B, "1.0000000000"],
    ]);
    // filter
    const onlyB = await totals(`groupBy=outcomeKey&scriptSlug=${encodeURIComponent(B)}`);
    expect(onlyB.body.produced).toEqual([expect.objectContaining({ dimensions: { outcomeKey: "message_sent" }, occurrences: 1 })]);
  });

  it("a day computed before runs named scripts reads missing for a script read only, and is recomputed", async () => {
    await db.execute(sql`UPDATE cost_ledger_computed_days SET script_slugs = false WHERE day = ${D1}::date`);
    expect((await totals("groupBy=scriptSlug")).body.daysMissing).toContain(D1);
    expect((await totals("groupBy=outcomeKey")).body.daysMissing).not.toContain(D1);
    expect(await daysToCompute(new Date(), D2)).toContain(D1);
    await storeLedgerDay(await computeLedgerDay(D1, VERSIONS as any));
    expect((await totals("groupBy=scriptSlug")).body.daysMissing).not.toContain(D1);
  });

  it("POST /internal/runs/script-statements names recorded subtrees (NULL only), refuses unknown roots, keeps a root already named, flags the days", async () => {
    const root = await run(D2, { campaignId: "cmp2" });
    const kid = await run(D2, { campaignId: "cmp2", parentRunId: root.id });
    const other = await run(D2, { campaignId: "cmp2", parentRunId: root.id, scriptSlug: B });
    const underOther = await run(D2, { campaignId: "cmp2", parentRunId: other.id });
    const internal = getInternalAuthHeaders();
    const missing = await request(app).post("/internal/runs/script-statements").set(internal).send({ items: [{ rootRunId: "00000000-0000-4000-8000-000000000001", scriptSlug: A }], reason: "test", statedBy: "workflow-service" });
    expect(missing.status).toBe(404);
    // a root already naming another script keeps it (the outermost script wins)
    const named = await request(app).post("/internal/runs/script-statements").set(internal).send({ items: [{ rootRunId: other.id, scriptSlug: A }], reason: "test", statedBy: "workflow-service" });
    expect(named.status).toBe(200);
    expect(named.body).toMatchObject({ statedRuns: 0, alreadyNamed: [{ runId: other.id, scriptSlug: B }] });
    const two = await request(app).post("/internal/runs/script-statements").set(internal).send({ items: [{ rootRunId: root.id, scriptSlug: A }, { rootRunId: root.id, scriptSlug: B }], reason: "t", statedBy: "w" });
    expect(two.status).toBe(400);
    const ok = await request(app).post("/internal/runs/script-statements").set(internal).send({ items: [{ rootRunId: root.id, scriptSlug: A }], reason: "backfill", statedBy: "workflow-service" });
    expect(ok.status).toBe(200);
    expect(ok.body.statedRuns).toBe(2);
    expect(ok.body.daysToRecompute).toBeGreaterThan(0);
    expect(await scriptOf([root.id, kid.id, other.id, underOther.id])).toEqual({ [root.id]: A, [kid.id]: A, [other.id]: B, [underOther.id]: null });
    expect((await totals("groupBy=scriptSlug")).body.daysMissing).toContain(D2);
    // a nested script's run named in the same call as its outer one takes the OUTER one's
    const outer = await run(D2, { campaignId: "cmp3" });
    const mid = await run(D2, { campaignId: "cmp3", parentRunId: outer.id });
    const nested = await run(D2, { campaignId: "cmp3", parentRunId: mid.id });
    const leaf = await run(D2, { campaignId: "cmp3", parentRunId: nested.id });
    const both = await request(app).post("/internal/runs/script-statements").set(internal).send({ items: [{ rootRunId: nested.id, scriptSlug: I }, { rootRunId: outer.id, scriptSlug: A }], reason: "backfill", statedBy: "workflow-service" });
    expect(both.body.statedRuns).toBe(4);
    expect(await scriptOf([outer.id, mid.id, nested.id, leaf.id])).toEqual({ [outer.id]: A, [mid.id]: A, [nested.id]: A, [leaf.id]: A });
    const again = await request(app).post("/internal/runs/script-statements").set(internal).send({ items: [{ rootRunId: root.id, scriptSlug: A }], reason: "backfill", statedBy: "workflow-service" });
    expect(again.body.statedRuns).toBe(0);
  });
});
