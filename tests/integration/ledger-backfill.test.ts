import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { ALLOCATION_VERSION, addDays, runLedgerBackfill, utcDay, type LedgerBackfillState } from "../../src/services/outcome-ledger.js";

// FACTORY-P4-PAGES follow-up: the paced backfill computes every past day not current under the
// allocation version (never the three recent days: the tick's), and the books it stores reconcile.

const ORG = "0c05acc0-1029-4c0a-8b1e-0000000000c1";
const BRAND = "brand-p4-backfill";
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

const app = createTestApp();
const TODAY = utcDay(new Date());
const PAST = addDays(TODAY, -5);

describe("paced ledger backfill", () => {
  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue([{ costName: "tok", provider: "acme", servedFrom: "2024-01-01T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" }]);
    stepCatalogue.fn.mockResolvedValue([]);
    const r = await insertTestRun({ organizationId: ORG, serviceName: "svc", taskName: "t", status: "completed", brandIds: [BRAND], startedAt: new Date(`${PAST}T01:00:00Z`) });
    await insertTestRunCost({ runId: r.id, costName: "tok", quantity: "2", unitCostInUsdCents: "5", totalCostInUsdCents: new Decimal(10).toFixed(10), status: "actual", createdAt: new Date(`${PAST}T01:00:01Z`) });
    const res = await request(app).post(`/v1/runs/${r.id}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send({ produced: [{ outcomeKey: "email_found", subjectService: "lead-service", subjectId: "bf1" }] });
    expect([200, 201]).toContain(res.status);
    await db.execute(sql`DELETE FROM cost_ledger_computed_days WHERE day = ${PAST}::date AND allocation_version = ${ALLOCATION_VERSION}`);
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("computes the missing past day, leaves the recent days to the tick, and the books reconcile", async () => {
    const before = await request(app).get(`/internal/brands/${BRAND}/ledger?since=${PAST}&until=${PAST}`).set(getInternalAuthHeaders());
    expect(before.body.daysMissing).toEqual([PAST]);
    const state: LedgerBackfillState = { running: true, allocationVersion: ALLOCATION_VERSION, startedAt: "", finishedAt: null, pass: 0, remaining: 0, computed: [], failed: [], pausedForLoad: 0, last: null, error: null };
    await runLedgerBackfill(state, 1000, 1, 0, 0);
    expect(state.failed).toEqual([]);
    expect(state.computed).toContain(PAST);
    for (let i = 0; i < 3; i++) expect(state.computed).not.toContain(addDays(TODAY, -i));
    const after = await request(app).get(`/internal/brands/${BRAND}/ledger?since=${PAST}&until=${PAST}`).set(getInternalAuthHeaders());
    expect(after.body.complete).toBe(true);
    expect(after.body.books.balanced).toBe(true);
    expect(after.body.books.spend.grossCents).toBe("10.0000000000");
    expect(after.body.books.production.grossCents).toBe("10.0000000000");
  });

  it("starts from the door, refuses a second run and bad options, and reports its state", async () => {
    expect((await request(app).post("/internal/outcome-costs/backfill").set(getInternalAuthHeaders()).send({ maxActive: 0 })).status).toBe(400);
    const start = await request(app).post("/internal/outcome-costs/backfill").set(getInternalAuthHeaders()).send({ maxPasses: 1, restFactor: 0 });
    expect(start.status).toBe(202);
    expect(start.body.running).toBe(true);
    expect((await request(app).post("/internal/outcome-costs/backfill").set(getInternalAuthHeaders()).send({})).status).toBe(409);
    for (let i = 0; i < 120; i++) {
      const s = await request(app).get("/internal/outcome-costs/backfill").set(getInternalAuthHeaders());
      if (!s.body.state.running) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const done = await request(app).get("/internal/outcome-costs/backfill").set(getInternalAuthHeaders());
    expect(done.body.state.running).toBe(false);
    expect(done.body.state.error).toBeNull();
  }, 120_000);
});
