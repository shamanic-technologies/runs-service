import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { sql } from "drizzle-orm";
import { createTestApp, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { TEST_STEP_STATES, setAllocationInputsForTests, setLeadStatesSourceForTests } from "../helpers/lead-states.js";
import { db } from "../../src/db/index.js";
import { checkLedgerRow, computeLedgerDay, daysToCompute, ledgerCheckInputOf, storeLedgerDay } from "../../src/services/outcome-ledger.js";
import { syncLeadStates } from "../../src/services/lead-states.js";

// LEAD-STATES-1024-RUNS: allocation v5. A run acting on a lead pays the NEXT state
// that lead had not reached at the run's start, in each family; a run of a pipe
// whose target the lead already reached is ABNORMAL loss, in no unit cost.
//
// Marie (L1) says yes at 12:00. The cold email pipe (target: lead_interested) sent
// her email 1 at 09:00 and email 3 at 13:00; it also emailed L2 (never answered)
// and L4 (visited the site at 10:00, never answered). The meeting pipe (target:
// meeting_booked) followed Marie up at 14:00. A broken loop re-sent email 1 to
// Marie at 09:10.

const ORG = "0c05acc0-1024-4c0a-8b1e-0000000000f5";
const BRAND = "brand-marie";
const DAY = "2024-08-12";
const COLD = "cold-dotterel-v1";
const MEET = "meet-heron-v1";

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
const INPUTS = {
  stepStates: TEST_STEP_STATES,
  pipeTargets: [
    { workflowSlug: COLD, featureSlug: "sales-cold-email-outreach", toStep: "conversation", state: "lead_interested", family: "interest" as const, rank: 1 },
    { workflowSlug: MEET, featureSlug: "ai-meeting-booking", toStep: "meeting_booked", state: "meeting_booked", family: "interest" as const, rank: 2 },
  ],
};
const app = createTestApp();
const at = (hour: string) => new Date(`${DAY}T${hour}:00Z`);

const send = async (hour: string, lead: string, cents: string, opts: { workflow?: string; feature?: string; task?: string } = {}) => {
  const r = await insertTestRun({
    organizationId: ORG,
    serviceName: "instantly-service",
    taskName: opts.task ?? "email-send-step-1",
    brandIds: [BRAND],
    campaignId: "cmp-marie",
    workflowSlug: opts.workflow ?? COLD,
    featureSlug: opts.feature ?? "sales-cold-email-outreach",
    status: "completed",
    startedAt: at(hour),
  });
  await insertTestRunCost({
    runId: r.id,
    costName: "tok",
    quantity: new Decimal(cents).div(5).toString(),
    unitCostInUsdCents: "5",
    totalCostInUsdCents: new Decimal(cents).toFixed(10),
    createdAt: new Date(at(hour).getTime() + 60_000),
  });
  const res = await request(app)
    .post("/v1/platform-runs/outcomes/batch")
    .set(getPlatformAuthHeaders({ serviceName: "instantly-service" }))
    .send({ runs: [{ runId: r.id, occurredAt: "run_started_at", produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: lead }] }] });
  expect(res.status).toBe(201);
  return r;
};

const money = (m: any) => m.grossCents;

describe("Allocation v5: the lead's next state (LEAD-STATES-1024-RUNS)", () => {
  beforeAll(async () => {
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockImplementation(async () => []);
    setAllocationInputsForTests(INPUTS);
    await cleanTestData([ORG]);
    await db.execute(sql`DELETE FROM lead_state_reaches WHERE brand_id = ${BRAND}`);
  });
  afterAll(async () => {
    setLeadStatesSourceForTests([]);
    await db.execute(sql`DELETE FROM lead_state_reaches WHERE brand_id = ${BRAND}`);
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("Marie: a send before the yes pays lead_interested, a send after it is abnormal, a non-answer rides the yes, the other family is priced apart", async () => {
    setLeadStatesSourceForTests([
      { orgId: ORG, brandId: BRAND, leadId: "L1", states: { lead_interested: { reachedAt: at("12:00").toISOString(), basis: "positive_reply", impliedBy: null } } },
      { orgId: ORG, brandId: BRAND, leadId: "L4", states: { lead_visited: { reachedAt: at("10:00").toISOString(), basis: "click", impliedBy: null } } },
      // Reached, date unknown: no unit, no reach (counted nowhere).
      { orgId: ORG, brandId: BRAND, leadId: "L9", states: { paid_client: { reachedAt: null, basis: "sale", impliedBy: null } } },
    ]);
    const synced = await syncLeadStates(TEST_STEP_STATES);
    expect(synced.upserted).toBe(3);

    await send("09:00", "L1", "10"); // before the yes -> L1 interested (unit)
    await send("09:10", "L1", "3", { task: "email-send-step-1" }); // same task, same campaign, same lead: re-bought -> abnormal repeat
    await send("09:00", "L2", "10", { task: "email-send-step-2" }); // never answers -> rides L1 (state loss)
    await send("09:30", "L4", "10", { task: "email-send-step-2" }); // never answers -> rides L1; visit: L4 visited later -> L4 visited (parallel)
    await send("13:00", "L1", "10", { task: "email-send-step-3" }); // after the yes: the cold pipe's target already reached -> abnormal
    await send("14:00", "L1", "5", { workflow: MEET, feature: "ai-meeting-booking", task: "email-send-meeting" }); // meeting pipe: pays meeting_booked, none reached that day -> unpooled

    const d = await computeLedgerDay(DAY, VERSIONS as any, INPUTS);
    const o = d.orgs.find((x) => x.organizationId === ORG)!;
    expect(o.ledger.gross).toBe("48.0000000000");
    expect(o.allocated.gross).toBe("30.0000000000");
    expect(o.normalLoss.gross).toBe("20.0000000000");
    expect(o.producedNone.gross).toBe("5.0000000000");
    expect(o.abnormal.gross).toBe("13.0000000000");
    expect(o.abnormalByReason.target_already_reached?.gross).toBe("10.0000000000");
    expect(o.abnormalByReason.repeat_production?.gross).toBe("3.0000000000");
    expect(checkLedgerRow(ledgerCheckInputOf(o)).balanced).toBe(true);
    for (const k of ["net", "vendor"] as const) {
      expect(new Decimal(o.allocated[k]).plus(o.producedNone[k]).plus(o.abnormal[k]).eq(o.ledger[k])).toBe(true);
    }

    const rows = (kind: string, key?: string) => d.outcomeCosts.filter((r) => r.kind === kind && (key === undefined || r.outcomeKey === key));
    const sum = (xs: any[]) => xs.reduce((s, r) => s.plus(r.money.gross), new Decimal(0)).toFixed(10);
    // The yes carries every send of the pipe before it, its own and the non-answers'.
    expect(sum(rows("produced_cost", "lead_interested"))).toBe("30.0000000000");
    expect(rows("produced_cost", "message_sent")).toHaveLength(0);
    expect(rows("produced_count", "lead_interested").reduce((s, r) => s + Number(r.n), 0)).toBe(1);
    expect(rows("produced_count", "lead_visited").reduce((s, r) => s + Number(r.n), 0)).toBe(1);
    // Two prices, never summed: the cold pipe's sends to leads not yet visited ride L4's visit.
    expect(sum(rows("parallel_cost", "lead_visited"))).toBe("40.0000000000");
    expect(sum(rows("parallel_none"))).toBe("5.0000000000");
    // Abnormal is named per reason, under the paying run's tags.
    const abn = rows("abnormal");
    expect(abn.find((r) => r.abnormalReason === "target_already_reached")?.tags.workflowSlug).toBe(COLD);
    // The meeting follow-up is unpooled loss of its own pipe (it carries a workflow).
    expect(rows("none").find((r) => r.tags.workflowSlug === MEET)?.money.gross).toBe("5.0000000000");

    await storeLedgerDay(d);
    const check = await request(app).get(`/internal/outcome-costs/ledger-check?since=${DAY}&until=${DAY}`).set(getInternalAuthHeaders());
    expect(check.status).toBe(200);
    const row = check.body.rows.find((r: any) => r.organizationId === ORG);
    expect(row.balanced).toBe(true);
    expect(money(row.abnormal)).toBe("13.0000000000");
    expect(money(row.abnormalByReason.repeat_production)).toBe("3.0000000000");

    const recon = await request(app).get(`/internal/outcome-costs/reconciliation?since=${DAY}&until=${DAY}`).set(getInternalAuthHeaders());
    expect(recon.status).toBe(200);
    const day = recon.body.days[0];
    expect(day.balanced).toBe(true);
    expect(money(day.abnormalLoss)).toBe("13.0000000000");
    expect(money(day.unpooledLoss)).toBe("5.0000000000");

    const totals = await request(app)
      .get(`/internal/stats/outcome-costs?since=${DAY}&until=${DAY}&orgId=${ORG}&groupBy=outcomeKey`)
      .set(getInternalAuthHeaders());
    expect(totals.status).toBe(200);
    expect(money(totals.body.produced.find((g: any) => g.dimensions.outcomeKey === "lead_interested").cost)).toBe("30.0000000000");
    expect(totals.body.abnormal.map((g: any) => g.dimensions.abnormalReason).sort()).toEqual(["repeat_production", "target_already_reached"]);
    expect(money(totals.body.parallel.find((g: any) => g.dimensions.outcomeKey === "lead_visited").cost)).toBe("40.0000000000");

    // A re-routed occurrence is a by-product: the per-occurrence read gives it $0.
    const occ = await request(app)
      .get(`/internal/outcome-occurrences?orgId=${ORG}&outcomeKey=message_sent&limit=50`)
      .set(getInternalAuthHeaders());
    expect(occ.status).toBe(200);
    expect(occ.body.occurrences.length).toBe(6);
    for (const x of occ.body.occurrences) expect(money(x.cost)).toBe("0.0000000000");
  });

  it("a booked meeting consumes the lead's interest (the lower state), never the event lead-service declared", async () => {
    const DAY2 = "2024-08-14";
    const at2 = (h: string) => new Date(`${DAY2}T${h}:00Z`);
    // L5 says yes on DAY2 09:00 and books at 15:00; lead-service also DECLARED the booking as an event
    // consuming the positive reply (the pre-v5 shape).
    setLeadStatesSourceForTests([
      { orgId: ORG, brandId: BRAND, leadId: "L1", states: { lead_interested: { reachedAt: at("12:00").toISOString(), basis: "positive_reply", impliedBy: null } } },
      { orgId: ORG, brandId: BRAND, leadId: "L4", states: { lead_visited: { reachedAt: at("10:00").toISOString(), basis: "click", impliedBy: null } } },
      { orgId: ORG, brandId: BRAND, leadId: "L9", states: { paid_client: { reachedAt: null, basis: "sale", impliedBy: null } } },
      { orgId: ORG, brandId: BRAND, leadId: "L5", states: {
        lead_interested: { reachedAt: at2("09:00").toISOString(), basis: "positive_reply", impliedBy: null },
        meeting_booked: { reachedAt: at2("15:00").toISOString(), basis: "meeting_booked", impliedBy: null },
      } },
    ]);
    await syncLeadStates(TEST_STEP_STATES);
    const rec = await insertTestRun({ organizationId: ORG, serviceName: "lead-service", taskName: "outcome-recording", brandIds: [BRAND], status: "completed", startedAt: at2("15:05") });
    const res = await request(app)
      .post("/v1/platform-runs/outcomes/batch")
      .set(getPlatformAuthHeaders({ serviceName: "lead-service" }))
      .send({ runs: [{ runId: rec.id, occurredAt: "run_started_at",
        produced: [{ outcomeKey: "meeting_booked", subjectService: "lead-service", subjectId: "L5" }],
        consumed: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "L5" }] }] });
    expect(res.status).toBe(201);
    const d = await computeLedgerDay(DAY2, VERSIONS as any, INPUTS);
    const booked = d.outcomeCosts.filter((r) => r.outcomeKey === "meeting_booked" && r.organizationId === ORG);
    // One unit: lead-service's first reach, the declared event is not counted again.
    expect(booked.filter((r) => r.kind === "produced_count").reduce((n, r) => n + Number(r.n), 0)).toBe(1);
    const inputs = booked.filter((r) => r.kind === "consumed");
    expect(inputs.map((r) => [r.consumedOutcomeKey, Number(r.n)])).toEqual([["lead_interested", 1]]);
    expect(inputs[0].sourceDay).toBe(DAY2);
  });

  it("a reach lead-service moves after a day was computed makes the day STALE until recomputed", async () => {
    await storeLedgerDay(await computeLedgerDay(DAY, VERSIONS as any, INPUTS));
    expect(await daysToCompute(new Date(`2024-08-17T12:00:00Z`), DAY)).not.toContain(DAY);
    // L2 turns out to have said yes at 09:30: the 09:00 send to L2 now rides L2.
    setLeadStatesSourceForTests([
      { orgId: ORG, brandId: BRAND, leadId: "L1", states: { lead_interested: { reachedAt: at("12:00").toISOString(), basis: "positive_reply", impliedBy: null } } },
      { orgId: ORG, brandId: BRAND, leadId: "L2", states: { lead_interested: { reachedAt: at("09:30").toISOString(), basis: "positive_reply", impliedBy: null } } },
      { orgId: ORG, brandId: BRAND, leadId: "L4", states: { lead_visited: { reachedAt: at("10:00").toISOString(), basis: "click", impliedBy: null } } },
      { orgId: ORG, brandId: BRAND, leadId: "L9", states: { paid_client: { reachedAt: null, basis: "sale", impliedBy: null } } },
    ]);
    const synced = await syncLeadStates(TEST_STEP_STATES);
    expect(synced.changed).toBe(1); // L2 only (L5 was synced by the previous test)
    expect(await daysToCompute(new Date(`2024-08-17T12:00:00Z`), DAY)).toContain(DAY);
    const d = await computeLedgerDay(DAY, VERSIONS as any, INPUTS);
    const units = d.outcomeCosts.filter((r) => r.kind === "produced_cost" && r.outcomeKey === "lead_interested");
    expect(units.reduce((s, r) => s.plus(r.money.gross), new Decimal(0)).toFixed(10)).toBe("30.0000000000");
    expect(checkLedgerRow(ledgerCheckInputOf(d.orgs.find((x) => x.organizationId === ORG)!)).balanced).toBe(true);
  });
});
