import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { addDays, computeLedgerDay, daysToCompute, storeLedgerDay, utcDay } from "../../src/services/outcome-ledger.js";

// LEDGER-REVERSAL-1107: the service that declared a produced occurrence reverses it when the fact behind
// it is taken back (prod 2026-11-07: 3 paid_client Units of brand 75d7e3e8 whose sale was withdrawn).
// A counter-entry dated on the reversal: the count drops by one from that day on, earlier days unchanged.

const ORG = "0c05acc0-1107-4c0a-8b1e-000000000777";
const BRAND = "brand-ledger-reversal-1107";

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
const D = addDays(TODAY, -9); // declaration day
const R = addDays(TODAY, -5); // reversal day
const KEY = "lead_found";

const asLead = () => getPlatformAuthHeaders({ serviceName: "lead-service" });
const reverse = (headers: Record<string, string>, body: unknown) =>
  request(app).post("/v1/platform-runs/outcomes/reversals").set(headers).send(body);

async function storeDays(days: string[]) {
  for (const d of days) await storeLedgerDay(await computeLedgerDay(d, VERSIONS as any));
}

async function producedByDay(until: string) {
  const res = await request(app)
    .get(`/internal/stats/outcome-costs?since=${D}&until=${until}&brandId=${BRAND}&outcomeKey=${KEY}&groupBy=outcomeKey,day`)
    .set(getInternalAuthHeaders());
  expect(res.status).toBe(200);
  const byDay: Record<string, number> = {};
  for (const g of res.body.produced) byDay[g.dimensions.day] = (byDay[g.dimensions.day] ?? 0) + g.occurrences;
  return { byDay, total: Object.values(byDay).reduce((a, b) => a + b, 0), daysMissing: res.body.daysMissing as string[] };
}

async function performerCount(until: string) {
  const res = await request(app)
    .get(`/internal/stats/outcome-performers?since=${D}&until=${until}&brandId=${BRAND}&outcomeKey=${KEY}&groupBy=outcomeKey`)
    .set(getInternalAuthHeaders());
  expect(res.status).toBe(200);
  return { group: res.body.groups[0]?.count ?? 0, total: res.body.totals.count };
}

const reversedEvents = async () =>
  Number(((await db.execute(sql`SELECT count(*)::int AS n FROM outcome_declaration_events WHERE event_type = 'outcomes.reversed'`)) as any[])[0].n);

describe("LEDGER-REVERSAL-1107: the declaring service reverses a produced occurrence", () => {
  let runId: string;
  const item = (subjectId: string, extra: Record<string, unknown> = {}) => ({
    runId,
    outcomeKey: KEY,
    subjectService: "lead-service",
    subjectId,
    reversedAt: `${R}T12:00:00.000Z`,
    reason: "sale withdrawn",
    ...extra,
  });

  beforeAll(async () => {
    await cleanTestData([ORG]);
    await db.execute(sql`DELETE FROM cost_ledger_days`);
    await db.execute(sql`DELETE FROM outcome_coverage_days`);
    await db.execute(sql`DELETE FROM cost_ledger_computed_days`);
    await db.execute(sql`DELETE FROM outcome_cost_days`);
    await db.execute(sql`DELETE FROM cost_ledger_stale_sweeps`);
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockResolvedValue([]);
    // A spend-free recording run of lead-service: two Units declared on day D.
    const run = await insertTestRun({
      organizationId: ORG, serviceName: "lead-service", taskName: "outcome-recording", brandIds: [BRAND], status: "completed",
      startedAt: new Date(`${D}T09:00:00Z`),
    });
    runId = run.id;
    const declared = await request(app)
      .post("/v1/platform-runs/outcomes/batch")
      .set(asLead())
      .send({ runs: [{ runId, occurredAt: `${D}T10:00:00.000Z`, produced: [{ outcomeKey: KEY, subjectService: "lead-service", subjectId: "lead-1" }, { outcomeKey: KEY, subjectService: "lead-service", subjectId: "lead-2" }] }] });
    expect(declared.status).toBe(201);
    await storeDays([D, R, addDays(R, 1)]);
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("before any reversal: two Units on day D", async () => {
    const p = await producedByDay(addDays(R, 1));
    expect(p.daysMissing.filter((d) => [D, R].includes(d))).toEqual([]);
    expect(p.byDay).toEqual({ [D]: 2 });
    expect(await performerCount(R)).toEqual({ group: 2, total: 2 });
  });

  it("another service cannot reverse it (403, nothing written)", async () => {
    const res = await reverse(getPlatformAuthHeaders({ serviceName: "instantly-service" }), { reversedBy: "x", reversals: [item("lead-1")] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_occurrence_declarer");
    expect(res.body.details.refusals[0]).toMatchObject({ subjectId: "lead-1", reason: "not_occurrence_declarer" });
    expect(await reversedEvents()).toBe(0);
  });

  it("refuses a reversal dated before the declaration, an unknown occurrence, a foreign org: all or nothing (422)", async () => {
    const res = await reverse(asLead(), {
      reversedBy: "lead-service",
      reversals: [item("lead-1", { reversedAt: `${D}T09:30:00.000Z` }), item("lead-9"), item("lead-2")],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_reversals");
    expect(res.body.details.refusals.map((r: any) => `${r.subjectId}:${r.reason}`)).toEqual(["lead-1:invalid_reversed_at", "lead-9:occurrence_not_found"]);
    const foreign = await reverse({ ...asLead(), "x-org-id": "0c05acc0-1107-4c0a-8b1e-000000000778" }, { reversedBy: "lead-service", reversals: [item("lead-1")] });
    expect(foreign.status).toBe(422);
    expect(foreign.body.details.refusals[0].reason).toBe("run_org_mismatch");
    expect(await reversedEvents()).toBe(0);
  });

  it("reverses: the count drops by one from the reversal day, earlier days unchanged; the occurrence stays", async () => {
    const res = await reverse({ ...asLead(), "x-org-id": ORG }, { reversedBy: "lead-service LEDGER-DECLARE-1107", reversals: [item("lead-1")] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ reversedCount: 1, alreadyReversedCount: 0 });
    expect(res.body.reversals[0]).toMatchObject({
      runId, outcomeKey: KEY, subjectId: "lead-1", status: "reversed",
      declaredAt: `${D}T10:00:00.000Z`, reversedAt: `${R}T12:00:00.000Z`, reason: "sale withdrawn", reversedBy: "lead-service LEDGER-DECLARE-1107",
    });

    // Exactly the reversal's day goes stale; the declaration day keeps its stored figures.
    const due = await daysToCompute();
    expect(due).toContain(R);
    expect(due).not.toContain(D);
    expect(due).not.toContain(addDays(R, 1));
    expect((await producedByDay(addDays(R, 1))).daysMissing).toContain(R);
    await storeDays([R]);

    const after = await producedByDay(addDays(R, 1));
    expect(after.daysMissing.filter((d) => [D, R].includes(d))).toEqual([]);
    expect(after.byDay).toEqual({ [D]: 2, [R]: -1 });
    expect(after.total).toBe(1);
    // A range ending before the reversal reads the past as it was.
    expect((await producedByDay(addDays(R, -1))).total).toBe(2);
    // Recomputing the declaration day changes nothing.
    await storeDays([D]);
    expect((await producedByDay(addDays(R, 1))).byDay).toEqual({ [D]: 2, [R]: -1 });

    // Performer stats: same counter-entry.
    expect(await performerCount(addDays(R, -1))).toEqual({ group: 2, total: 2 });
    expect(await performerCount(R)).toEqual({ group: 1, total: 1 });

    // The occurrence is kept, with its reversal.
    const occ = await request(app).get(`/internal/outcome-occurrences?runIds=${runId}`).set(getInternalAuthHeaders());
    expect(occ.status).toBe(200);
    const bySubject = Object.fromEntries(occ.body.occurrences.map((o: any) => [o.subjectId, o]));
    expect(bySubject["lead-1"].reversal).toMatchObject({ reversedAt: `${R}T12:00:00.000Z`, reason: "sale withdrawn", reversedBy: "lead-service LEDGER-DECLARE-1107" });
    expect(bySubject["lead-2"].reversal).toBeNull();
  });

  it("a replay writes nothing and serves the stored reversal", async () => {
    const before = await reversedEvents();
    const res = await reverse(asLead(), { reversedBy: "someone else", reversals: [item("lead-1", { reversedAt: `${addDays(R, 1)}T08:00:00.000Z` })] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reversedCount: 0, alreadyReversedCount: 1 });
    expect(res.body.reversals[0]).toMatchObject({ status: "already_reversed", reversedAt: `${R}T12:00:00.000Z`, reversedBy: "lead-service LEDGER-DECLARE-1107" });
    expect(await reversedEvents()).toBe(before);
    expect(await daysToCompute()).not.toContain(addDays(R, 1));
    expect((await producedByDay(addDays(R, 1))).total).toBe(1);
  });

  it("a void of the run takes the reversal with it: nothing is subtracted twice", async () => {
    const res = await request(app)
      .post(`/v1/platform-runs/${runId}/outcomes/void`)
      .set(asLead())
      .send({ reason: "test", voidedBy: "LEDGER-REVERSAL-1107" });
    expect(res.status).toBe(201);
    const left = (await db.execute(sql`SELECT count(*)::int AS n FROM run_outcome_reversals WHERE run_id = ${runId}::uuid`)) as any[];
    expect(Number(left[0].n)).toBe(0);
    await storeDays([D, R]);
    expect((await producedByDay(addDays(R, 1))).byDay).toEqual({});
  });
});
