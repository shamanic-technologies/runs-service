import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import {
  ALLOCATION_VERSION,
  addDays,
  computeLedgerDay,
  refreshLedgerDays,
  staleComputedDays,
  storeLedgerDay,
  utcDay,
} from "../../src/services/outcome-ledger.js";

// LEDGER-STALE-1107: a fact dated on a past day (lead-service back-declared 108 signups + 34
// paid clients from 2026-03-23 on, on spend-free recording runs) makes that day's stored totals
// current on its own, under the current allocation version; and a spend-free run's past fact
// stales only the days it can move, never every day after it (276 of 279 days went stale at once).

const ORG = "0c05acc0-1107-4c0a-8b1e-0000000000e1";

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
const D30 = addDays(TODAY, -30);
// Far back for the narrowing checks: no other file's run lands on these days (shared shard database).
const N0 = addDays(TODAY, -330);
const N5 = addDays(TODAY, -325);
const N10 = addDays(TODAY, -320);

const lead = (outcomeKey: string, subjectId: string) => ({ outcomeKey, subjectService: "lead-service", subjectId });
const recordingRun = () => insertTestRun({ organizationId: ORG, serviceName: "lead-service", taskName: "outcome-recording", status: "completed" });
const declare = (runId: string, body: unknown) =>
  request(app).post(`/v1/runs/${runId}/outcomes`).set(getAuthHeaders({ orgId: ORG })).set("x-service-name", "lead-service").send(body);
const storedSignups = async (day: string) => {
  const [r] = (await db.execute(sql`
    SELECT COALESCE(SUM(n), 0)::text AS n FROM outcome_cost_days
    WHERE day = ${day}::date AND allocation_version = ${ALLOCATION_VERSION} AND kind = 'produced_count'
      AND outcome_key = 'signup' AND organization_id = ${ORG}::uuid
  `)) as any[];
  return Number(r.n);
};

describe("LEDGER-STALE-1107: a past-dated fact refreshes its stored day by itself", () => {
  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockResolvedValue([]);
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("AC: a Unit declared today dated 30 days ago is in that day's stored totals after the refresher runs, under the current version", async () => {
    // The day is stored (current) before the fact is recorded.
    await storeLedgerDay(await computeLedgerDay(D30, VERSIONS as any));
    expect(await storedSignups(D30)).toBe(0);

    const run = await recordingRun();
    const res = await declare(run.id, { occurredAt: `${D30}T10:00:00.000Z`, produced: [lead("signup", "stale-1107-s1")] });
    expect(res.status).toBe(201);

    const { computed, failed } = await refreshLedgerDays(new Date(), Infinity, D30);
    expect(failed).toEqual([]);
    expect(computed).toContain(D30);
    expect(await storedSignups(D30)).toBe(1);
    const [day] = (await db.execute(sql`
      SELECT stale FROM cost_ledger_computed_days WHERE day = ${D30}::date AND allocation_version = ${ALLOCATION_VERSION}
    `)) as any[];
    expect(day.stale).toBe(false);
  });

  it("a tick that leaves past days due says how many (the refresher then starts the paced backfill)", async () => {
    await db.execute(sql`DELETE FROM cost_ledger_computed_days WHERE day = ${D30}::date AND allocation_version = ${ALLOCATION_VERSION}`);
    const r = await refreshLedgerDays(new Date(), Infinity, D30, 0);
    expect(r.computed).toEqual([]);
    expect(r.pastDaysDue).toBeGreaterThan(0);
    await storeLedgerDay(await computeLedgerDay(D30, VERSIONS as any));
  });

  it("a spend-free run's past fact stales its own day and the later run days of its subject, never every later day", async () => {
    // The same lead was emailed on N10 by a run that spends (its consumption may now resolve to the fact).
    const send = await insertTestRun({ organizationId: ORG, serviceName: "svc", taskName: "send", status: "completed", startedAt: new Date(`${N10}T08:00:00Z`) });
    await db.execute(sql`UPDATE runs SET completed_at = ${`${N10}T09:00:00Z`}::timestamptz WHERE id = ${send.id}::uuid`);
    await insertTestRunCost({ runId: send.id, costName: "tok", quantity: "1", unitCostInUsdCents: "5", totalCostInUsdCents: new Decimal(5).toFixed(10), status: "actual", createdAt: new Date(`${N10}T08:00:01Z`) });
    const sent = await request(app).post(`/v1/runs/${send.id}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send({ consumed: [lead("lead_found", "stale-1107-n1")] });
    expect([200, 201]).toContain(sent.status);
    await db.execute(sql`UPDATE run_outcomes SET declared_at = ${`${N10}T08:30:00Z`}::timestamptz, recorded_at = ${`${N10}T08:30:00Z`}::timestamptz WHERE run_id = ${send.id}::uuid`);

    const computedAt = new Date(Date.now() - 60_000);
    const computed = new Map([N0, N5, N10, addDays(TODAY, -315)].map((d) => [d, computedAt]));
    const before = await staleComputedDays(computed, computedAt);

    const run = await recordingRun();
    const res = await declare(run.id, { occurredAt: `${N0}T10:00:00.000Z`, produced: [lead("lead_found", "stale-1107-n1")] });
    expect(res.status).toBe(201);

    const after = await staleComputedDays(computed, computedAt);
    expect(after.has(N0)).toBe(true); // the fact's own day
    expect(after.has(N10)).toBe(true); // a later run of the same lead
    expect(after.has(N5)).toBe(before.has(N5)); // nothing of the lead that day: untouched
    expect(after.has(addDays(TODAY, -315))).toBe(before.has(addDays(TODAY, -315)));
  });

  it("a declaration on a run that spends still stales every day from its run's start (it re-anchors its cost rows)", async () => {
    const computedAt = new Date(Date.now() - 60_000);
    const D = addDays(TODAY, -345);
    const D3 = addDays(TODAY, -342);
    const computed = new Map([D, D3].map((d) => [d, computedAt]));
    const r = await insertTestRun({ organizationId: ORG, serviceName: "svc", taskName: "spend", status: "completed", startedAt: new Date(`${D}T08:00:00Z`) });
    await insertTestRunCost({ runId: r.id, costName: "tok", quantity: "1", unitCostInUsdCents: "5", totalCostInUsdCents: new Decimal(5).toFixed(10), status: "actual", createdAt: new Date(`${D}T08:00:01Z`) });
    const res = await request(app).post(`/v1/runs/${r.id}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send({ produced: [lead("email_found", "stale-1107-b1")] });
    expect([200, 201]).toContain(res.status);
    const after = await staleComputedDays(computed, computedAt);
    expect(after.has(D)).toBe(true);
    expect(after.has(D3)).toBe(true);
  });
});
