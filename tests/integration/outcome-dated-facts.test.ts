import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { addDays, computeLedgerDay, effectiveDeclaredAt, storeLedgerDay, utcDay } from "../../src/services/outcome-ledger.js";

// MEETING-DATED-OCCURRENCES-1024-RUNS: a SPEND-FREE run (no cost row, no child
// run: lead-service's `outcome-recording`) states a fact reached in the past at
// the instant it happened, before the run's own start, and an occurrence already
// recorded on such a run moves to its day as the SAME occurrence. A run with
// spend never dates an outcome before it started, whatever the order of writes.

const ORG = "0c05acc0-1024-4d0a-8b1e-0000000000d1";

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

vi.mock("../../src/services/cost-resolver.js", () => ({
  resolveMultipleUnitCosts: vi.fn().mockResolvedValue(new Map([["tok", "5.0000000000"]])),
  CostNotFoundError: class CostNotFoundError extends Error {},
  UpstreamError: class UpstreamError extends Error {
    statusCode = 502;
  },
}));
vi.mock("../../src/services/billing.js", () => ({ notifyUsage: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/usage-discount.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/usage-discount.js")>();
  const { Decimal } = await import("decimal.js");
  return { ...actual, resolveUsageDiscount: vi.fn().mockResolvedValue(new Decimal(0)) };
});

const VERSIONS = [
  { costName: "tok", provider: "acme", servedFrom: "2024-01-01T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" },
];

const app = createTestApp();
const TODAY = utcDay(new Date());
const PAST = addDays(TODAY, -40); // the day the meeting was booked
const PAST2 = addDays(TODAY, -20);
const CUT = addDays(TODAY, -10); // an "as of" day between the facts and the recording

const lead = (outcomeKey: string, subjectId: string) => ({ outcomeKey, subjectService: "lead-service", subjectId });
const recordingRun = () => insertTestRun({ organizationId: ORG, serviceName: "lead-service", taskName: "outcome-recording", status: "completed" });
const declare = (runId: string, body: unknown, serviceName?: string) => {
  const r = request(app).post(`/v1/runs/${runId}/outcomes`).set(getAuthHeaders({ orgId: ORG }));
  if (serviceName) r.set("x-service-name", serviceName);
  return r.send(body);
};
const batch = (body: unknown, serviceName = "lead-service") =>
  request(app).post("/v1/platform-runs/outcomes/batch").set(getPlatformAuthHeaders({ serviceName })).send(body);
const occurrencesOf = async (runId: string) => {
  const res = await request(app).get(`/internal/outcome-occurrences?runIds=${runId}&limit=1000`).set(getInternalAuthHeaders());
  expect(res.status).toBe(200);
  return res.body.occurrences as any[];
};
const refresh = async (...days: string[]) => {
  for (const d of days) await storeLedgerDay(await computeLedgerDay(d, VERSIONS as any));
};
const bookedCount = async (until: string) => {
  const res = await request(app)
    .get(`/internal/stats/outcome-costs?orgId=${ORG}&since=${addDays(TODAY, -60)}&until=${until}&groupBy=outcomeKey`)
    .set(getInternalAuthHeaders());
  expect(res.status).toBe(200);
  return res.body.produced.find((g: any) => g.dimensions.outcomeKey === "meeting_booked")?.occurrences ?? 0;
};

describe("Recorded past facts: a spend-free run dates an occurrence before its own start", () => {
  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockResolvedValue([]);
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("effective time: before the start only on a spend-free run, never in the future", () => {
    const started = new Date(`${TODAY}T00:00:00Z`);
    const past = `${PAST}T10:00:00.000Z`;
    expect(effectiveDeclaredAt(past, { started_at: started })).toHaveProperty("error");
    expect(effectiveDeclaredAt(past, { started_at: started, spend_free: false })).toHaveProperty("error");
    expect(effectiveDeclaredAt(past, { started_at: started, spend_free: true })).toEqual({ at: new Date(past), beforeStart: true });
    expect(effectiveDeclaredAt("2999-01-01T00:00:00Z", { started_at: started, spend_free: true })).toHaveProperty("error");
  });

  it("AC 1: a recording run holds an occurrence dated on a past day, owner only; outcome-costs as of a past day counts it; the run then takes no cost and no child", async () => {
    const run = await recordingRun();
    const at = `${PAST}T10:00:00.000Z`;
    const body = { occurredAt: at, produced: [lead("meeting_booked", "M1")] };
    // Not the run's service: refused, nothing written.
    expect((await declare(run.id, body)).status).toBe(403);
    expect((await declare(run.id, body, "instantly-service")).status).toBe(403);
    expect(await occurrencesOf(run.id)).toHaveLength(0);

    const res = await declare(run.id, body, "lead-service");
    expect(res.status).toBe(201);
    expect(res.body.occurrences[0]).toMatchObject({ status: "recorded", declaredAt: at });

    await refresh(PAST, CUT, TODAY);
    expect(await bookedCount(CUT)).toBe(1);
    expect(await bookedCount(addDays(PAST, -1))).toBe(0);

    // Spend is never back-dated: no cost, no child run on it from now on.
    const costRes = await request(app)
      .post(`/v1/runs/${run.id}/costs`)
      .set(getAuthHeaders({ orgId: ORG }))
      .send({ items: [{ costName: "tok", costSource: "platform", quantity: 1 }] });
    expect(costRes.status).toBe(409);
    expect(costRes.body.error).toBe("run_holds_dated_facts");
    await expect(insertTestRunCost({ runId: run.id, costName: "tok", quantity: "1", unitCostInUsdCents: "5", totalCostInUsdCents: "5.0000000000", status: "actual" })).rejects.toThrow();
    await expect(insertTestRun({ organizationId: ORG, serviceName: "lead-service", taskName: "child", parentRunId: run.id })).rejects.toThrow();
  });

  it("AC 2: an occurrence recorded on time on a recording run moves to its own day as the SAME occurrence; each occurrence gets its own time; the count never changes", async () => {
    const run = await recordingRun();
    const today = await declare(run.id, { produced: [lead("meeting_booked", "M2"), lead("meeting_booked", "M3")] });
    expect(today.status).toBe(201);
    const before = await occurrencesOf(run.id);
    await refresh(PAST, PAST2, CUT, TODAY);
    const total = await bookedCount(TODAY);
    expect(await bookedCount(CUT)).toBe(1); // only M1 of the previous test

    // One batch call per time: only the listed occurrence moves.
    const m2 = await batch({ runs: [{ runId: run.id, occurredAt: `${PAST}T09:00:00.000Z`, redate: true, produced: [lead("meeting_booked", "M2")] }] });
    expect(m2.status).toBe(201);
    expect(m2.body).toMatchObject({ redatedCount: 1, recordedCount: 0 });
    const m3 = await batch({ runs: [{ runId: run.id, occurredAt: `${PAST2}T15:00:00.000Z`, redate: true, produced: [lead("meeting_booked", "M3")] }] });
    expect(m3.body).toMatchObject({ redatedCount: 1, recordedCount: 0 });
    // Another service may not move it.
    const foreign = await batch({ runs: [{ runId: run.id, occurredAt: `${PAST}T08:00:00.000Z`, redate: true, produced: [lead("meeting_booked", "M2")] }] }, "instantly-service");
    expect(foreign.status).toBe(422);
    expect(foreign.body.details.invalid[0].reason).toBe("not_run_owner");

    const after = await occurrencesOf(run.id);
    expect(after.map((o) => o.id).sort()).toEqual(before.map((o) => o.id).sort());
    expect(Object.fromEntries(after.map((o) => [o.subjectId, o.declaredAt]))).toEqual({ M2: `${PAST}T09:00:00.000Z`, M3: `${PAST2}T15:00:00.000Z` });

    await refresh(PAST, PAST2, CUT, TODAY);
    expect(await bookedCount(TODAY)).toBe(total);
    expect(await bookedCount(CUT)).toBe(3);
    const chk = await request(app).get(`/internal/outcome-costs/ledger-check?since=${PAST}&until=${TODAY}`).set(getInternalAuthHeaders());
    expect(chk.body.balanced).toBe(true);
  });

  it("AC 3: a run with spend (a cost row, or a child run) still refuses an occurrence dated before its start, on every door", async () => {
    const spent = await insertTestRun({ organizationId: ORG, serviceName: "lead-service", taskName: "lead-serve", status: "completed" });
    await insertTestRunCost({ runId: spent.id, costName: "tok", quantity: "1", unitCostInUsdCents: "5", totalCostInUsdCents: "5.0000000000", status: "actual" });
    const one = await declare(spent.id, { occurredAt: `${PAST}T10:00:00.000Z`, produced: [lead("lead_found", "S1")] }, "lead-service");
    expect(one.status).toBe(400);
    expect(one.body.error).toBe("invalid_occurred_at");
    const many = await batch({ runs: [{ runId: spent.id, occurredAt: `${PAST}T10:00:00.000Z`, produced: [lead("lead_found", "S1")] }] });
    expect(many.status).toBe(422);
    expect(many.body.details.invalid[0].reason).toBe("invalid_occurred_at");

    const parent = await recordingRun();
    await insertTestRun({ organizationId: ORG, serviceName: "lead-service", taskName: "child", parentRunId: parent.id });
    expect((await declare(parent.id, { occurredAt: `${PAST}T10:00:00.000Z`, produced: [lead("lead_found", "S2")] }, "lead-service")).status).toBe(400);

    // Redate on a run with spend: still bounded by its start.
    await declare(spent.id, { produced: [lead("lead_found", "S3")] });
    const redate = await batch({ runs: [{ runId: spent.id, occurredAt: `${PAST}T10:00:00.000Z`, redate: true, produced: [lead("lead_found", "S3")] }] });
    expect(redate.status).toBe(422);
    expect(await occurrencesOf(spent.id)).toHaveLength(1);
  });

  it("RUN-STARTED-AT-US-1024: run_started_at on a run with a child and a cost whose start holds microseconds is at its start, never before", async () => {
    const parent = await insertTestRun({ organizationId: ORG, serviceName: "workflow-service", taskName: "execute-workflow", status: "completed" });
    await db.execute(sql`UPDATE runs SET started_at = '2026-10-23 20:41:57.323548+00' WHERE id = ${parent.id}::uuid`);
    await insertTestRun({ organizationId: ORG, serviceName: "chat-service", taskName: "complete", status: "completed", parentRunId: parent.id });
    await insertTestRunCost({ runId: parent.id, costName: "tok", quantity: "1", unitCostInUsdCents: "5", totalCostInUsdCents: "5", createdAt: new Date("2026-10-23T20:42:00Z") });
    const res = await batch({ runs: [{ runId: parent.id, occurredAt: "run_started_at", produced: [lead("booking_call", "U1")] }] }, "workflow-service");
    expect(res.status).toBe(201);
    const [occ] = await occurrencesOf(parent.id);
    expect(occ.declaredAt).toBe("2026-10-23T20:41:57.323Z");
    // ... and the run still takes spend and children afterwards.
    await insertTestRun({ organizationId: ORG, serviceName: "chat-service", taskName: "complete", status: "completed", parentRunId: parent.id });
    // A time a full millisecond before the start stays refused.
    const before = await batch({ runs: [{ runId: parent.id, occurredAt: "2026-10-23T20:41:57.322Z", produced: [lead("booking_call", "U2")] }] }, "workflow-service");
    expect(before.status).not.toBe(201);
  });
});
