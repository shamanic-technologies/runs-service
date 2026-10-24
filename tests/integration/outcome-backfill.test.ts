import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { computeLedgerDay, daysToCompute, storeLedgerDay, effectiveDeclaredAt } from "../../src/services/outcome-ledger.js";

// COST-BACKFILL-1023-RUNS: a producer declares the outcomes of a PAST run with
// `occurredAt`; for consumption resolution, reuse ranking and every stored day
// series they behave as if declared when the run happened.

const ORG = "0c05acc0-1023-4c0a-8b1e-0000000000b1";
const ORG_X = "0c05acc0-1023-4c0a-8b1e-0000000000b2";

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
const CATALOGUE = new Set(["lead_found", "message_sent", "email_checked"]);

// A past day, its own: no other test file writes spend on it.
const PDAY = "2025-03-17";
const NOW = new Date("2025-03-30T12:00:00Z");
const FLOOR = "2025-03-01";
const app = createTestApp();
const zero = "0.0000000000";

const pastRun = (serviceName: string, hour: string, organizationId: string = ORG) =>
  insertTestRun({ organizationId, serviceName, taskName: "task", status: "completed", startedAt: new Date(`${PDAY}T${hour}:00Z`) });
const cost = (runId: string, cents: string, hour: string) =>
  insertTestRunCost({
    runId,
    costName: "tok",
    quantity: new Decimal(cents).div(5).toString(),
    unitCostInUsdCents: "5",
    totalCostInUsdCents: new Decimal(cents).toFixed(10),
    status: "actual",
    createdAt: new Date(`${PDAY}T${hour}:00Z`),
  });
const lead = (outcomeKey: string, subjectId: string) => ({ outcomeKey, subjectService: "lead-service", subjectId });
const batch = (body: unknown, serviceName = "lead-service") =>
  request(app).post("/v1/platform-runs/outcomes/batch").set(getPlatformAuthHeaders({ serviceName })).send(body);
async function occurrencesOf(runId: string) {
  const res = await request(app).get(`/internal/outcome-occurrences?runIds=${runId}&limit=1000`).set(getInternalAuthHeaders());
  expect(res.status).toBe(200);
  return res.body.occurrences as any[];
}
async function storedDay(day: string) {
  return (await db.execute(sql`
    SELECT 'ledger' AS t, organization_id::text AS k, allocated_gross::text AS a, none_gross::text AS b, ledger_gross::text AS c FROM cost_ledger_days WHERE day = ${day}::date
    UNION ALL SELECT 'cov', service_name || '/' || task_name, spend_gross::text, covered_gross::text, '' FROM outcome_coverage_days WHERE day = ${day}::date
    UNION ALL SELECT 'oc:' || kind, concat_ws('|', outcome_key, consumed_outcome_key, organization_id, cost_organization_id), n::text, gross::text, reuses::text
      FROM outcome_cost_days WHERE day = ${day}::date
    ORDER BY 1, 2, 3, 4, 5
  `)) as any[];
}
async function clearDay(day: string) {
  await db.execute(sql`DELETE FROM cost_ledger_days WHERE day = ${day}::date`);
  await db.execute(sql`DELETE FROM outcome_coverage_days WHERE day = ${day}::date`);
  await db.execute(sql`DELETE FROM outcome_cost_days WHERE day = ${day}::date`);
  await db.execute(sql`DELETE FROM cost_ledger_computed_days WHERE day = ${day}::date`);
}
const refresh = async (day: string) => storeLedgerDay(await computeLedgerDay(day, VERSIONS as any));
const orgRow = (rows: any[]) => rows.find((r) => r.t === "ledger" && r.k === ORG);

describe("Backfill: declaring the outcomes of past runs", () => {
  beforeAll(async () => {
    await cleanTestData([ORG, ORG_X]);
    await clearDay(PDAY);
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockImplementation(async (keys: string[]) => keys.filter((k) => !CATALOGUE.has(k)));
  });

  afterAll(async () => {
    await cleanTestData([ORG, ORG_X]);
    await clearDay(PDAY);
    await closeDb();
  });

  it("effective time: absent = on time, run_started_at = the run's start, an instant within [start, now], else refused", () => {
    const run = { started_at: new Date(`${PDAY}T09:00:00Z`) };
    expect(effectiveDeclaredAt(undefined, run)).toEqual({ at: null });
    expect(effectiveDeclaredAt("run_started_at", run)).toEqual({ at: run.started_at });
    expect(effectiveDeclaredAt(`${PDAY}T09:30:00Z`, run)).toEqual({ at: new Date(`${PDAY}T09:30:00Z`) });
    expect(effectiveDeclaredAt(`${PDAY}T08:59:59Z`, run)).toHaveProperty("error");
    expect(effectiveDeclaredAt("2999-01-01T00:00:00Z", run)).toHaveProperty("error");
  });

  it("AC: a backfilled past run is the input of a same-day consumer, its cost lands on its cost rows' day, the stored day moves and still balances", async () => {
    // An August-like day: lead-service found a lead (100c), instantly sent to it (50c). Nobody declared.
    const producer = await pastRun("lead-service", "09:00");
    await cost(producer.id, "100", "09:30");
    const sender = await pastRun("instantly-service", "11:00");
    await cost(sender.id, "50", "11:05");

    await refresh(PDAY);
    const before = await storedDay(PDAY);
    expect(orgRow(before)).toMatchObject({ a: zero, b: "150.0000000000", c: "150.0000000000" });
    expect(await daysToCompute(NOW, FLOOR)).not.toContain(PDAY);

    // Both producers re-read their history and declare on the past runs.
    const body = {
      runs: [
        { runId: sender.id, occurredAt: "run_started_at", produced: [lead("message_sent", "L1")], consumed: [lead("lead_found", "L1")] },
        { runId: producer.id, occurredAt: "run_started_at", produced: [lead("lead_found", "L1")] },
      ],
    };
    const res = await batch(body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ allocationVersion: 2, recordedCount: 3, alreadyRecordedCount: 0 });
    const declared = res.body.runs.flatMap((r: any) => r.occurrences);
    for (const o of declared) {
      expect(o.declaredAt.slice(0, 10)).toBe(PDAY);
      expect(o.recordedAt.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    }

    // The consumption resolves to the backfilled producer (not unknown provenance), at its standard cost.
    const consumed = (await occurrencesOf(sender.id)).find((o) => o.direction === "consumed");
    expect(consumed.consumption).toMatchObject({ provenance: "known", sourceRunId: producer.id, reuse: false });
    expect(consumed.consumption.standardCost.grossCents).toBe("100.0000000000");
    // The producer's cost lands on the day of its cost rows.
    const [produced] = await occurrencesOf(producer.id);
    expect(produced.costSlices).toEqual([{ day: PDAY, costOrganizationId: ORG, cost: { grossCents: "100.0000000000", netCents: "100.0000000000", vendorCents: "20.0000000000", unpricedGrossCents: zero } }]);

    // The stored day is stale (recorded after it was computed), recomputed, and balances.
    expect(await daysToCompute(NOW, FLOOR)).toContain(PDAY);
    await refresh(PDAY);
    expect(await daysToCompute(NOW, FLOOR)).not.toContain(PDAY);
    const after = await storedDay(PDAY);
    expect(orgRow(after)).toMatchObject({ a: "150.0000000000", b: zero, c: "150.0000000000" });

    const chk = await request(app).get(`/internal/outcome-costs/ledger-check?since=${PDAY}&until=${PDAY}`).set(getInternalAuthHeaders());
    expect(chk.body.balanced).toBe(true);
    expect(chk.body.complete).toBe(true);
    const row = chk.body.rows.find((r: any) => r.organizationId === ORG);
    expect(row).toMatchObject({ unknownProvenanceCount: 0, reuseCount: 0, occurrences: 2 });
    expect(row.differences.grossCents).toBe(zero);

    // Coverage and the outcome totals moved with it, on the past day.
    const cov = await request(app).get(`/internal/stats/outcome-coverage?since=${PDAY}&until=${PDAY}&serviceName=lead-service`).set(getInternalAuthHeaders());
    expect(cov.body.services[0]).toMatchObject({ day: PDAY, spendGrossCents: "100.0000000000", coveredGrossCents: "100.0000000000" });
    const totals = await request(app)
      .get(`/internal/stats/outcome-costs?since=${PDAY}&until=${PDAY}&costOrgId=${ORG}&groupBy=outcomeKey`)
      .set(getInternalAuthHeaders());
    expect(totals.status).toBe(200);
    const cost_ = Object.fromEntries(totals.body.produced.map((g: any) => [g.dimensions.outcomeKey, g.cost.grossCents]));
    expect(cost_).toEqual({ lead_found: "100.0000000000", message_sent: "50.0000000000" });
    const counted = await request(app).get(`/internal/stats/outcome-costs?since=${PDAY}&until=${PDAY}&orgId=${ORG}&groupBy=outcomeKey`).set(getInternalAuthHeaders());
    expect(counted.body.consumed.map((g: any) => [g.dimensions.consumingOutcomeKey, g.dimensions.consumedOutcomeKey, g.standardCost.grossCents])).toEqual([
      ["message_sent", "lead_found", "100.0000000000"],
    ]);

    // Same declarations, recomputed again: byte for byte.
    await refresh(PDAY);
    expect(await storedDay(PDAY)).toEqual(after);

    // AC: re-running the same backfill writes nothing.
    const events = async () => ((await db.execute(sql`SELECT count(*)::int AS n FROM outcome_declaration_events WHERE run_id IN (${producer.id}::uuid, ${sender.id}::uuid)`)) as any[])[0].n;
    const n0 = await events();
    const replay = await batch(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ recordedCount: 0, alreadyRecordedCount: 3 });
    expect(replay.body.runs.flatMap((r: any) => r.occurrences).every((o: any) => o.status === "already_recorded")).toBe(true);
    expect(await events()).toBe(n0);
    expect(await daysToCompute(NOW, FLOOR)).not.toContain(PDAY);
  });

  it("through today's door instead, the same past consumption cannot find its producer (why the backfill states its time)", async () => {
    const producer = await pastRun("lead-service", "13:00");
    const sender = await pastRun("instantly-service", "14:00");
    // The producer declared on time (today); the sender backfilled to its past day.
    await request(app).post(`/v1/platform-runs/${producer.id}/outcomes`).set(getPlatformAuthHeaders({ serviceName: "lead-service" })).send({ produced: [lead("lead_found", "L2")] });
    const s = await request(app)
      .post(`/v1/runs/${sender.id}/outcomes`)
      .set(getAuthHeaders({ orgId: ORG }))
      .send({ occurredAt: `${PDAY}T14:10:00Z`, produced: [lead("message_sent", "L2")], consumed: [lead("lead_found", "L2")] });
    expect(s.status).toBe(201);
    expect(s.body.occurrences[0].declaredAt).toBe(`${PDAY}T14:10:00.000Z`);
    const consumed = (await occurrencesOf(sender.id)).find((o) => o.direction === "consumed");
    expect(consumed.consumption.provenance).toBe("unknown");
    // Declaring the producer with its time too would have resolved it; an occurrence already recorded keeps its stored time.
    const again = await batch({ runs: [{ runId: producer.id, occurredAt: "run_started_at", produced: [lead("lead_found", "L2")] }] });
    expect(again.status).toBe(200);
    expect(again.body.runs[0].occurrences[0].declaredAt.slice(0, 10)).not.toBe(PDAY);
  });

  it("all or nothing: an unknown run, a voided run, another org or an out-of-bounds time = 422 with the list, nothing written", async () => {
    const ok = await pastRun("lead-service", "15:00");
    const other = await pastRun("lead-service", "15:00", ORG_X);
    // A run with spend: its start bounds occurredAt (a spend-free run may state a past fact, see outcome-dated-facts.test.ts).
    await cost(other.id, "10", "15:01");
    const bad = await batch({
      runs: [
        { runId: ok.id, occurredAt: "run_started_at", produced: [lead("lead_found", "A1")] },
        { runId: "9b0a3c3e-0000-4000-8000-0000000000b9", produced: [lead("lead_found", "A2")] },
        { runId: other.id, occurredAt: `${PDAY}T14:59:00Z`, produced: [lead("lead_found", "A3")] },
      ],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("invalid_runs");
    expect(bad.body.details.invalid.map((i: any) => i.reason)).toEqual(["run_not_found", "invalid_occurred_at"]);
    expect(await occurrencesOf(ok.id)).toHaveLength(0);

    const orgScoped = await request(app)
      .post("/v1/platform-runs/outcomes/batch")
      .set({ ...getPlatformAuthHeaders({ serviceName: "lead-service" }), "x-org-id": ORG })
      .send({ runs: [{ runId: other.id, produced: [lead("lead_found", "A4")] }] });
    expect(orgScoped.status).toBe(422);
    expect(orgScoped.body.details.invalid[0].reason).toBe("run_org_mismatch");

    await request(app).post(`/v1/platform-runs/${ok.id}/outcomes/void`).set(getPlatformAuthHeaders({ serviceName: "lead-service" })).send({ reason: "test", voidedBy: "test" });
    const voided = await batch({ runs: [{ runId: ok.id, produced: [lead("lead_found", "A5")] }] });
    expect(voided.status).toBe(422);
    expect(voided.body.details.invalid[0].reason).toBe("run_outcomes_voided");

    expect((await batch({ runs: [{ runId: other.id, produced: [lead("lead_found", "A6")] }, { runId: other.id, produced: [lead("lead_found", "A7")] }] })).status).toBe(400);
    expect((await batch({ runs: [{ runId: other.id, produced: [lead("not_a_step", "A8")] }] })).status).toBe(400);
    const single = await request(app)
      .post(`/v1/platform-runs/${other.id}/outcomes`)
      .set(getPlatformAuthHeaders({ serviceName: "lead-service" }))
      .send({ occurredAt: "2999-01-01T00:00:00Z", produced: [lead("lead_found", "A9")] });
    expect(single.status).toBe(400);
    expect(single.body.error).toBe("invalid_occurred_at");
    expect(await occurrencesOf(other.id)).toHaveLength(0);
  });
  it("RE-DATE: an occurrence declared through today's door (pre-0060) moves EARLIER to its real time, owner only, never later, replay is a no-op", async () => {
    const producer = await pastRun("lead-service", "16:00");
    await batch({ runs: [{ runId: producer.id, occurredAt: "run_started_at", produced: [lead("lead_found", "R1")] }] });
    const send = await pastRun("instantly-service", "16:30");
    await cost(send.id, "40", "16:31");
    const sendBody = { produced: [lead("message_sent", "R1")], consumed: [lead("lead_found", "R1")] };
    // The worker of 2026-10-23: today's door, no occurredAt; recorded before 0060 (recorded_at NULL).
    expect((await request(app).post(`/v1/platform-runs/${send.id}/outcomes`).set(getPlatformAuthHeaders({ serviceName: "instantly-service" })).send(sendBody)).status).toBe(201);
    await db.execute(sql`UPDATE run_outcomes SET recorded_at = NULL WHERE run_id = ${send.id}::uuid`);
    const consumedOf = async () => (await occurrencesOf(send.id)).find((o) => o.direction === "consumed");
    expect((await consumedOf()).declaredAt.slice(0, 10)).not.toBe(PDAY);
    await refresh(PDAY);
    expect(await daysToCompute(NOW, FLOOR)).not.toContain(PDAY);

    const at = `${PDAY}T16:31:00.000Z`;
    const entry = { runId: send.id, occurredAt: at, redate: true, ...sendBody };
    const foreign = await batch({ runs: [entry] }, "lead-service");
    expect(foreign.status).toBe(422);
    expect(foreign.body.details.invalid[0].reason).toBe("not_run_owner");
    expect((await batch({ runs: [{ runId: send.id, redate: true, ...sendBody }] }, "instantly-service")).status).toBe(400);

    const moved = await batch({ runs: [entry] }, "instantly-service");
    expect(moved.status).toBe(201);
    expect(moved.body).toMatchObject({ recordedCount: 0, redatedCount: 2, alreadyRecordedCount: 0 });
    for (const o of moved.body.runs[0].occurrences) expect(o).toMatchObject({ status: "redated", declaredAt: at });
    const c = await consumedOf();
    expect(c.declaredAt).toBe(at);
    expect(c.consumption).toMatchObject({ provenance: "known", sourceRunId: producer.id });
    const [ev] = (await db.execute(sql`SELECT payload FROM outcome_declaration_events WHERE run_id = ${send.id}::uuid AND event_type = 'outcomes.redated'`)) as any[];
    expect(ev.payload.items).toHaveLength(2);
    expect(ev.payload.items[0].previous_declared_at.slice(0, 10)).not.toBe(PDAY);

    // The stored day moves and still balances.
    expect(await daysToCompute(NOW, FLOOR)).toContain(PDAY);
    await refresh(PDAY);
    const chk = await request(app).get(`/internal/outcome-costs/ledger-check?since=${PDAY}&until=${PDAY}`).set(getInternalAuthHeaders());
    expect(chk.body.balanced).toBe(true);

    // Replay: nothing to move. A LATER time never moves it.
    const replay = await batch({ runs: [entry] }, "instantly-service");
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ redatedCount: 0, alreadyRecordedCount: 2 });
    const later = await batch({ runs: [{ ...entry, occurredAt: `${PDAY}T18:00:00.000Z` }] }, "instantly-service");
    expect(later.body.redatedCount).toBe(0);
    expect((await consumedOf()).declaredAt).toBe(at);
  });
  it("SUPPORT MARK: a staff probe parented to a send stops riding its message_sent; the day recomputes and balances", async () => {
    const send = await pastRun("postmark-service", "17:00");
    await cost(send.id, "10", "17:01");
    await batch({ runs: [{ runId: send.id, occurredAt: "run_started_at", produced: [lead("message_sent", "N1")] }] }, "postmark-service");
    const probe = await insertTestRun({ organizationId: ORG, serviceName: "apollo-service", taskName: "enrichment", status: "completed", parentRunId: send.id, startedAt: new Date(`${PDAY}T17:05:00Z`) });
    await cost(probe.id, "30", "17:06");
    const deep = await insertTestRun({ organizationId: ORG, serviceName: "chat-service", taskName: "complete", status: "completed", parentRunId: probe.id, startedAt: new Date(`${PDAY}T17:06:00Z`) });
    await cost(deep.id, "5", "17:07");
    const sendCost = async () => (await occurrencesOf(send.id))[0].cost.grossCents;
    expect(await sendCost()).toBe("45.0000000000");
    await refresh(PDAY);
    const before = orgRow(await storedDay(PDAY));

    const mark = (runIds: string[]) =>
      request(app).post("/internal/runs/support-marks").set(getInternalAuthHeaders()).send({ runIds, kind: "staff_experiment", reason: "probe reused a real run id as x-run-id", markedBy: "test" });
    const refused = await mark([probe.id, send.id, "9b0a3c3e-0000-4000-8000-0000000000c1"]);
    expect(refused.status).toBe(422);
    expect(refused.body.details.invalid.map((i: any) => i.reason)).toEqual(["run_declares_outcomes", "run_not_found"]);

    const ok = await mark([probe.id]);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ markedCount: 1, alreadyMarkedCount: 0 });
    expect((await mark([probe.id])).body).toEqual({ markedCount: 0, alreadyMarkedCount: 1 });
    // The probe and its subtree no longer ride the send.
    expect(await sendCost()).toBe("10.0000000000");
    // A marked run produces nothing.
    const produce = await request(app).post(`/v1/platform-runs/${probe.id}/outcomes`).set(getPlatformAuthHeaders({ serviceName: "apollo-service" })).send({ produced: [lead("email_checked", "N1")] });
    expect(produce.status).toBe(409);
    expect(produce.body.error).toBe("run_marked_support");

    expect(await daysToCompute(NOW, FLOOR)).toContain(PDAY);
    await refresh(PDAY);
    const after = orgRow(await storedDay(PDAY));
    expect(new Decimal(before.a).minus(after.a).toFixed(10)).toBe("35.0000000000");
    expect(new Decimal(after.b).minus(before.b).toFixed(10)).toBe("35.0000000000");
    expect(after.c).toBe(before.c);
    const chk = await request(app).get(`/internal/outcome-costs/ledger-check?since=${PDAY}&until=${PDAY}`).set(getInternalAuthHeaders());
    expect(chk.body.balanced).toBe(true);
  });
  it("the refresher reaches days never computed before re-running stale ones (a backfill keeps the newest days stale)", async () => {
    await refresh(PDAY);
    const r = await pastRun("lead-service", "19:00");
    await batch({ runs: [{ runId: r.id, occurredAt: "run_started_at", produced: [lead("lead_found", "S1")] }] });
    const days = await daysToCompute(NOW, "2025-03-10");
    expect(days.slice(0, 3)).toEqual(["2025-03-30", "2025-03-29", "2025-03-28"]);
    expect(days[days.length - 1]).toBe(PDAY); // stale, after every missing day
    expect(days.indexOf("2025-03-10")).toBeLessThan(days.indexOf(PDAY));
  });
});
