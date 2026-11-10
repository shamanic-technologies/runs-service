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
  reassessStaleDays,
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

  it("a BACK-DATED declaration on a run that spends still stales every day from its run's start (it re-anchors its cost rows)", async () => {
    const computedAt = new Date(Date.now() - 60_000);
    const D = addDays(TODAY, -345);
    const D3 = addDays(TODAY, -342);
    const computed = new Map([D, D3].map((d) => [d, computedAt]));
    const r = await insertTestRun({ organizationId: ORG, serviceName: "svc", taskName: "spend", status: "completed", startedAt: new Date(`${D}T08:00:00Z`) });
    await insertTestRunCost({ runId: r.id, costName: "tok", quantity: "1", unitCostInUsdCents: "5", totalCostInUsdCents: new Decimal(5).toFixed(10), status: "actual", createdAt: new Date(`${D}T08:00:01Z`) });
    const res = await request(app).post(`/v1/runs/${r.id}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send({ occurredAt: `${addDays(D, 1)}T10:00:00.000Z`, produced: [lead("email_found", "stale-1107-b1")] });
    expect([200, 201]).toContain(res.status);
    const after = await staleComputedDays(computed, computedAt);
    expect(after.has(D)).toBe(true);
    expect(after.has(D3)).toBe(true);
  });

  it("a SECOND declaration on a run that spends still stales every day from its run's start (it moves its earlier units' split)", async () => {
    const D = addDays(TODAY, -350);
    const D3 = addDays(TODAY, -347);
    const r = await insertTestRun({ organizationId: ORG, serviceName: "svc", taskName: "spend", status: "completed", startedAt: new Date(`${D}T08:00:00Z`) });
    await insertTestRunCost({ runId: r.id, costName: "tok", quantity: "1", unitCostInUsdCents: "5", totalCostInUsdCents: new Decimal(5).toFixed(10), status: "actual", createdAt: new Date(`${D}T08:00:01Z`) });
    const first = await request(app).post(`/v1/runs/${r.id}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send({ produced: [lead("email_found", "stale-1110-s1")] });
    expect([200, 201]).toContain(first.status);
    const computedAt = new Date(Date.now() + 1_000);
    await new Promise((ok) => setTimeout(ok, 1_100));
    const computed = new Map([D, D3].map((d) => [d, computedAt]));
    const second = await request(app).post(`/v1/runs/${r.id}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send({ produced: [lead("email_found", "stale-1110-s2")] });
    expect([200, 201]).toContain(second.status);
    const after = await staleComputedDays(computed, computedAt);
    expect(after.has(D)).toBe(true);
    expect(after.has(D3)).toBe(true);
  });

  // DASH-SPEED-1110 (prod 2026-11-09): apollo declared email_found DATED at its 2026-02-10 run's start.
  it("a run's FIRST back-dated declaration on a line that already produced stales its cost days, its own day and its subject's later days only", async () => {
    const D0 = addDays(TODAY, -380);
    const D1 = addDays(TODAY, -379);
    const D2 = addDays(TODAY, -378);
    const D3 = addDays(TODAY, -377);
    const days = [D0, D1, D2, D3];
    const cost = (runId: string, day: string, q: string) =>
      insertTestRunCost({ runId, costName: "tok", quantity: q, unitCostInUsdCents: "5", totalCostInUsdCents: new Decimal(5).times(q).toFixed(10), status: "actual", createdAt: new Date(`${day}T08:00:01Z`) });
    const run = (task: string, day: string, hour: string, parentRunId?: string) =>
      insertTestRun({ organizationId: ORG, parentRunId, serviceName: "apollo", taskName: task, status: "completed", startedAt: new Date(`${day}T${hour}:00:00Z`) });
    // The line apollo/enrich-bd already produced on D0 (an earlier run), so R's dated fact moves no line.
    const r0 = await run("enrich-bd", D0, "06");
    await cost(r0.id, D0, "1");
    const d0 = await request(app).post(`/v1/runs/${r0.id}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send({ occurredAt: `${D0}T06:30:00.000Z`, produced: [lead("email_found", "stale-1110-bd0")] });
    expect([200, 201]).toContain(d0.status);
    // R spends on D0, its child on D2; a send on D3 consumes R's subject; D1 has unrelated spend.
    const r = await run("enrich-bd", D0, "08");
    await cost(r.id, D0, "2");
    const c = await run("child-bd", D2, "08", r.id);
    await cost(c.id, D2, "1");
    const send = await run("send-bd", D3, "08");
    await cost(send.id, D3, "1");
    const sent = await request(app).post(`/v1/runs/${send.id}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send({ occurredAt: `${D3}T08:30:00.000Z`, consumed: [lead("email_found", "stale-1110-bd1")] });
    expect([200, 201]).toContain(sent.status);
    const u = await run("unrelated-bd", D1, "08");
    await cost(u.id, D1, "4");

    const figures = async (day: string) => {
      const { computedAt: _c, ...rest } = await computeLedgerDay(day, VERSIONS as any);
      return JSON.stringify(rest);
    };
    const before = new Map<string, string>();
    for (const d of days) before.set(d, await figures(d));
    await new Promise((ok) => setTimeout(ok, 20));
    const computedAt = new Date(Date.now() - 1);
    await new Promise((ok) => setTimeout(ok, 20));
    const computed = new Map(days.map((d) => [d, computedAt]));
    expect((await staleComputedDays(computed, computedAt)).size).toBe(0);

    const res = await request(app).post(`/v1/runs/${r.id}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send({ occurredAt: `${D0}T08:30:00.000Z`, produced: [lead("email_found", "stale-1110-bd1")] });
    expect([200, 201]).toContain(res.status);

    const stale = await staleComputedDays(computed, computedAt);
    expect([...stale].sort()).toEqual([D0, D2, D3]); // cost days of R + C, its own day, the later consumption of its subject
    for (const d of days) {
      if (stale.has(d)) continue;
      expect(await figures(d), `day ${d} moved but was not flagged stale`).toBe(before.get(d));
    }
    expect(await figures(D3)).not.toBe(before.get(D3)); // the D3 consumption now resolves to R's unit
  });

  // DASH-SPEED-1110: one email_found Apollo declared on a 2026-02-10 run re-staled 273 days.
  it("a run's FIRST on-time declaration stales only its subtree's cost days and its own day; every other day recomputes byte for byte", async () => {
    const D0 = addDays(TODAY, -360);
    const D1 = addDays(TODAY, -359);
    const D2 = addDays(TODAY, -358);
    const D3 = addDays(TODAY, -357);
    const days = [D0, D1, D2, D3];
    const cost = (runId: string, day: string, q: string) =>
      insertTestRunCost({ runId, costName: "tok", quantity: q, unitCostInUsdCents: "5", totalCostInUsdCents: new Decimal(5).times(q).toFixed(10), status: "actual", createdAt: new Date(`${day}T08:00:01Z`) });
    // A workflow run A produced message_sent on D0; its children spend on D0 and D1 (riding A's unit).
    const a = await insertTestRun({ organizationId: ORG, serviceName: "workflow", taskName: "execute-workflow", workflowSlug: "stale-1110-wf", status: "completed", startedAt: new Date(`${D0}T07:00:00Z`) });
    await db.execute(sql`UPDATE runs SET completed_at = ${`${D1}T23:00:00Z`}::timestamptz WHERE id = ${a.id}::uuid`);
    const decA = await request(app).post(`/v1/runs/${a.id}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send({ produced: [lead("message_sent", "stale-1110-a")] });
    expect([200, 201]).toContain(decA.status);
    await db.execute(sql`UPDATE run_outcomes SET declared_at = ${`${D0}T07:30:00Z`}::timestamptz, recorded_at = ${`${D0}T07:30:00Z`}::timestamptz WHERE run_id = ${a.id}::uuid`);
    const other = await insertTestRun({ organizationId: ORG, parentRunId: a.id, serviceName: "svc", taskName: "other", status: "completed", startedAt: new Date(`${D1}T08:00:00Z`) });
    await cost(other.id, D1, "3");
    // R (under A) spends on D0; its child C spends on D2. R has not declared yet.
    const r = await insertTestRun({ organizationId: ORG, parentRunId: a.id, serviceName: "apollo", taskName: "enrichment", status: "completed", startedAt: new Date(`${D0}T08:00:00Z`) });
    await cost(r.id, D0, "2");
    const c = await insertTestRun({ organizationId: ORG, parentRunId: r.id, serviceName: "svc", taskName: "child", status: "completed", startedAt: new Date(`${D2}T08:00:00Z`) });
    await cost(c.id, D2, "1");
    // D3 holds unrelated spend of the org.
    const u = await insertTestRun({ organizationId: ORG, serviceName: "svc", taskName: "unrelated", status: "completed", startedAt: new Date(`${D3}T08:00:00Z`) });
    await cost(u.id, D3, "4");

    const figures = async (day: string) => {
      const d = await computeLedgerDay(day, VERSIONS as any);
      const { computedAt: _c, ...rest } = d;
      return JSON.stringify(rest);
    };
    const before = new Map<string, string>();
    for (const d of days) before.set(d, await figures(d));
    for (const d of days) await storeLedgerDay(await computeLedgerDay(d, VERSIONS as any));
    await new Promise((ok) => setTimeout(ok, 20));
    const computedAt = new Date(Date.now() - 1_000);
    const computed = new Map(days.map((d) => [d, computedAt]));
    expect((await staleComputedDays(computed, computedAt)).size).toBe(0);

    const res = await request(app).post(`/v1/runs/${r.id}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send({ produced: [lead("email_found", "stale-1110-r")] });
    expect([200, 201]).toContain(res.status);

    const stale = await staleComputedDays(computed, computedAt);
    expect([...stale].sort()).toEqual([D0, D2]); // R's and C's cost days; R's declaration day is today
    for (const d of days) {
      const now = await figures(d);
      if (stale.has(d)) continue;
      expect(now, `day ${d} moved but was not flagged stale`).toBe(before.get(d));
    }
    // The flagged days did move (R now anchors its own and C's cost).
    expect(await figures(D0)).not.toBe(before.get(D0));
    expect(await figures(D2)).not.toBe(before.get(D2));

    // A sweep under the old broad rule PERSISTED every day as stale: re-judged, only D0 and D2 keep their flag.
    await db.execute(sql`UPDATE cost_ledger_computed_days SET stale = true WHERE allocation_version = ${ALLOCATION_VERSION} AND day = ANY(${`{${days.join(",")}}`}::date[])`);
    const r2 = await reassessStaleDays();
    expect(r2.flagged).toBeGreaterThanOrEqual(4);
    const flags = (await db.execute(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, stale FROM cost_ledger_computed_days
      WHERE allocation_version = ${ALLOCATION_VERSION} AND day = ANY(${`{${days.join(",")}}`}::date[]) ORDER BY day
    `)) as any[];
    expect(flags.map((f) => [f.day, f.stale])).toEqual([[D0, true], [D1, false], [D2, true], [D3, false]]);
  });
});
