import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { computeLedgerDay, daysToCompute, storeLedgerDay, supportTotal } from "../../src/services/outcome-ledger.js";

// COST-SUPPORT-1024-RUNS: a support run names its support function; the ledger
// reads state that spend apart, per function, as a part of produced none:
// allocated + support + undeclared = ledger, and coverage reads on outcome spend.

const ORG = "0c05acc0-1024-4c0a-8b1e-0000000000c1";

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
  { costName: "tok", provider: "acme", servedFrom: "2024-01-01T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" },
];
const CATALOGUE = new Set(["lead_found", "message_sent"]);

// A past day of its own: no other test file writes spend on it.
const PDAY = "2025-04-14";
const app = createTestApp();

const pastRun = (serviceName: string, taskName: string, hour: string, parentRunId?: string) =>
  insertTestRun({ organizationId: ORG, serviceName, taskName, status: "completed", parentRunId, startedAt: new Date(`${PDAY}T${hour}:00Z`) });
const cost = (runId: string, cents: string, createdAt: Date) =>
  insertTestRunCost({
    runId,
    costName: "tok",
    quantity: new Decimal(cents).div(5).toString(),
    unitCostInUsdCents: "5",
    totalCostInUsdCents: new Decimal(cents).toFixed(10),
    status: "actual",
    createdAt,
  });
const at = (hour: string) => new Date(`${PDAY}T${hour}:00Z`);
const refresh = async (day: string) => storeLedgerDay(await computeLedgerDay(day, VERSIONS as any));
const ownerMark = (step: "preview" | "apply", body: unknown, serviceName: string) =>
  request(app).post(`/v1/platform-runs/support-marks/${step}`).set(getPlatformAuthHeaders({ serviceName })).send(body);
const staffMark = (body: unknown, preview = false) =>
  request(app).post(`/internal/runs/support-marks${preview ? "/preview" : ""}`).set(getInternalAuthHeaders()).send(body);
async function ledgerRow() {
  const res = await request(app).get(`/internal/outcome-costs/ledger-check?since=${PDAY}&until=${PDAY}`).set(getInternalAuthHeaders());
  expect(res.status).toBe(200);
  return { body: res.body, row: res.body.rows.find((r: any) => r.organizationId === ORG) };
}
const sumMoney = (...xs: string[]) => xs.reduce((a, x) => a.plus(x), new Decimal(0)).toFixed(10);

describe("Support functions: support spend named and reported apart", () => {
  beforeAll(async () => {
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockImplementation(async (keys: string[]) => keys.filter((k) => !CATALOGUE.has(k)));
    await cleanTestData([ORG]);
  });
  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("a run created as support is marked at creation, produces nothing, and its spend reads as its function", async () => {
    const created = await request(app)
      .post("/v1/platform-runs")
      .set({ ...getPlatformAuthHeaders({ serviceName: "stripe-service" }), "x-org-id": ORG })
      .send({ serviceName: "stripe-service", taskName: "charge", support: { kind: "payment_fees", reason: "processor fee of a top-up" } });
    expect(created.status).toBe(201);
    const [mark] = (await db.execute(sql`SELECT kind FROM run_support_marks WHERE run_id = ${created.body.id}::uuid`)) as any[];
    expect(mark.kind).toBe("payment_fees");
    const produce = await request(app)
      .post(`/v1/platform-runs/${created.body.id}/outcomes`)
      .set(getPlatformAuthHeaders({ serviceName: "stripe-service" }))
      .send({ produced: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "X" }] });
    expect(produce.status).toBe(409);
    expect(produce.body.error).toBe("run_marked_support");

    const bad = await request(app)
      .post("/v1/platform-runs")
      .set(getPlatformAuthHeaders({ serviceName: "stripe-service" }))
      .send({ serviceName: "stripe-service", taskName: "charge", support: { kind: "support", reason: "unnamed" } });
    expect(bad.status).toBe(400);

    const now = new Date();
    await cost(created.body.id, "7", now);
    const day = await computeLedgerDay(now.toISOString().slice(0, 10), VERSIONS as any);
    const org = day.orgs.find((o) => o.organizationId === ORG)!;
    expect(org.supportByFunction.payment_fees!.gross).toBe("7.0000000000");
    expect(supportTotal(org.supportByFunction).gross).toBe("7.0000000000");
    expect(org.producedNone.gross).toBe("7.0000000000");
  });

  it("owner door: preview = apply, own runs only, declaring runs left out; ledger, coverage and outcome totals split support per function", async () => {
    // A declaring send (outcome spend), a Copilot root + its non-declaring child, an undeclared run, a judgment
    // made for a caller run (child of the send: rides message_sent) and a self-rooted one.
    const send = await pastRun("postmark-service", "send", "09:00");
    await cost(send.id, "10", at("09:01"));
    const decl = await request(app)
      .post("/v1/platform-runs/outcomes/batch")
      .set(getPlatformAuthHeaders({ serviceName: "postmark-service" }))
      .send({ runs: [{ runId: send.id, occurredAt: "run_started_at", produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: "L1" }] }] });
    expect(decl.status).toBe(201);
    const chat = await pastRun("api-service", "POST /v1/chat", "10:00");
    await cost(chat.id, "20", at("10:01"));
    const chatChild = await pastRun("chat-service", "complete", "10:02", chat.id);
    await cost(chatChild.id, "5", at("10:03"));
    const stray = await pastRun("api-service", "GET /v1/other", "11:00");
    await cost(stray.id, "3", at("11:01"));
    const forCaller = await pastRun("chat-service", "judgments", "12:00", send.id);
    await cost(forCaller.id, "2", at("12:01"));
    const selfRooted = await pastRun("chat-service", "judgments", "12:30");
    await cost(selfRooted.id, "4", at("12:31"));
    const idle = await pastRun("chat-service", "judgments", "12:40");

    const noOwner = await request(app).post("/v1/platform-runs/support-marks/preview").set({ ...getPlatformAuthHeaders(), "x-service-name": " " }).send({ kind: "copilot", reason: "r", markedBy: "t" });
    expect(noOwner.status).toBe(400);
    // Another service's run is refused, all or nothing.
    const notMine = await ownerMark("apply", { kind: "copilot", reason: "r", markedBy: "t", runIds: [chat.id, send.id] }, "api-service");
    expect(notMine.status).toBe(422);
    expect(notMine.body.details.invalid).toEqual([{ runId: send.id, reason: "not_run_owner" }]);
    expect((await ownerMark("apply", { kind: "copilot", reason: "r", markedBy: "t", runIds: [chat.id], taskNames: ["x"] }, "api-service")).status).toBe(400);

    const copilot = await ownerMark("apply", { kind: "copilot", reason: "Copilot chat", markedBy: "api-service", runIds: [chat.id] }, "api-service");
    expect(copilot.status).toBe(200);
    expect(copilot.body).toMatchObject({ markedCount: 1, alreadyMarkedCount: 0 });

    const judgments = { kind: "platform_llm", reason: "judgments made for no caller run", markedBy: "chat-service", taskNames: ["judgments"], topLevelOnly: true, withSpendOnly: true, startedAfter: `${PDAY}T00:00:00Z`, startedBefore: `${PDAY}T23:59:59Z` };
    const preview = await ownerMark("preview", judgments, "chat-service");
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ matchedRunCount: 1, toMarkCount: 1, alreadyMarkedCount: 0, declaresOutcomesCount: 0, onOutcomeNowCount: 0, tooMany: false, spend: { grossCents: "4.0000000000" } });
    // Without topLevelOnly the judgment made for the send is selected too, and the preview says it rides an outcome today.
    const wide = await ownerMark("preview", { ...judgments, topLevelOnly: undefined }, "chat-service");
    expect(wide.body).toMatchObject({ toMarkCount: 2, onOutcomeNowCount: 1 });
    expect((await ownerMark("apply", judgments, "chat-service")).body).toMatchObject({ markedCount: 1, alreadyMarkedCount: 0 });
    expect((await ownerMark("apply", judgments, "chat-service")).body).toMatchObject({ markedCount: 0, alreadyMarkedCount: 1 });
    expect((await db.execute(sql`SELECT 1 FROM run_support_marks WHERE run_id = ${idle.id}::uuid`)).length).toBe(0);

    await refresh(PDAY);
    const { body, row } = await ledgerRow();
    expect(body.balanced).toBe(true);
    expect(row.allocated.grossCents).toBe("12.0000000000"); // send 10 + judgment made for it 2
    expect(row.supportByFunction).toEqual({
      copilot: expect.objectContaining({ grossCents: "25.0000000000" }),
      platform_llm: expect.objectContaining({ grossCents: "4.0000000000" }),
    });
    expect(row.support.grossCents).toBe("29.0000000000");
    expect(row.undeclared.grossCents).toBe("3.0000000000");
    expect(sumMoney(row.allocated.grossCents, row.support.grossCents, row.undeclared.grossCents)).toBe(row.ledger.grossCents);
    expect(sumMoney(row.support.netCents, row.undeclared.netCents)).toBe(row.producedNone.netCents);
    expect(body.supportDaysMissing).toEqual([]);

    const cov = await request(app).get(`/internal/stats/outcome-coverage?since=${PDAY}&until=${PDAY}&serviceName=api-service`).set(getInternalAuthHeaders());
    expect(cov.status).toBe(200);
    const svc = cov.body.services.find((s: any) => s.serviceName === "api-service");
    expect(svc).toMatchObject({ spendGrossCents: "23.0000000000", coveredGrossCents: "0.0000000000", supportGrossCents: "20.0000000000" });
    expect(svc.supportByFunction).toEqual({ copilot: { grossCents: "20.0000000000", netCents: "20.0000000000" } });

    const oc = await request(app).get(`/internal/stats/outcome-costs?since=${PDAY}&until=${PDAY}&orgId=${ORG}&groupBy=orgId`).set(getInternalAuthHeaders());
    expect(oc.status).toBe(200);
    expect(oc.body.scope).toHaveLength(1);
    const scope = oc.body.scope[0];
    expect(scope.support.grossCents).toBe("29.0000000000");
    expect(Object.keys(scope.supportByFunction).sort()).toEqual(["copilot", "platform_llm"]);
    expect(scope.undeclared.grossCents).toBe("3.0000000000");
    expect(scope.outcomeSpendCoverageShare.gross).toBe(new Decimal(12).div(44 - 29).toFixed(10));
  });

  it("staff door: selection by serviceName (retired product), exclusive with runIds; a day stored before the split is recomputed", async () => {
    const retired = await pastRun("emailgeneration-service", "single-generation", "14:00");
    await cost(retired.id, "1", at("14:01"));
    expect((await staffMark({ kind: "retired_product", reason: "r", markedBy: "t" })).status).toBe(400);
    expect((await staffMark({ kind: "retired_product", reason: "r", markedBy: "t", serviceName: "x", runIds: [retired.id] })).status).toBe(400);
    const preview = await staffMark({ kind: "retired_product", reason: "service gone", markedBy: "t", serviceName: "emailgeneration-service" }, true);
    expect(preview.body).toMatchObject({ toMarkCount: 1, spend: { grossCents: "1.0000000000" } });
    const ok = await staffMark({ kind: "retired_product", reason: "service gone", markedBy: "t", serviceName: "emailgeneration-service" });
    expect(ok.body).toMatchObject({ markedCount: 1 });
    // Over the cap the walk is not run: the count is unknown (null), never a reassuring 0.
    const { selectSupportRuns } = await import("../../src/services/support-marks.js");
    const child = await pastRun("emailgeneration-service", "single-generation", "14:05");
    await cost(child.id, "1", at("14:06"));
    expect(await selectSupportRuns({ serviceName: "emailgeneration-service" }, 0)).toMatchObject({ tooMany: true, onOutcomeNowCount: null });
    expect((await selectSupportRuns({ serviceName: "emailgeneration-service" })).onOutcomeNowCount).toBe(0);
    await db.execute(sql`DELETE FROM runs WHERE id = ${child.id}::uuid`);

    await refresh(PDAY);
    await db.execute(sql`UPDATE cost_ledger_computed_days SET support_split = false WHERE day = ${PDAY}::date`);
    expect((await ledgerRow()).body.supportDaysMissing).toEqual([PDAY]);
    expect(await daysToCompute(new Date(`${PDAY}T12:00:00Z`), PDAY)).toContain(PDAY);
    await refresh(PDAY);
    const { row } = await ledgerRow();
    expect(row.supportByFunction.retired_product.grossCents).toBe("1.0000000000");
  });

  it("a mark undone lets the run declare again, bronze keeps the mark and its undo, the days it moved are recomputed", async () => {
    const DAY2 = "2025-04-16";
    const run = await insertTestRun({ organizationId: ORG, serviceName: "journalists-service", taskName: "buffer-next", status: "completed", startedAt: new Date(`${DAY2}T09:00:00Z`) });
    await cost(run.id, "6", new Date(`${DAY2}T09:01:00Z`));
    const unmark = (body: unknown, preview = false) =>
      request(app).post(`/internal/runs/support-marks/unmark${preview ? "/preview" : ""}`).set(getInternalAuthHeaders()).send(body);
    expect((await staffMark({ kind: "retired_product", reason: "PR cold email retired", markedBy: "t", runIds: [run.id] })).body).toMatchObject({ markedCount: 1 });
    const declare = () =>
      request(app)
        .post(`/v1/platform-runs/${run.id}/outcomes`)
        .set(getPlatformAuthHeaders({ serviceName: "journalists-service" }))
        .send({ produced: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "J1" }] });
    expect((await declare()).status).toBe(409);
    await storeLedgerDay(await computeLedgerDay(DAY2, VERSIONS as any));
    const before = await request(app).get(`/internal/outcome-costs/ledger-check?since=${DAY2}&until=${DAY2}`).set(getInternalAuthHeaders());
    expect(before.body.rows.find((r: any) => r.organizationId === ORG).supportByFunction.retired_product.grossCents).toBe("6.0000000000");

    // Body rules: runIds and a selection are exclusive; reason + unmarkedBy required.
    expect((await unmark({ reason: "r", unmarkedBy: "t", runIds: [run.id], kind: "retired_product" })).status).toBe(400);
    expect((await unmark({ runIds: [run.id] })).status).toBe(400);
    // Preview by feature-less selection over the service: what apply writes.
    const preview = await unmark({ reason: "product is back", unmarkedBy: "t", serviceName: "journalists-service", kind: "retired_product" }, true);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ toUnmarkCount: 1, byFunction: { retired_product: 1 }, spend: { grossCents: "6.0000000000" }, tooMany: false });
    expect((await unmark({ reason: "product is back", unmarkedBy: "t", serviceName: "journalists-service", kind: "copilot" }, true)).body.toUnmarkCount).toBe(0);
    // Owner door: another service cannot undo it.
    const foreign = await request(app)
      .post("/v1/platform-runs/support-marks/unmark/apply")
      .set(getPlatformAuthHeaders({ serviceName: "chat-service" }))
      .send({ reason: "r", unmarkedBy: "t", runIds: [run.id] });
    expect(foreign.status).toBe(422);
    expect(foreign.body.details.invalid).toEqual([{ runId: run.id, reason: "not_run_owner" }]);

    const done = await request(app)
      .post("/v1/platform-runs/support-marks/unmark/apply")
      .set(getPlatformAuthHeaders({ serviceName: "journalists-service" }))
      .send({ reason: "product is back", unmarkedBy: "journalists-service", runIds: [run.id] });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ unmarkedCount: 1, notMarkedCount: 0 });
    expect((await unmark({ reason: "again", unmarkedBy: "t", runIds: [run.id] })).body).toEqual({ unmarkedCount: 0, notMarkedCount: 1 });
    expect((await db.execute(sql`SELECT 1 FROM run_support_marks WHERE run_id = ${run.id}::uuid`)).length).toBe(0);
    const events = (await db.execute(sql`
      SELECT event_type, payload FROM outcome_declaration_events WHERE run_id = ${run.id}::uuid ORDER BY occurred_at, event_type
    `)) as any[];
    expect(events.map((e) => e.event_type)).toEqual(["run.support_marked", "run.support_unmarked"]);
    expect(events[1].payload).toMatchObject({ kind: "retired_product", reason: "product is back", unmarkedBy: "journalists-service", affectedFromDay: DAY2 });

    // The stored day is stale: the refresher recomputes it, and the spend is undeclared again.
    expect(await daysToCompute(new Date(`${DAY2}T12:00:00Z`), DAY2)).toContain(DAY2);
    await storeLedgerDay(await computeLedgerDay(DAY2, VERSIONS as any));
    const after = await request(app).get(`/internal/outcome-costs/ledger-check?since=${DAY2}&until=${DAY2}`).set(getInternalAuthHeaders());
    const row = after.body.rows.find((r: any) => r.organizationId === ORG);
    expect(row.supportByFunction).toEqual({});
    expect(row.undeclared.grossCents).toBe("6.0000000000");

    // The run declares again, and its spend rides that outcome.
    expect((await declare()).status).toBe(201);
    await storeLedgerDay(await computeLedgerDay(DAY2, VERSIONS as any));
    const declared = await request(app).get(`/internal/outcome-costs/ledger-check?since=${DAY2}&until=${DAY2}`).set(getInternalAuthHeaders());
    expect(declared.body.rows.find((r: any) => r.organizationId === ORG).allocated.grossCents).toBe("6.0000000000");
  });

  it("staff door: selection by featureSlugs, offOutcomeOnly leaves spend already on an outcome where it is", async () => {
    const DAY3 = "2025-04-17";
    const mk = (serviceName: string, featureSlug: string, hour: string, parentRunId?: string) =>
      insertTestRun({ organizationId: ORG, serviceName, taskName: "t", featureSlug, status: "completed", parentRunId, startedAt: new Date(`${DAY3}T${hour}:00Z`) });
    const send = await mk("instantly-service", "pr-retired-x", "09:00");
    await cost(send.id, "4", new Date(`${DAY3}T09:01:00Z`));
    const decl = await request(app)
      .post("/v1/platform-runs/outcomes/batch")
      .set(getPlatformAuthHeaders({ serviceName: "instantly-service" }))
      .send({ runs: [{ runId: send.id, occurredAt: "run_started_at", produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: "P1" }] }] });
    expect(decl.status).toBe(201);
    const ridesSend = await mk("chat-service", "pr-retired-x", "09:02", send.id);
    await cost(ridesSend.id, "2", new Date(`${DAY3}T09:03:00Z`));
    const orphan = await mk("chat-service", "pr-retired-x", "10:00");
    await cost(orphan.id, "3", new Date(`${DAY3}T10:01:00Z`));
    const other = await mk("chat-service", "sales-live-y", "10:00");
    await cost(other.id, "5", new Date(`${DAY3}T10:01:00Z`));

    const body = { kind: "retired_product", reason: "PR retired", markedBy: "t", featureSlugs: ["pr-retired-x"], withSpendOnly: true, offOutcomeOnly: true };
    const preview = await staffMark(body, true);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ matchedRunCount: 3, declaresOutcomesCount: 1, toMarkCount: 1, onOutcomeNowCount: 0, leftOnOutcomeCount: 1, spend: { grossCents: "3.0000000000" } });
    expect((await staffMark({ ...body, offOutcomeOnly: undefined }, true)).body).toMatchObject({ toMarkCount: 2, onOutcomeNowCount: 1, leftOnOutcomeCount: 0 });
    expect((await staffMark(body)).body).toMatchObject({ markedCount: 1 });
    const marked = (await db.execute(sql`SELECT run_id FROM run_support_marks WHERE run_id = ANY(${`{${[send.id, ridesSend.id, orphan.id, other.id].join(",")}}`}::uuid[])`)) as any[];
    expect(marked.map((m) => m.run_id)).toEqual([orphan.id]);
  });

  it("v2 cross-run normal loss: a run of pipe W that produced nothing rides the units W produced that day in that org", async () => {
    const DAY4 = "2025-04-18";
    const mk = (workflowSlug: string, hour: string) =>
      insertTestRun({ organizationId: ORG, serviceName: "workflow-service", taskName: "execute-workflow", workflowSlug, status: "completed", startedAt: new Date(`${DAY4}T${hour}:00Z`) });
    const c = (runId: string, cents: string, hour: string) => cost(runId, cents, new Date(`${DAY4}T${hour}:00Z`));
    const kept = await mk("follow-up-w1", "09:00");
    await c(kept.id, "4", "09:01");
    const keptFree = await mk("follow-up-w1", "09:30");
    const lost = await mk("follow-up-w1", "10:00"); // judged "later": produced nothing
    await c(lost.id, "6", "10:01");
    const otherPipe = await mk("other-pipe-w2", "10:00"); // its pipe produced nothing that day
    await c(otherPipe.id, "2", "10:01");
    const supported = await mk("follow-up-w1", "11:00");
    await c(supported.id, "1", "11:01");
    expect((await staffMark({ kind: "staff_experiment", reason: "probe", markedBy: "t", runIds: [supported.id] })).status).toBe(200);
    const decl = await request(app)
      .post("/v1/platform-runs/outcomes/batch")
      .set(getPlatformAuthHeaders({ serviceName: "workflow-service" }))
      .send({
        runs: [
          { runId: kept.id, occurredAt: "run_started_at", produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: "K1" }] },
          { runId: keptFree.id, occurredAt: "run_started_at", produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: "K2" }] },
        ],
      });
    expect(decl.status).toBe(201);

    await storeLedgerDay(await computeLedgerDay(DAY4, VERSIONS as any));
    const res = await request(app).get(`/internal/outcome-costs/ledger-check?since=${DAY4}&until=${DAY4}`).set(getInternalAuthHeaders());
    expect(res.body.allocationVersion).toBe(4);
    expect(res.body.balanced).toBe(true);
    const row = res.body.rows.find((r: any) => r.organizationId === ORG);
    expect(row.ledger.grossCents).toBe("13.0000000000");
    expect(row.allocated.grossCents).toBe("10.0000000000"); // kept 4 + lost 6
    expect(row.normalLoss.grossCents).toBe("6.0000000000");
    expect(row.support.grossCents).toBe("1.0000000000");
    expect(row.undeclared.grossCents).toBe("2.0000000000");

    // Per occurrence: the loss splits equally over the two units, and Σ occurrences = allocated.
    const occ = await request(app).get(`/internal/outcome-occurrences?runIds=${kept.id},${keptFree.id}&limit=1000`).set(getInternalAuthHeaders());
    expect(occ.status).toBe(200);
    const by = Object.fromEntries(occ.body.occurrences.map((o: any) => [o.subjectId, o.cost.grossCents]));
    expect(by).toEqual({ K1: "7.0000000000", K2: "3.0000000000" });

    // Coverage counts the carried loss as covered; outcome totals carry it on message_sent.
    const cov = await request(app).get(`/internal/stats/outcome-coverage?since=${DAY4}&until=${DAY4}&serviceName=workflow-service`).set(getInternalAuthHeaders());
    const svc = cov.body.services.find((x: any) => x.serviceName === "workflow-service");
    expect(svc).toMatchObject({ spendGrossCents: "13.0000000000", coveredGrossCents: "10.0000000000", supportGrossCents: "1.0000000000" });
    const oc = await request(app).get(`/internal/stats/outcome-costs?since=${DAY4}&until=${DAY4}&orgId=${ORG}&groupBy=outcomeKey`).set(getInternalAuthHeaders());
    const sent = oc.body.produced.find((p: any) => p.dimensions.outcomeKey === "message_sent");
    expect(sent.cost.grossCents).toBe("10.0000000000");
    expect(oc.body.scope[0].undeclared.grossCents).toBe("2.0000000000");
  });

  it("offAncestorMarkOnly leaves out runs whose cost already stops on an ancestor's mark, counted", async () => {
    const DAY5 = "2025-04-19";
    const mk = (taskName: string, hour: string, parentRunId?: string) =>
      insertTestRun({ organizationId: ORG, serviceName: "postmark-service", taskName, status: "completed", parentRunId, startedAt: new Date(`${DAY5}T${hour}:00Z`) });
    const parent = await insertTestRun({ organizationId: ORG, serviceName: "lifecycle-service", taskName: "lifecycle-email", status: "completed", startedAt: new Date(`${DAY5}T08:00:00Z`) });
    expect((await staffMark({ kind: "retired_product", reason: "retired", markedBy: "t", runIds: [parent.id] })).status).toBe(200);
    const underMark = await mk("email-send", "09:00", parent.id);
    await cost(underMark.id, "1", new Date(`${DAY5}T09:01:00Z`));
    const free = await mk("email-send", "10:00");
    await cost(free.id, "1", new Date(`${DAY5}T10:01:00Z`));
    const body = { kind: "product_feature", reason: "t", markedBy: "t", taskNames: ["email-send"], startedAfter: `${DAY5}T00:00:00Z`, startedBefore: `${DAY5}T23:59:59Z`, withSpendOnly: true };
    const plain = await ownerMark("preview", body, "postmark-service");
    expect(plain.body).toMatchObject({ toMarkCount: 2, onAncestorMarkNowCount: 1, leftOnAncestorMarkCount: 0 });
    const skip = await ownerMark("preview", { ...body, offAncestorMarkOnly: true }, "postmark-service");
    expect(skip.body).toMatchObject({ toMarkCount: 1, onAncestorMarkNowCount: 0, leftOnAncestorMarkCount: 1 });
    expect((await ownerMark("apply", { ...body, offAncestorMarkOnly: true }, "postmark-service")).body).toMatchObject({ markedCount: 1 });
    const marks = (await db.execute(sql`SELECT run_id, kind FROM run_support_marks WHERE run_id = ANY(${`{${[underMark.id, free.id].join(",")}}`}::uuid[])`)) as any[];
    expect(marks).toEqual([{ run_id: free.id, kind: "product_feature" }]);
  });
});
