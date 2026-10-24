import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { addDays, computeLedgerDay, daysToCompute, storeLedgerDay, utcDay } from "../../src/services/outcome-ledger.js";

// COST-ACCOUNTING-1023-SWITCH-RUNS (migration 0067): the outcome totals grouped
// by WHEN. A reply consumed today is grouped by the day the send it answers was
// produced (sourceDay) and the day that send's run started (sourceRunStartDay);
// every section can be grouped / cut by the day its run started (runStartDay).

const ORG = "0c05acc0-1024-4c0a-8b1e-0000000000d1";

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

const app = createTestApp();
const TODAY = utcDay(new Date());
const D1 = addDays(TODAY, -1);
const D2 = addDays(TODAY, -2);
const D3 = addDays(TODAY, -3);

async function cost(runId: string, qty: string, day: string) {
  await insertTestRunCost({
    runId,
    costName: "tok",
    quantity: qty,
    unitCostInUsdCents: "5",
    totalCostInUsdCents: new Decimal(qty).times(5).toFixed(10),
    status: "actual",
    createdAt: new Date(`${day}T00:00:01Z`),
  });
}

const run = (day: string, extra: Partial<Parameters<typeof insertTestRun>[0]> = {}) =>
  insertTestRun({ organizationId: ORG, serviceName: "svc", taskName: "task", status: "completed", startedAt: new Date(`${day}T00:00:00Z`), ...extra });

const lead = (outcomeKey: string, subjectId: string) => ({ outcomeKey, subjectService: "lead-service", subjectId });

async function declare(runId: string, body: unknown) {
  const res = await request(app).post(`/v1/runs/${runId}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send(body);
  expect([200, 201]).toContain(res.status);
}

const totals = (query: string) => request(app).get(`/internal/stats/outcome-costs?orgId=${ORG}&since=${D3}&until=${TODAY}&${query}`).set(getInternalAuthHeaders());

const sum = (rows: any[], f: string) => rows.reduce((x: Decimal, g: any) => x.plus(g[f]), new Decimal(0)).toFixed(10);
const sumGross = (rows: any[], f: string) => rows.reduce((x: Decimal, g: any) => x.plus(g[f].grossCents), new Decimal(0)).toFixed(10);

describe("GET /internal/stats/outcome-costs: grouped by when the run started and when the consumed occurrence was produced", () => {
  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockResolvedValue([]);

    // Send A (wf-a) started D3: two sends declared at its start, 10 cents spent that day.
    const a = await run(D3, { workflowSlug: "wf-a", campaignId: "cmp-a" });
    await cost(a.id, "2", D3);
    await declare(a.id, { occurredAt: "run_started_at", produced: [lead("message_sent", "s-a"), lead("message_sent", "s-b")] });
    // Send B (wf-b) started D1: one send, 5 cents; part of its spend lands TODAY (cost day != run start day).
    const b = await run(D1, { workflowSlug: "wf-b", campaignId: "cmp-b" });
    await cost(b.id, "1", D1);
    await cost(b.id, "1", TODAY);
    await declare(b.id, { occurredAt: "run_started_at", produced: [lead("message_sent", "s-c")] });
    // Today an untagged reply-judging run finds replies to s-a and s-c, plus one to a send nobody declared.
    const r = await run(TODAY);
    await cost(r.id, "1", TODAY);
    await declare(r.id, {
      produced: [lead("conversation", "s-a"), lead("conversation", "s-c")],
      consumed: [lead("message_sent", "s-a"), lead("message_sent", "s-c"), lead("message_sent", "s-ghost")],
    });

    for (const day of [D3, D2, D1, TODAY]) await storeLedgerDay(await computeLedgerDay(day, VERSIONS as any));
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("AC: consumptions grouped by source day sum exactly to the ungrouped read, and list the days of the sends replies answered", async () => {
    const flat = await totals("groupBy=");
    expect(flat.status).toBe(200);
    for (const groupBy of ["sourceDay", "sourceRunStartDay", "sourceWorkflowSlug,sourceDay", "sourceWorkflowSlug,sourceRunStartDay,sourceDay"]) {
      const res = await totals(`groupBy=${groupBy}`);
      expect(res.status, groupBy).toBe(200);
      expect(res.body.complete).toBe(true);
      expect(res.body.produced).toEqual(flat.body.produced);
      expect(res.body.scope).toEqual(flat.body.scope);
      for (const f of ["consumptions", "reuses", "unknownProvenance"]) expect(sum(res.body.consumed, f), `${groupBy} ${f}`).toBe(sum(flat.body.consumed, f));
      for (const f of ["standardCost", "reuseGain"]) expect(sumGross(res.body.consumed, f), `${groupBy} ${f}`).toBe(sumGross(flat.body.consumed, f));
    }
    const res = await totals("groupBy=outcomeKey,day,sourceWorkflowSlug,sourceDay,sourceRunStartDay");
    const rows = res.body.consumed.map((g: any) => [
      g.dimensions.consumedOutcomeKey, g.dimensions.day, g.dimensions.sourceWorkflowSlug, g.dimensions.sourceDay, g.dimensions.sourceRunStartDay,
      g.consumptions, g.unknownProvenance, g.standardCost.grossCents,
    ]);
    expect(rows).toEqual([
      ["message_sent", TODAY, null, null, null, "1.0000000000", "1.0000000000", "0.0000000000"],
      ["message_sent", TODAY, "wf-a", D3, D3, "1.0000000000", "0.0000000000", "5.0000000000"],
      ["message_sent", TODAY, "wf-b", D1, D1, "1.0000000000", "0.0000000000", "10.0000000000"],
    ]);
  });

  it("source cut: replies to sends whose run started on or before a cutoff; produced and scope ignore it", async () => {
    const flat = await totals("groupBy=sourceWorkflowSlug");
    const cut = await totals(`groupBy=sourceWorkflowSlug&sourceRunStartUntil=${D2}`);
    expect(cut.status).toBe(200);
    expect(cut.body.consumed.map((g: any) => [g.dimensions.sourceWorkflowSlug, g.consumptions])).toEqual([["wf-a", "1.0000000000"]]);
    expect(cut.body.produced).toEqual(flat.body.produced);
    expect(cut.body.scope).toEqual(flat.body.scope);
    const byDay = await totals(`groupBy=sourceWorkflowSlug&sourceDayUntil=${D1}`);
    expect(byDay.body.consumed.map((g: any) => g.dimensions.sourceWorkflowSlug)).toEqual(["wf-a", "wf-b"]);
  });

  it("runStartDay: produced cost by the day its run started, not the cost row's day; runStartUntil cuts every section", async () => {
    const res = await totals("groupBy=workflowSlug,day,runStartDay");
    const p = res.body.produced
      .filter((g: any) => g.dimensions.workflowSlug === "wf-b")
      .map((g: any) => [g.dimensions.day, g.dimensions.runStartDay, g.occurrences, g.cost.grossCents]);
    // wf-b: declared + 5 spent on D1, 5 more spent TODAY: both on its run's start day D1.
    expect(p).toEqual([
      [D1, D1, 1, "5.0000000000"],
      [TODAY, D1, 0, "5.0000000000"],
    ]);
    // The consuming run's start day on consumptions.
    expect([...new Set(res.body.consumed.map((g: any) => g.dimensions.runStartDay))]).toEqual([TODAY]);

    const flat = await totals("groupBy=");
    const byStart = await totals("groupBy=runStartDay");
    for (const s of ["produced", "scope"]) {
      expect(sumGross(byStart.body[s], s === "produced" ? "cost" : "spend")).toBe(sumGross(flat.body[s], s === "produced" ? "cost" : "spend"));
    }

    const mature = await totals(`groupBy=workflowSlug&runStartUntil=${D1}`);
    expect(mature.body.produced.map((g: any) => [g.dimensions.workflowSlug, g.occurrences, g.cost.grossCents])).toEqual([
      ["wf-a", 2, "10.0000000000"],
      ["wf-b", 1, "10.0000000000"],
    ]);
    expect(mature.body.consumed).toEqual([]);
    expect(mature.body.scope.map((g: any) => g.dimensions.workflowSlug)).toEqual(["wf-a", "wf-b"]);
  });

  it("a day stored before 0067 is missing for a when-read only, and the refresher recomputes it", async () => {
    await db.execute(sql`UPDATE cost_ledger_computed_days SET start_days = false WHERE day = ${D3}::date`);
    try {
      for (const q of ["groupBy=sourceDay", "groupBy=runStartDay", `groupBy=&runStartUntil=${TODAY}`]) {
        const res = await totals(q);
        expect(res.body.daysMissing, q).toEqual([D3]);
      }
      expect((await totals("groupBy=day")).body.daysMissing).toEqual([]);
      expect(await daysToCompute(new Date(), D3)).toContain(D3);
    } finally {
      await db.execute(sql`UPDATE cost_ledger_computed_days SET start_days = true WHERE day = ${D3}::date`);
    }
  });

  it("contract: a bad day filter is a 400", async () => {
    expect((await totals("runStartUntil=yesterday")).status).toBe(400);
    expect((await totals("sourceDayUntil=2026-13-40")).status).toBe(400);
  });
});
