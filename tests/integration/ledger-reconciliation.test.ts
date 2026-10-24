import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { computeLedgerDay, daysToCompute, storeLedgerDay } from "../../src/services/outcome-ledger.js";

// LEDGER-HISTORY-1024-RUNS: allocation v3 (cross-run loss pooled per campaign),
// the reconciliation readers gate on, and stale days (a fact recorded after a day
// was computed) never read as complete.

const ORG = "0c05acc0-1024-4c0a-8b1e-0000000000d7";

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
const CATALOGUE = new Set(["lead_found", "message_sent", "conversation", "lead_identified", "email_checked", "email_found"]);

// Days of their own: no other test file writes spend on them (the reconciliation is fleet-wide).
const DAY = "2024-08-05";
const DAY2 = "2024-08-06";
const app = createTestApp();

const at = (day: string, hour: string) => new Date(`${day}T${hour}:00Z`);
const run = (day: string, hour: string, extra: Partial<Parameters<typeof insertTestRun>[0]> = {}) =>
  insertTestRun({ organizationId: ORG, serviceName: "workflow-service", taskName: "execute-workflow", status: "completed", startedAt: at(day, hour), ...extra });
const cost = (runId: string, cents: string, createdAt: Date, status = "actual") =>
  insertTestRunCost({
    runId,
    costName: "tok",
    quantity: new Decimal(cents).div(5).toString(),
    unitCostInUsdCents: "5",
    totalCostInUsdCents: new Decimal(cents).toFixed(10),
    status,
    createdAt,
  });
const refresh = async (day: string) => storeLedgerDay(await computeLedgerDay(day, VERSIONS as any));
const declare = (serviceName: string, runs: unknown[]) =>
  request(app).post("/v1/platform-runs/outcomes/batch").set(getPlatformAuthHeaders({ serviceName })).send({ runs });
const recon = async (since: string, until: string) => {
  const res = await request(app).get(`/internal/outcome-costs/reconciliation?since=${since}&until=${until}`).set(getInternalAuthHeaders());
  expect(res.status).toBe(200);
  return res.body;
};

describe("Ledger reconciliation (LEDGER-HISTORY-1024-RUNS)", () => {
  beforeAll(async () => {
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockImplementation(async (keys: string[]) => keys.filter((k) => !CATALOGUE.has(k)));
    await cleanTestData([ORG]);
  });
  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("v3: a run that produced nothing rides its OWN campaign's units; a campaign with none keeps its loss, attributable to it", async () => {
    // Campaign A: one send (unit) + one run judged "later" (loss). Campaign B, same
    // workflow, same org: only a loss run. v2 moved B's loss onto A's unit.
    const sendA = await run(DAY, "09:00", { campaignId: "cmp-A", workflowSlug: "w-follow", audienceId: "aud-1" });
    await cost(sendA.id, "4", at(DAY, "09:01"));
    const lostA = await run(DAY, "10:00", { campaignId: "cmp-A", workflowSlug: "w-follow", audienceId: "aud-1" });
    await cost(lostA.id, "6", at(DAY, "10:01"));
    const lostB = await run(DAY, "10:30", { campaignId: "cmp-B", workflowSlug: "w-follow", audienceId: "aud-2" });
    await cost(lostB.id, "3", at(DAY, "10:31"));
    // Undeclared: a run of a producer that has not declared (no pipe, no mark).
    const silent = await run(DAY, "11:00", { serviceName: "apollo-service", taskName: "enrich" });
    await cost(silent.id, "2", at(DAY, "11:01"));
    // Support.
    const fee = await run(DAY, "11:30", { serviceName: "stripe-service", taskName: "charge" });
    await cost(fee.id, "1", at(DAY, "11:31"));
    expect(
      (await request(app).post("/internal/runs/support-marks").set(getInternalAuthHeaders())
        .send({ kind: "payment_fees", reason: "processor fee", markedBy: "t", runIds: [fee.id] })).status,
    ).toBe(200);
    // A reply judged on a run consuming a send nobody declared producing (unknown provenance).
    const reply = await run(DAY, "12:00", { serviceName: "instantly-service", taskName: "judge-replies" });
    expect(
      (await declare("workflow-service", [
        { runId: sendA.id, occurredAt: "run_started_at", produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: "L1" }] },
      ])).status,
    ).toBe(201);
    expect(
      (await declare("instantly-service", [
        {
          runId: reply.id,
          occurredAt: "run_started_at",
          produced: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "L9" }],
          consumed: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: "L9" }],
        },
      ])).status,
    ).toBe(201);
    await refresh(DAY);

    const check = await request(app).get(`/internal/outcome-costs/ledger-check?since=${DAY}&until=${DAY}`).set(getInternalAuthHeaders());
    expect(check.body.allocationVersion).toBe(5);
    expect(check.body.balanced).toBe(true);
    const row = check.body.rows.find((r: any) => r.organizationId === ORG);
    expect(row.ledger.grossCents).toBe("16.0000000000");
    expect(row.allocated.grossCents).toBe("10.0000000000"); // send 4 + A's loss 6, never B's 3
    expect(row.normalLoss.grossCents).toBe("6.0000000000");

    // B's loss stays produced-none under campaign B and its audience.
    const oc = await request(app)
      .get(`/internal/stats/outcome-costs?since=${DAY}&until=${DAY}&orgId=${ORG}&groupBy=campaignId,audienceId`)
      .set(getInternalAuthHeaders());
    expect(oc.status).toBe(200);
    const scopeB = oc.body.scope.find((s: any) => s.dimensions.campaignId === "cmp-B");
    expect(scopeB.dimensions.audienceId).toBe("aud-2");
    expect(scopeB.producedNone.grossCents).toBe("3.0000000000");
    expect(scopeB.producedCost.grossCents).toBe("0.0000000000");
    const prodA = oc.body.produced.find((p: any) => p.dimensions.campaignId === "cmp-A");
    expect(prodA).toMatchObject({ dimensions: { audienceId: "aud-1" }, cost: { grossCents: "10.0000000000" } });

    const r = await recon(DAY, DAY);
    expect(r).toMatchObject({ balanced: true, complete: true, declarationsComplete: false, reconciled: false, daysMissing: [] });
    const t = r.totals;
    expect(t.spend.grossCents).toBe("16.0000000000");
    expect(t.declaredProduction.grossCents).toBe("4.0000000000");
    expect(t.normalLoss.grossCents).toBe("6.0000000000");
    expect(t.unpooledLoss.grossCents).toBe("3.0000000000");
    expect(t.undeclared.grossCents).toBe("2.0000000000");
    expect(t.support.grossCents).toBe("1.0000000000");
    for (const k of ["grossCents", "netCents", "vendorCents", "unpricedGrossCents"]) expect(t.differences[k]).toBe("0.0000000000");
    expect(t.shares.undeclared.gross).toBe("0.1250000000");
    expect(t.consumptions).toBe("1.0000000000");
    expect(t.unknownProvenance).toBe("1.0000000000");
    expect(r.services[0]).toMatchObject({ serviceName: "apollo-service", undeclaredRuns: 1, undeclared: { grossCents: "2.0000000000" } });
    expect(r.services.find((s: any) => s.serviceName === "workflow-service")).toMatchObject({ unpooledLossRuns: 1, unpooledLoss: { grossCents: "3.0000000000" } });
    expect(r.provenance[0]).toMatchObject({ consumedOutcomeKey: "message_sent", consumingServiceName: "instantly-service", unknownProvenance: "1.0000000000", unknownShare: "1.0000000000" });

    // Group by the spending service: who still spends without declaring.
    const bySvc = await request(app)
      .get(`/internal/stats/outcome-costs?since=${DAY}&until=${DAY}&orgId=${ORG}&groupBy=serviceName`)
      .set(getInternalAuthHeaders());
    expect(bySvc.body.scope.find((s: any) => s.dimensions.serviceName === "apollo-service").undeclared.grossCents).toBe("2.0000000000");
  });

  it("a backfill recorded after a day was computed makes the day STALE: missing, out of totals, until recomputed", async () => {
    const send = await run(DAY2, "09:00", { serviceName: "instantly-service", taskName: "send" });
    await cost(send.id, "5", at(DAY2, "09:01"));
    await refresh(DAY2);
    let r = await recon(DAY2, DAY2);
    expect(r).toMatchObject({ complete: true, daysMissing: [], daysStale: [] });
    expect(r.totals.undeclared.grossCents).toBe("5.0000000000");

    // The producer backfills the outcome of its past run, today.
    expect(
      (await declare("instantly-service", [
        { runId: send.id, occurredAt: "run_started_at", produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: "S1" }] },
      ])).status,
    ).toBe(201);
    r = await recon(DAY2, DAY2);
    expect(r).toMatchObject({ complete: false, reconciled: false, daysMissing: [DAY2], daysStale: [DAY2] });
    expect(r.totals.spend.grossCents).toBe("0.0000000000"); // a stale day is never summed
    expect(r.services).toEqual([]); // ... nor listed
    expect(r.declarationsComplete).toBe(false); // nothing computed proves nothing
    const oc = await request(app).get(`/internal/stats/outcome-costs?since=${DAY2}&until=${DAY2}`).set(getInternalAuthHeaders());
    expect(oc.body).toMatchObject({ complete: false, daysMissing: [DAY2], daysStale: [DAY2] });

    // The refresher's sweep flags it and moves its window past the backfill: still stale (by the flag).
    expect(await daysToCompute(new Date("2024-08-20T12:00:00Z"), DAY2, true)).toContain(DAY2);
    const [flag] = (await db.execute(sql`SELECT stale FROM cost_ledger_computed_days WHERE day = ${DAY2}::date AND allocation_version = 5`)) as any[];
    expect(flag.stale).toBe(true);
    expect(await recon(DAY2, DAY2)).toMatchObject({ complete: false, daysStale: [DAY2] });

    await refresh(DAY2);
    r = await recon(DAY2, DAY2);
    expect(r).toMatchObject({ complete: true, balanced: true, declarationsComplete: true, reconciled: true, daysStale: [] });
    expect(r.totals.declaredProduction.grossCents).toBe("5.0000000000");
    expect(r.totals.shares.declaredProduction.gross).toBe("1.0000000000");
  });

  it("spend landing on a past day after it was computed (a hold materialized late) makes the day stale", async () => {
    const day = "2024-08-07";
    const send = await run(day, "09:00", { serviceName: "instantly-service", taskName: "send" });
    const hold = await cost(send.id, "7", at(day, "09:01"), "provisioned");
    await refresh(day);
    expect((await recon(day, day)).totals.spend.grossCents).toBe("0.0000000000");
    await db.execute(sql`
      INSERT INTO cost_lifecycle_events (cost_id, run_id, event_type, payload)
      VALUES (${hold.id}::uuid, ${send.id}::uuid, 'cost.materialized', '{"from":"provisioned","to":"actual"}'::jsonb)
    `);
    expect(await recon(day, day)).toMatchObject({ complete: false, daysStale: [day] });
    await refresh(day);
    const r = await recon(day, day);
    expect(r).toMatchObject({ complete: true, daysStale: [] });
    expect(r.totals.spend.grossCents).toBe("7.0000000000");
  });

  it("production its owner marks unattributed_production is its own line, never undeclared nor support", async () => {
    const day = "2024-08-08";
    const old = await run(day, "09:00", { serviceName: "scraping-service", taskName: "scrape" }); // before campaigns: no subject, no pipe
    await cost(old.id, "8", at(day, "09:01"));
    const fee = await run(day, "10:00", { serviceName: "stripe-service", taskName: "charge" });
    await cost(fee.id, "2", at(day, "10:01"));
    const mark = (kind: string, runId: string) =>
      request(app).post("/internal/runs/support-marks").set(getInternalAuthHeaders()).send({ kind, reason: "t", markedBy: "t", runIds: [runId] });
    expect((await mark("unattributed_production", old.id)).status).toBe(200);
    expect((await mark("payment_fees", fee.id)).status).toBe(200);
    await refresh(day);
    const r = await recon(day, day);
    expect(r.totals).toMatchObject({
      spend: { grossCents: "10.0000000000" },
      unattributed: { grossCents: "8.0000000000" },
      support: { grossCents: "2.0000000000" },
      undeclared: { grossCents: "0.0000000000" },
      differences: { grossCents: "0.0000000000" },
    });
    expect(r.totals.shares.unattributed.gross).toBe("0.8000000000");
    expect(r).toMatchObject({ balanced: true, complete: true, declarationsComplete: true, reconciled: true });
    expect(r.services.find((x: any) => x.serviceName === "scraping-service")).toMatchObject({ unattributedRuns: 1, undeclaredRuns: 0 });
  });

  it("v4: a run with no workflow that kept nothing rides its own TASK's production that org-day", async () => {
    const day = "2024-08-09";
    const judge = (hour: string) => run(day, hour, { serviceName: "crm-service", taskName: "judge-lead" }); // no workflow, no campaign
    const kept = await judge("09:00");
    await cost(kept.id, "3", at(day, "09:01"));
    const nothing = await judge("10:00");
    await cost(nothing.id, "5", at(day, "10:01"));
    const otherTask = await run(day, "11:00", { serviceName: "crm-service", taskName: "sync" }); // its task produced nothing
    await cost(otherTask.id, "1", at(day, "11:01"));
    expect(
      (await declare("crm-service", [
        { runId: kept.id, occurredAt: "run_started_at", produced: [{ outcomeKey: "lead_identified", subjectService: "crm-service", subjectId: "R1" }] },
      ])).status,
    ).toBe(201);
    await refresh(day);
    const r = await recon(day, day);
    expect(r.totals).toMatchObject({
      spend: { grossCents: "9.0000000000" },
      declaredProduction: { grossCents: "3.0000000000" },
      normalLoss: { grossCents: "5.0000000000" },
      undeclared: { grossCents: "1.0000000000" },
      differences: { grossCents: "0.0000000000" },
    });
    const occ = await request(app).get(`/internal/outcome-occurrences?runIds=${kept.id}&limit=10`).set(getInternalAuthHeaders());
    expect(occ.body.occurrences[0].cost.grossCents).toBe("8.0000000000");

    // LOSS-SHARE-STORED-1024: the day stored each occurrence's loss share; the read serves it,
    // and a day stored before 0075 (flag off) ranks it live to the same body.
    const [st] = (await db.execute(sql`SELECT count(*)::int AS n, sum(gross)::text AS g FROM cost_loss_occurrence_days WHERE day = ${day}::date`)) as any[];
    expect(st).toMatchObject({ n: 1, g: "5.0000000000" });
    await db.execute(sql`UPDATE cost_ledger_computed_days SET loss_occurrences = false WHERE day = ${day}::date`);
    const liveOcc = await request(app).get(`/internal/outcome-occurrences?runIds=${kept.id}&limit=10`).set(getInternalAuthHeaders());
    expect(liveOcc.body).toEqual(occ.body);
    // A day without stored shares is queued for a recompute, after a far later day (old days come last).
    const queue = await daysToCompute(new Date("2024-08-20T12:00:00Z"), day);
    expect(queue).toContain(day);
    expect(queue.indexOf(day)).toBeGreaterThan(queue.indexOf("2024-08-12"));
    await db.execute(sql`DELETE FROM cost_loss_occurrence_days WHERE day = ${day}::date`);
    expect((await request(app).get(`/internal/outcome-occurrences?runIds=${kept.id}&limit=10`).set(getInternalAuthHeaders())).body).toEqual(occ.body);
    await refresh(day);
    const [flag] = (await db.execute(sql`SELECT loss_occurrences FROM cost_ledger_computed_days WHERE day = ${day}::date`)) as any[];
    expect(flag.loss_occurrences).toBe(true);
  });

  it("SUBJECT-EQUIVALENCE-1024: the owner states subscriber S == lead L, a consumption under S places on the check under L", async () => {
    const day = "2024-08-11";
    const check = await run(day, "09:00", { serviceName: "apollo-service", taskName: "verify-email" });
    await cost(check.id, "4", at(day, "09:01"));
    const send = await run(day, "10:00", { serviceName: "transactional-email-service", taskName: "newsletter-send" });
    expect((await declare("apollo-service", [
      { runId: check.id, occurredAt: "run_started_at", produced: [{ outcomeKey: "email_checked", subjectService: "lead-service", subjectId: "LEAD-EQ-1" }] },
    ])).status).toBe(201);
    expect((await declare("transactional-email-service", [
      { runId: send.id, occurredAt: "run_started_at", produced: [{ outcomeKey: "message_sent", subjectService: "transactional-email-service", subjectId: "SUB-EQ-1" }],
        consumed: [{ outcomeKey: "email_checked", subjectService: "transactional-email-service", subjectId: "SUB-EQ-1" }] },
    ])).status).toBe(201);
    await refresh(day);
    expect((await recon(day, day)).totals.unknownProvenance).toBe("1.0000000000");

    const equate = (serviceName: string, items: unknown[]) =>
      request(app).post("/v1/platform-runs/subject-equivalences").set(getPlatformAuthHeaders({ serviceName })).send({ items, reason: "subscriber email resolved to its lead", statedBy: "t" });
    const item = { subjectService: "transactional-email-service", subjectId: "SUB-EQ-1", targetService: "lead-service", targetId: "LEAD-EQ-1" };
    // Only the owner of the source subject may state it.
    expect((await equate("lead-service", [item])).status).toBe(422);
    expect((await equate("transactional-email-service", [item])).body).toEqual({ recordedCount: 1, alreadyRecordedCount: 0 });
    expect((await equate("transactional-email-service", [item])).body).toEqual({ recordedCount: 0, alreadyRecordedCount: 1 });
    // Immutable: another target is refused; one hop: a chain is refused.
    expect((await equate("transactional-email-service", [{ ...item, targetId: "LEAD-OTHER" }])).body.details.refusals[0].reason).toBe("conflicting_target");
    expect((await equate("lead-service", [{ subjectService: "lead-service", subjectId: "LEAD-EQ-1", targetService: "x", targetId: "y" }])).body.details.refusals[0].reason).toBe("source_is_a_target");

    // The stored day is stale until recomputed, then the consumption has its producer.
    expect((await recon(day, day)).daysStale).toEqual([day]);
    await refresh(day);
    const r = await recon(day, day);
    expect(r.totals.unknownProvenance).toBe("0.0000000000");
    const occ = await request(app).get(`/internal/outcome-occurrences?runIds=${send.id}&direction=consumed&limit=10`).set(getInternalAuthHeaders());
    expect(occ.body.occurrences[0].consumption).toMatchObject({ provenance: "known", sourceRunId: check.id, reuse: false, standardCost: { grossCents: "4.0000000000" } });
  });

  it("SCOPED-VOID-1024: a void scoped to (direction, outcome key) keeps the rest and leaves the run open", async () => {
    const day = "2024-08-12";
    const r1 = await run(day, "09:00", { serviceName: "apollo-service", taskName: "verify-email" });
    await cost(r1.id, "2", at(day, "09:01"));
    expect((await declare("apollo-service", [
      { runId: r1.id, occurredAt: "run_started_at",
        produced: [{ outcomeKey: "email_checked", subjectService: "lead-service", subjectId: "SV1" }],
        consumed: [{ outcomeKey: "email_found", subjectService: "lead-service", subjectId: "SV1" }] },
    ])).status).toBe(201);
    await refresh(day);
    const voidIt = (body: unknown, serviceName = "apollo-service") =>
      request(app).post(`/v1/platform-runs/${r1.id}/outcomes/void`).set(getPlatformAuthHeaders({ serviceName })).send(body);
    const base = { reason: "wrong input key", voidedBy: "t" };
    expect((await voidIt({ ...base, scope: { direction: "consumed", outcomeKey: "email_found" } }, "lead-service")).status).toBe(403);
    const v = await voidIt({ ...base, scope: { direction: "consumed", outcomeKey: "email_found" } });
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ status: "voided", voidedCount: 1 });
    expect((await voidIt({ ...base, scope: { direction: "consumed", outcomeKey: "email_found" } })).body.status).toBe("nothing_to_void");
    const occ = async () =>
      (await request(app).get(`/internal/outcome-occurrences?runIds=${r1.id}&limit=10`).set(getInternalAuthHeaders())).body.occurrences.map((o: any) => `${o.direction}:${o.outcomeKey}`).sort();
    expect(await occ()).toEqual(["produced:email_checked"]);
    // The run stays open: the corrected consumption is declared on the SAME run.
    expect((await declare("apollo-service", [
      { runId: r1.id, occurredAt: "run_started_at", consumed: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "SV1" }] },
    ])).status).toBe(201);
    expect(await occ()).toEqual(["consumed:lead_found", "produced:email_checked"]);
    expect((await recon(day, day)).daysStale).toEqual([day]);
  });

  it("refuses an unknown parameter", async () => {
    const res = await request(app).get(`/internal/outcome-costs/reconciliation?since=${DAY}&foo=1`).set(getInternalAuthHeaders());
    expect(res.status).toBe(400);
  });
});
