import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import {
  addDays, computeLedgerDay, daysWithMovedUnits, refreshLedgerDays, storeLedgerDay, utcDay,
} from "../../src/services/outcome-ledger.js";

// LEDGER-SIGNUP-UNITS-1110 (prod 2026-11-10, Distribute.you signup): lead-service declared each signup on a new
// spend-free run DATED on its past signup day, withdrew it, declared it again (728 made, 620 withdrawn, 108
// standing). Every withdrawal sits on today (recomputed each tick); every back-dated Unit sat on a stale past day
// waiting for the paced backfill: the ledger served 480 made beside -620, the dashboard read "0 from us".
// Now a stale past day's Units are brought current each tick, before (and apart from) its money.

const ORG = "0c05acc0-1110-4c0a-8b1e-000000001110";
const BRAND = "brand-ledger-units-1110";

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
const D = addDays(TODAY, -20); // the signup's own day
const KEY = "signup";
const asLead = () => getPlatformAuthHeaders({ serviceName: "lead-service" });

async function storeDays(days: string[]) {
  for (const d of days) await storeLedgerDay(await computeLedgerDay(d, VERSIONS as any));
}

async function unitsByDay() {
  const res = await request(app)
    .get(`/internal/stats/outcome-costs?since=${D}&until=${TODAY}&brandId=${BRAND}&outcomeKey=${KEY}&groupBy=outcomeKey,day`)
    .set(getInternalAuthHeaders());
  expect(res.status).toBe(200);
  const byDay: Record<string, number> = {};
  for (const g of res.body.produced) byDay[g.dimensions.day] = (byDay[g.dimensions.day] ?? 0) + g.occurrences;
  return { byDay, total: Object.values(byDay).reduce((a, b) => a + b, 0), daysStale: res.body.daysStale as string[] };
}

/** A spend-free lead-service recording run declaring `subjectId` dated on day D, as lead-service does. */
async function declare(subjectId: string) {
  const run = await insertTestRun({
    organizationId: ORG, serviceName: "lead-service", taskName: "outcome-recording", brandIds: [BRAND], status: "completed",
    startedAt: new Date(`${D}T09:00:00Z`),
  });
  const res = await request(app)
    .post("/v1/platform-runs/outcomes/batch")
    .set(asLead())
    .send({ runs: [{ runId: run.id, occurredAt: `${D}T10:00:00.000Z`, produced: [{ outcomeKey: KEY, subjectService: "lead-service", subjectId }] }] });
  expect(res.status).toBe(201);
  return run.id;
}

async function withdraw(runId: string, subjectId: string) {
  const res = await request(app)
    .post("/v1/platform-runs/outcomes/reversals")
    .set({ ...asLead(), "x-org-id": ORG })
    .send({ reversedBy: "lead-service", reversals: [{ runId, outcomeKey: KEY, subjectService: "lead-service", subjectId, reason: "fact taken back: withdrawn" }] });
  expect(res.status).toBe(201);
}

const countRows = async (day: string) =>
  JSON.stringify(await db.execute(sql`
    SELECT kind, outcome_key, organization_id, brand_ids, campaign_id, workflow_slug, feature_slug, audience_id, service_name,
           run_start_day, factory, n::text, quantity::text
    FROM outcome_cost_days WHERE day = ${day}::date AND kind IN ('produced_count', 'produced_elsewhere')
    ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  `));

const computedAt = async (day: string) =>
  ((await db.execute(sql`SELECT computed_at::text AS c, stale FROM cost_ledger_computed_days WHERE day = ${day}::date`)) as any[])[0];

describe("LEDGER-SIGNUP-UNITS-1110: made - withdrawn = standing, whatever day is still being recomputed", () => {
  beforeAll(async () => {
    await cleanTestData([ORG]);
    for (const t of ["cost_ledger_days", "outcome_coverage_days", "cost_ledger_computed_days", "outcome_cost_days", "cost_ledger_stale_sweeps"]) {
      await db.execute(sql.raw(`DELETE FROM ${t}`));
    }
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockResolvedValue([]);
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("a back-dated Unit declared again after a withdrawal is served on its stale day before the day's money is recomputed", async () => {
    // Two signups made on D, both stored.
    const r1 = await declare("lead-1");
    await declare("lead-2");
    await storeDays([D, TODAY]);
    expect((await unitsByDay()).byDay).toEqual({ [D]: 2 });

    // lead-service flaps lead-1: withdrawn today, declared again (dated D) on a new run. One signup each still stands.
    await withdraw(r1, "lead-1");
    await declare("lead-1");
    const stamped = await computedAt(D);

    // The tick recomputes today only (the paced backfill owns D): the bug served 2 made beside -1 = 1 for 2 standing.
    await storeDays([TODAY]);
    const bug = await unitsByDay();
    expect(bug.byDay).toEqual({ [D]: 2, [TODAY]: -1 });

    // The units pass of the tick (no full day computed: maxDays 0) brings D's Units current.
    await refreshLedgerDays(new Date(), 0);
    const fixed = await unitsByDay();
    expect(fixed.byDay).toEqual({ [D]: 3, [TODAY]: -1 });
    expect(fixed.total).toBe(2);
    // The money of D is still the stored one: the day stays stale, its computed_at untouched.
    expect(fixed.daysStale).toContain(D);
    expect(await computedAt(D)).toEqual({ c: stamped.c, stale: true });

    // Nothing moved since: the next tick rewrites nothing.
    expect(await daysWithMovedUnits([D])).toEqual([]);

    // The full recompute stores the same count rows, byte for byte, and clears the flag.
    const units = await countRows(D);
    await storeDays([D]);
    expect(await countRows(D)).toBe(units);
    expect((await computedAt(D)).stale).toBe(false);
    expect((await unitsByDay()).byDay).toEqual({ [D]: 3, [TODAY]: -1 });
  });

  it("a void of a back-dated Unit on a stale day is taken off its day by the units pass", async () => {
    await storeDays([D, TODAY]);
    const r = await declare("lead-3");
    await refreshLedgerDays(new Date(), 0);
    expect((await unitsByDay()).byDay).toEqual({ [D]: 4, [TODAY]: -1 });
    const res = await request(app).post(`/v1/platform-runs/${r}/outcomes/void`).set(asLead()).send({ reason: "test", voidedBy: "LEDGER-SIGNUP-UNITS-1110" });
    expect(res.status).toBe(201);
    expect(await daysWithMovedUnits([D])).toEqual([D]);
    await refreshLedgerDays(new Date(), 0);
    expect((await unitsByDay()).byDay).toEqual({ [D]: 3, [TODAY]: -1 });
  });
});
