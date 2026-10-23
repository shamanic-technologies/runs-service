import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { addDays, computeLedgerDay, daysToCompute, refreshLedgerDays, storeLedgerDay, checkLedgerRow, ledgerCheckInputOf, utcDay } from "../../src/services/outcome-ledger.js";

// COST-ACCOUNTING-1023: a run states the outcome occurrences it produced and
// consumed; runs-service serves what each one cost to make and proves the ledger
// to the cent per org per day.

const ORG = "0c05acc0-1023-4c0a-8b1e-000000000001";
const ORG_B = "0c05acc0-1023-4c0a-8b1e-000000000002";
const ORG_V = "0c05acc0-1023-4c0a-8b1e-000000000003";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});

// features-service's step catalogue (the keys a run may declare).
const CATALOGUE = new Set(["meeting_booked", "meeting_attended", "email_checked", "email_found", "lead_found", "message_written", "message_sent", "post_published", "conversation"]);
const stepCatalogue = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/outcome-catalogue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/outcome-catalogue.js")>();
  return { ...actual, unknownOutcomeKeys: stepCatalogue.fn };
});

// billed 5 / vendor 1 per unit; "mystery" has no vendor price (unpriced).
const VERSIONS = [
  { costName: "tok", provider: "acme", servedFrom: "2024-01-01T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" },
];

const DAY = "2025-01-10";
const AT = `${DAY}T10:00:00Z`;
const app = createTestApp();
const zero = "0.0000000000";

async function cost(runId: string, qty: string, unit: string, opts: { discountPct?: string; costName?: string; status?: string; createdAt?: string } = {}) {
  const gross = new Decimal(qty).times(unit);
  await insertTestRunCost({
    runId,
    costName: opts.costName ?? "tok",
    quantity: qty,
    unitCostInUsdCents: unit,
    totalCostInUsdCents: gross.toFixed(10),
    ...(opts.discountPct && {
      netCostInUsdCents: gross.times(new Decimal(1).minus(opts.discountPct)).toFixed(10),
      usageDiscountPct: opts.discountPct,
    }),
    status: opts.status ?? "actual",
    createdAt: new Date(opts.createdAt ?? AT),
  });
}

const leads = (n: number, prefix = "lead") =>
  Array.from({ length: n }, (_, i) => ({ outcomeKey: "email_checked", subjectService: "lead-service", subjectId: `${prefix}-${i}` }));

async function declare(runId: string, body: unknown, headers = getAuthHeaders({ orgId: ORG })) {
  return request(app).post(`/v1/runs/${runId}/outcomes`).set(headers).send(body);
}

async function occurrencesOf(runId: string) {
  const res = await request(app).get(`/internal/outcome-occurrences?runIds=${runId}&limit=1000`).set(getInternalAuthHeaders());
  expect(res.status).toBe(200);
  return res.body.occurrences as any[];
}

const run = (extra: { parentRunId?: string; organizationId?: string | null; serviceName?: string; taskName?: string } = {}) =>
  insertTestRun({
    organizationId: extra.organizationId === undefined ? ORG : extra.organizationId,
    serviceName: extra.serviceName ?? "svc",
    taskName: extra.taskName ?? "task",
    status: "completed",
    parentRunId: extra.parentRunId,
    startedAt: new Date(`${DAY}T09:00:00Z`),
  });

async function clearLedgerDays() {
  await db.execute(sql`DELETE FROM cost_ledger_days`);
  await db.execute(sql`DELETE FROM outcome_coverage_days`);
  await db.execute(sql`DELETE FROM cost_ledger_computed_days`);
}

describe("Outcome occurrences: the production-cost ledger", () => {
  beforeAll(async () => {
    await cleanTestData([ORG, ORG_B, ORG_V, null]);
    await clearLedgerDays();
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockImplementation(async (keys: string[]) => keys.filter((k) => !CATALOGUE.has(k)));
  });

  afterAll(async () => {
    await cleanTestData([ORG, ORG_B, ORG_V, null]);
    await clearLedgerDays();
    await closeDb();
  });

  it("AC: 50 produced occurrences of a $1.00 run read $0.02 each, on gross, net and actual", async () => {
    const r = await run();
    await cost(r.id, "20", "5", { discountPct: "0.1" }); // 100 cents gross, 90 net, vendor 20
    const res = await declare(r.id, { produced: leads(50) });
    expect(res.status).toBe(201);
    expect(res.body.recordedCount).toBe(50);
    expect(res.body.allocationVersion).toBe(1);

    const occ = await occurrencesOf(r.id);
    expect(occ).toHaveLength(50);
    for (const o of occ) {
      expect(o.direction).toBe("produced");
      expect(o.cost).toEqual({ grossCents: "2.0000000000", netCents: "1.8000000000", vendorCents: "0.4000000000", unpricedGrossCents: zero });
    }
  });

  it("an uneven split loses no fraction of a cent, and quantity weights the shares", async () => {
    const r = await run();
    await cost(r.id, "20", "5"); // 100 cents over 3
    await declare(r.id, { produced: leads(3, "uneven") });
    const occ = await occurrencesOf(r.id);
    const sum = occ.reduce((s, o) => s.plus(o.cost.grossCents), new Decimal(0));
    expect(sum.toFixed(10)).toBe("100.0000000000");
    expect(occ.map((o) => o.cost.grossCents).sort()).toEqual(["33.3333333333", "33.3333333333", "33.3333333334"]);

    const w = await run();
    await cost(w.id, "20", "5");
    await declare(w.id, {
      produced: [
        { outcomeKey: "message_written", subjectService: "lead-service", subjectId: "w1", quantity: 1 },
        { outcomeKey: "message_written", subjectService: "lead-service", subjectId: "w3", quantity: "3" },
      ],
    });
    const wocc = await occurrencesOf(w.id);
    const by = Object.fromEntries(wocc.map((o) => [o.subjectId, o.cost.grossCents]));
    expect(by).toEqual({ w1: "25.0000000000", w3: "75.0000000000" });
  });

  it("a run's cost includes descendants that declare nothing, never a descendant that declares its own outputs", async () => {
    const parent = await run({ serviceName: "workflow-service", taskName: "execute-workflow" });
    const child = await run({ parentRunId: parent.id, serviceName: "chat-service", taskName: "complete" });
    const grand = await run({ parentRunId: child.id, serviceName: "apollo-service", taskName: "enrichment" });
    await cost(child.id, "2", "5"); // 10, goes to parent
    await cost(grand.id, "1", "4", { costName: "mystery" }); // 4 unpriced, goes to grand
    await declare(parent.id, { produced: leads(2, "wf"), consumed: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "wf-in" }] });
    await declare(grand.id, { produced: [{ outcomeKey: "email_found", subjectService: "lead-service", subjectId: "g-0" }] });

    const pocc = await occurrencesOf(parent.id);
    const produced = pocc.filter((o) => o.direction === "produced");
    expect(produced.map((o) => o.cost.grossCents)).toEqual(["5.0000000000", "5.0000000000"]);
    expect(produced.every((o) => o.cost.vendorCents === "1.0000000000")).toBe(true);
    const consumed = pocc.filter((o) => o.direction === "consumed");
    expect(consumed).toHaveLength(1);
    expect(consumed[0].cost).toBeNull();

    const [g] = await occurrencesOf(grand.id);
    expect(g.cost).toEqual({ grossCents: "4.0000000000", netCents: "4.0000000000", vendorCents: zero, unpricedGrossCents: "4.0000000000" });
  });

  it("the stored day balances to the cent: spread + produced none = ledger, per org, on every basis", async () => {
    const silent = await run({ organizationId: ORG_B });
    await cost(silent.id, "3", "5"); // 15, states nothing
    const orgless = await run({ organizationId: null });
    await cost(orgless.id, "1", "5");
    await cost(orgless.id, "1", "5", { status: "provisioned" }); // a hold: not spend yet
    await cost(orgless.id, "1", "5", { status: "refunded" }); // spend that happened, not charged

    const d = await computeLedgerDay(DAY, VERSIONS as any);
    await storeLedgerDay(d);
    expect(d.unplacedRuns).toBe(0);

    const res = await request(app).get(`/internal/outcome-costs/ledger-check?since=${DAY}&until=${DAY}`).set(getInternalAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(true);
    expect(res.body.complete).toBe(true);
    expect(res.body.mismatches).toEqual([]);

    const byOrg = Object.fromEntries(res.body.rows.map((r: any) => [r.organizationId ?? "none", r]));
    // ORG: 100 + 100 + 100 (three runs above) + 10 (child) + 4 (grand) = 314 gross, all spread.
    expect(byOrg[ORG].ledger.grossCents).toBe("314.0000000000");
    expect(byOrg[ORG].allocated.grossCents).toBe("314.0000000000");
    expect(byOrg[ORG].producedNone.grossCents).toBe(zero);
    expect(byOrg[ORG].ledger.netCents).toBe("304.0000000000");
    expect(byOrg[ORG].allocated.vendorCents).toBe("62.0000000000");
    expect(byOrg[ORG].allocated.unpricedGrossCents).toBe("4.0000000000");
    expect(byOrg[ORG].occurrences).toBe(50 + 3 + 2 + 2 + 1);
    // ORG_B stated nothing: everything sits in produced none.
    expect(byOrg[ORG_B].producedNone.grossCents).toBe("15.0000000000");
    expect(byOrg[ORG_B].allocated.grossCents).toBe(zero);
    // Org-less: actual + refunded, never the hold.
    expect(byOrg.none.ledger.grossCents).toBe("10.0000000000");
    for (const r of res.body.rows) expect(r.differences).toEqual({ grossCents: zero, netCents: zero, vendorCents: zero, unpricedGrossCents: zero });

    // Σ per-occurrence costs of ORG = the day's allocated (same groups, same shares).
    const page = await request(app).get(`/internal/outcome-occurrences?orgId=${ORG}&direction=produced&limit=1000`).set(getInternalAuthHeaders());
    const total = page.body.occurrences.reduce((s: Decimal, o: any) => s.plus(o.cost.grossCents), new Decimal(0));
    expect(total.toFixed(10)).toBe("314.0000000000");
  });

  it("coverage: share of spend whose run states its outputs, per task, as a stored daily series", async () => {
    const res = await request(app).get(`/internal/stats/outcome-coverage?since=${DAY}&until=${DAY}`).set(getInternalAuthHeaders());
    expect(res.status).toBe(200);
    const task = (s: string, t: string) => res.body.tasks.find((x: any) => x.serviceName === s && x.taskName === t);
    expect(task("chat-service", "complete").coveragePct).toBe("100.00");
    const svc = task("svc", "task");
    // 300 (ORG, declared) of 300 + 15 (ORG_B) + 10 (org-less) = 325.
    expect(svc.spendGrossCents).toBe("325.0000000000");
    expect(svc.coveredGrossCents).toBe("300.0000000000");
    expect(svc.coveragePct).toBe("92.31");
    expect(res.body.fleet).toHaveLength(1);
    expect(res.body.fleet[0].complete).toBe(true);
    expect(res.body.daysMissing).toEqual([]);
  });

  it("a day where nobody declares reads 0% coverage and everything in produced none", async () => {
    const day = "2025-01-12";
    const r = await run();
    await cost(r.id, "4", "5", { createdAt: `${day}T08:00:00Z` });
    await storeLedgerDay(await computeLedgerDay(day, VERSIONS as any));
    const cov = await request(app).get(`/internal/stats/outcome-coverage?since=${day}&until=${day}`).set(getInternalAuthHeaders());
    expect(cov.body.fleet[0].coveragePct).toBe("0.00");
    const chk = await request(app).get(`/internal/outcome-costs/ledger-check?since=${day}&until=${day}`).set(getInternalAuthHeaders());
    expect(chk.body.balanced).toBe(true);
    expect(chk.body.totals.producedNone.grossCents).toBe("20.0000000000");
    expect(chk.body.totals.allocated.grossCents).toBe(zero);
  });

  it("a stored row one cent off fails the check", async () => {
    await db.execute(sql`UPDATE cost_ledger_days SET none_gross = none_gross + 1 WHERE day = '2025-01-12'::date`);
    const chk = await request(app).get(`/internal/outcome-costs/ledger-check?since=2025-01-12&until=2025-01-12`).set(getInternalAuthHeaders());
    expect(chk.body.balanced).toBe(false);
    expect(chk.body.mismatches).toHaveLength(1);
    expect(chk.body.mismatches[0].differences.grossCents).toBe("1.0000000000");
  });

  it("standard cost on reuse: a reused occurrence is charged its production cost again, as an explicit reuse gain", async () => {
    const producer = await run({ serviceName: "apollo-service", taskName: "enrichment" });
    await cost(producer.id, "2", "5", { createdAt: "2025-01-14T08:00:00Z" }); // 10 cents, vendor 2
    await declare(producer.id, { produced: [{ outcomeKey: "email_found", subjectService: "lead-service", subjectId: "reused-lead" }] });
    const first = await run({ organizationId: ORG_B });
    const second = await run();
    const orphan = await run({ organizationId: ORG_B });
    const input = { outcomeKey: "email_found", subjectService: "lead-service", subjectId: "reused-lead" };
    await declare(first.id, { consumed: [input] }, getAuthHeaders({ orgId: ORG_B }));
    await declare(second.id, { consumed: [input] });
    await declare(orphan.id, { consumed: [{ ...input, subjectId: "never-produced" }] }, getAuthHeaders({ orgId: ORG_B }));

    const [p] = await occurrencesOf(producer.id);
    expect(p.cost.grossCents).toBe("10.0000000000");
    expect(p.tags).toMatchObject({ brandIds: [], campaignId: null });
    const [c1] = await occurrencesOf(first.id);
    expect(c1.cost).toBeNull();
    expect(c1.consumption).toMatchObject({ sourceOccurrenceId: p.id, sourceRunId: producer.id, reuse: false, provenance: "known" });
    expect(c1.consumption.standardCost.grossCents).toBe("10.0000000000");
    const [c2] = await occurrencesOf(second.id);
    expect(c2.consumption).toMatchObject({ sourceOccurrenceId: p.id, reuse: true });
    expect(c2.consumption.standardCost).toEqual({ grossCents: "10.0000000000", netCents: "10.0000000000", vendorCents: "2.0000000000", unpricedGrossCents: zero });
    const [c3] = await occurrencesOf(orphan.id);
    expect(c3.consumption).toEqual({
      sourceOccurrenceId: null, sourceRunId: null, reuse: false, provenance: "unknown", standardCost: null,
      consumingOutcomes: [{ outcomeKey: null, weight: "1.0000000000", standardCost: null }],
    });

    // A new reuse never moves the production cost.
    const third = await run({ organizationId: ORG_B });
    await declare(third.id, { consumed: [input] }, getAuthHeaders({ orgId: ORG_B }));
    const [pAfter] = await occurrencesOf(producer.id);
    expect(pAfter.cost).toEqual(p.cost);

    const today = utcDay(new Date());
    await storeLedgerDay(await computeLedgerDay(today, VERSIONS as any));
    const chk = await request(app).get(`/internal/outcome-costs/ledger-check?since=${today}&until=${today}`).set(getInternalAuthHeaders());
    expect(chk.body.balanced).toBe(true);
    const rows = Object.fromEntries(chk.body.rows.map((r: any) => [r.organizationId ?? "none", r]));
    expect(rows[ORG].reuseGain.grossCents).toBe("10.0000000000");
    expect(rows[ORG].reuseCount).toBe(1);
    expect(rows[ORG].standard.grossCents).toBe(new Decimal(rows[ORG].allocated.grossCents).plus(10).toFixed(10));
    expect(rows[ORG_B].reuseGain.grossCents).toBe("10.0000000000"); // the third consumption
    expect(rows[ORG_B].reuseCount).toBe(1);
    expect(rows[ORG_B].unknownProvenanceCount).toBe(1);
    expect(chk.body.totals.reuseGain.grossCents).toBe("20.0000000000");
  });

  it("the refresher stores every day of the last 60 (floor pinned: the shared test ledger's first spend day varies) and reports missing days otherwise", async () => {
    await clearLedgerDays();
    const before = await request(app).get(`/internal/outcome-costs/ledger-check?since=${DAY}&until=${DAY}`).set(getInternalAuthHeaders());
    expect(before.body.complete).toBe(false);
    expect(before.body.daysMissing).toEqual([DAY]);
    const partial = await refreshLedgerDays(new Date("2025-01-20T12:00:00Z"), 8, "2024-11-22");
    expect(partial.computed).toEqual(["2025-01-20", "2025-01-19", "2025-01-18", "2025-01-17", "2025-01-16", "2025-01-15", "2025-01-14", "2025-01-13"]);
    const { computed, failed } = await refreshLedgerDays(new Date("2025-01-20T12:00:00Z"), Infinity, "2024-11-22");
    expect(failed).toEqual([]);
    expect(computed).toHaveLength(52 + 3);
    expect(computed).toContain(DAY);
    const after = await request(app).get(`/internal/outcome-costs/ledger-check?since=2024-11-22&until=2025-01-19`).set(getInternalAuthHeaders());
    expect(after.body.complete).toBe(true);
    expect(after.body.balanced).toBe(true);
    expect(after.body.totals.ledger.grossCents).toBe(
      new Decimal(after.body.totals.allocated.grossCents).plus(after.body.totals.producedNone.grossCents).toFixed(10),
    );
  });

  it("declaration contract: replay, conflict, duplicates, legacy key, org, platform route, 404", async () => {
    const r = await run();
    const body = { produced: [{ outcomeKey: "email_sent", subjectService: "lead-service", subjectId: "x" }] };
    const first = await declare(r.id, body);
    expect(first.status).toBe(201);
    expect(first.body.occurrences[0].outcomeKey).toBe("message_sent");
    const replay = await declare(r.id, body);
    expect(replay.status).toBe(200);
    expect(replay.body.occurrences[0]).toMatchObject({ status: "already_recorded", id: first.body.occurrences[0].id });

    const conflict = await declare(r.id, { produced: [{ ...body.produced[0], quantity: 2 }] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.conflicts[0]).toMatchObject({ storedQuantity: "1.000000", statedQuantity: "2.000000" });

    expect((await declare(r.id, { produced: [body.produced[0], body.produced[0]] })).status).toBe(400);
    expect((await declare(r.id, {})).status).toBe(400);
    expect((await declare(r.id, { produced: [{ outcomeKey: "Email Found", subjectService: "lead-service", subjectId: "x" }] })).status).toBe(400);
    expect((await declare(r.id, { produced: leads(1001) })).status).toBe(400);

    const unknown = await declare(r.id, { produced: [{ outcomeKey: "positive_reply", subjectService: "lead-service", subjectId: "x" }] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("unknown_outcome_key");
    expect(unknown.body.details.unknownKeys).toEqual(["positive_reply"]);

    const { OutcomeCatalogueError } = await import("../../src/services/outcome-catalogue.js");
    stepCatalogue.fn.mockRejectedValueOnce(new OutcomeCatalogueError("features-service step catalogue returned 503"));
    const down = await declare(r.id, { produced: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "y" }] });
    expect(down.status).toBe(502);
    const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM run_outcomes WHERE run_id = ${r.id}::uuid`)) as any[];
    expect(n).toBe(1); // nothing written while the catalogue was unreadable

    const other = await declare(r.id, body, getAuthHeaders({ orgId: ORG_B }));
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("run_org_mismatch");

    const platformRun = await run({ organizationId: null });
    const p = await request(app)
      .post(`/v1/platform-runs/${platformRun.id}/outcomes`)
      .set(getPlatformAuthHeaders({ serviceName: "social-service" }))
      .send({ produced: [{ outcomeKey: "post_published", subjectService: "social-service", subjectId: "post-1" }] });
    expect(p.status).toBe(201);
    const [ev] = (await db.execute(sql`SELECT source_service FROM outcome_declaration_events WHERE run_id = ${platformRun.id}::uuid`)) as any[];
    expect(ev.source_service).toBe("social-service");

    expect((await declare("9b0a3c3e-0000-4000-8000-000000000000", body)).status).toBe(404);
    expect((await declare("not-a-uuid", body)).status).toBe(400);

    const bySubject = await request(app)
      .get(`/internal/outcome-occurrences?subjectService=social-service&subjectIds=post-1`)
      .set(getInternalAuthHeaders());
    expect(bySubject.body.occurrences).toHaveLength(1);
    expect(bySubject.body.occurrences[0].cost.grossCents).toBe(zero);
    expect((await request(app).get(`/internal/outcome-occurrences`).set(getInternalAuthHeaders())).status).toBe(400);
  });

  it("a run stating nothing reads exactly as before (GET /v1/runs/:id unchanged by a declaration elsewhere)", async () => {
    const r = await run();
    await cost(r.id, "1", "5");
    const before = await request(app).get(`/v1/runs/${r.id}`).set(getAuthHeaders({ orgId: ORG }));
    await declare(r.id, { produced: leads(2, "unchanged") });
    const after = await request(app).get(`/v1/runs/${r.id}`).set(getAuthHeaders({ orgId: ORG }));
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
  });

  it("checkLedgerRow is exact: one cent off is unbalanced", () => {
    const m = (g: string) => ({ gross: g, net: g, vendor: g, unpricedGross: "0" });
    expect(checkLedgerRow({ ledger: m("100"), standard: m("70"), reuseGain: m("10"), producedNone: m("40") }).balanced).toBe(true);
    const off = checkLedgerRow({ ledger: m("100"), standard: m("70"), reuseGain: m("10"), producedNone: { ...m("40"), gross: "39" } });
    expect(off.balanced).toBe(false);
    expect(off.differences.gross).toBe("-1.0000000000");
  });
  it("RUNS-VOID-1023: a taken-back declaration counts in no figure, only its owning service may take it back, and the run accepts no new one", async () => {
    const vday = addDays(utcDay(new Date()), -10);
    const vAt = `${vday}T10:00:00Z`;
    const vrun = (serviceName: string) =>
      insertTestRun({ organizationId: ORG_V, serviceName, taskName: "outcome-recording", status: "completed", startedAt: new Date(`${vday}T09:00:00Z`) });
    const vcost = async (runId: string) =>
      insertTestRunCost({ runId, costName: "tok", quantity: "20", unitCostInUsdCents: "5", totalCostInUsdCents: "100.0000000000", status: "actual", createdAt: new Date(vAt) });
    const lead = (outcomeKey: string, subjectId = "void-lead") => ({ outcomeKey, subjectService: "lead-service", subjectId });
    const orgHeaders = (serviceName?: string) => ({ ...getAuthHeaders({ orgId: ORG_V }), ...(serviceName && { "x-service-name": serviceName }) });
    const body = { reason: "one run declared several produced keys", voidedBy: "lead-service COST-ACCOUNTING-1023-LEAD-FIX" };

    // The wrong shape of 2026-10-23: one run producing several keys, consuming its own.
    const wrong = await vrun("lead-service");
    await vcost(wrong.id);
    expect((await declare(wrong.id, { produced: [lead("meeting_booked"), lead("meeting_attended")], consumed: [lead("conversation"), lead("meeting_booked")] }, orgHeaders())).status).toBe(201);
    // Another run consuming one of its outputs, and an untouched sibling run of the same service.
    const consumer = await vrun("svc");
    await vcost(consumer.id);
    await declare(consumer.id, { produced: [lead("message_sent")], consumed: [lead("meeting_attended")] }, orgHeaders());
    const sibling = await vrun("lead-service");
    await vcost(sibling.id);
    await declare(sibling.id, { produced: [lead("meeting_booked", "other-lead")] }, orgHeaders());

    const d0 = await computeLedgerDay(vday, VERSIONS as any);
    await storeLedgerDay(d0);
    const before = d0.orgs.find((o) => o.organizationId === ORG_V)!;
    expect(before.allocated.gross).toBe("300.0000000000");
    expect(await daysToCompute()).not.toContain(addDays(utcDay(new Date()), -10));
    expect((await occurrencesOf(consumer.id)).find((o) => o.direction === "consumed").consumption.sourceRunId).toBe(wrong.id);

    // Another service can never take back lead-service's run; nor can a call without its name.
    const foreign = await request(app).post(`/v1/platform-runs/${wrong.id}/outcomes/void`).set(getPlatformAuthHeaders({ serviceName: "instantly-service" })).send(body);
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe("not_run_owner");
    expect((await request(app).post(`/v1/runs/${wrong.id}/outcomes/void`).set(orgHeaders()).send(body)).status).toBe(400);
    expect((await request(app).post(`/v1/runs/${wrong.id}/outcomes/void`).set(orgHeaders("lead-service")).send({ reason: "" , voidedBy: "x" })).status).toBe(400);
    expect((await request(app).post(`/v1/runs/${wrong.id}/outcomes/void`).set({ ...getAuthHeaders({ orgId: ORG }), "x-service-name": "lead-service" }).send(body)).status).toBe(409);
    expect(await occurrencesOf(wrong.id)).toHaveLength(4);

    // The owner takes it back.
    const v = await request(app).post(`/v1/runs/${wrong.id}/outcomes/void`).set(orgHeaders("lead-service")).send(body);
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ runId: wrong.id, status: "voided", voidedCount: 4, allocationVersion: 1 });
    const again = await request(app).post(`/v1/platform-runs/${wrong.id}/outcomes/void`).set(getPlatformAuthHeaders({ serviceName: "lead-service" })).send(body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: "already_voided", voidedCount: 0, voidedAt: v.body.voidedAt });

    // Nothing new can be recorded on it.
    const redeclare = await declare(wrong.id, { produced: [lead("meeting_booked")] }, orgHeaders());
    expect(redeclare.status).toBe(409);
    expect(redeclare.body.error).toBe("run_outcomes_voided");
    const projected = await db
      .execute(sql`INSERT INTO outcome_declaration_events (run_id, event_type, payload) VALUES (${wrong.id}::uuid, 'outcomes.declared', ${JSON.stringify({ items: [{ id: "6f0d3c1e-0000-4000-8000-00000000a001", direction: "produced", outcome_key: "meeting_booked", subject_service: "lead-service", subject_id: "x" }] })}::jsonb)`)
      .then(() => null, (e: any) => `${e.message} ${e.cause?.message}`);
    expect(projected).toMatch(/run_outcomes_voided/);

    // Audit: the bronze log keeps the declaration AND the void, with its motive and the removed rows.
    const events = (await db.execute(sql`SELECT event_type, payload FROM outcome_declaration_events WHERE run_id = ${wrong.id}::uuid ORDER BY occurred_at`)) as any[];
    expect(events.map((e) => e.event_type)).toEqual(["outcomes.declared", "outcomes.voided"]);
    expect(events[1].payload).toMatchObject({ reason: body.reason, voidedBy: body.voidedBy, affectedFromDay: vday });
    expect(events[1].payload.items).toHaveLength(4);

    // No figure counts it: occurrences, the consumer's provenance, the stored day (marked stale), the ledger, the totals.
    expect(await occurrencesOf(wrong.id)).toHaveLength(0);
    expect((await occurrencesOf(consumer.id)).find((o) => o.direction === "consumed").consumption.provenance).toBe("unknown");
    expect((await occurrencesOf(sibling.id))[0].cost.grossCents).toBe("100.0000000000");
    expect(await daysToCompute()).toContain(vday);
    const d1 = await computeLedgerDay(vday, VERSIONS as any);
    await storeLedgerDay(d1);
    expect(await daysToCompute()).not.toContain(vday);
    const after = d1.orgs.find((o) => o.organizationId === ORG_V)!;
    expect(after.allocated.gross).toBe("200.0000000000");
    expect(after.producedNone.gross).toBe("100.0000000000");
    expect(checkLedgerRow(ledgerCheckInputOf(after)).balanced).toBe(true);
    const totals = await request(app).get(`/internal/stats/outcome-costs?since=${vday}&until=${vday}&costOrgId=${ORG_V}&groupBy=outcomeKey`).set(getInternalAuthHeaders());
    expect(totals.status).toBe(200);
    expect(totals.body.produced.map((g: any) => g.dimensions.outcomeKey).sort()).toEqual(["meeting_booked", "message_sent"]);
    expect(totals.body.complete).toBe(true);
    for (const g of totals.body.produced) expect(g.cost.grossCents).toBe("100.0000000000");
    expect(totals.body.produced.some((g: any) => g.dimensions.outcomeKey === "meeting_attended")).toBe(false);
  });
});
