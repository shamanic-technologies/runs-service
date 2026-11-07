import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import {
  ALLOCATION_VERSION,
  addDays,
  refreshLedgerDays,
  runLedgerBackfill,
  utcDay,
  type LedgerBackfillState,
} from "../../src/services/outcome-ledger.js";

// NEWSLETTER-COST-1107-LEDGER-STALE: the staff re-price moved 66k postmark sends of
// 2026-10-16..11-03 to 0.165c, it staled their stored ledger days, but the refresher only
// ever recomputed the latest days, so the occurrence read kept serving 1.192362c. A
// re-priced past day must be recomputed by the paced backfill while the tick keeps the
// recent days fresh, and the occurrence read must then serve the new price (the send's
// cost AND the standard cost its consumer is charged).

const ORG = "0c05acc0-1107-4c0a-8b1e-0000000000d7";
const FROZEN = "1.1923620000";
const REAL = "0.1650000000";
const COST = "postmark-email-send";

vi.mock("../../src/services/billing.js", () => ({
  notifyUsage: vi.fn().mockResolvedValue(undefined),
  fetchOrgPlatformSpent: vi.fn().mockResolvedValue(0),
}));
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
const PAST = addDays(TODAY, -6);
const SUBJECT = "SUB-REPRICE-1";

const declare = (serviceName: string, runs: unknown[]) =>
  request(app).post("/v1/platform-runs/outcomes/batch").set(getPlatformAuthHeaders({ serviceName })).send({ runs });
const readSend = async (runId: string) => {
  const res = await request(app).get(`/internal/outcome-occurrences?runIds=${runId}&limit=10`).set(getInternalAuthHeaders());
  expect(res.status).toBe(200);
  return res.body.occurrences[0];
};
const readConsumption = async () => {
  const res = await request(app)
    .get(`/internal/outcome-occurrences?subjectService=lead-service&subjectIds=${SUBJECT}&direction=consumed&outcomeKey=message_sent`)
    .set(getInternalAuthHeaders());
  expect(res.status).toBe(200);
  return res.body.occurrences[0];
};
const backfill = async () => {
  const state: LedgerBackfillState = { running: true, allocationVersion: ALLOCATION_VERSION, startedAt: "", finishedAt: null, pass: 0, remaining: 0, computed: [], failed: [], pausedForLoad: 0, last: null, error: null };
  await runLedgerBackfill(state, 1000, 1, 0, 0);
  expect(state.failed).toEqual([]);
  return state;
};
const computedAt = async (day: string) => {
  const [r] = (await db.execute(sql`
    SELECT computed_at, stale FROM cost_ledger_computed_days WHERE day = ${day}::date AND allocation_version = ${ALLOCATION_VERSION}
  `)) as any[];
  return r ? { at: new Date(r.computed_at).getTime(), stale: r.stale as boolean } : null;
};

describe("a re-priced past day is recomputed and served at the new price (NEWSLETTER-COST-1107-LEDGER-STALE)", () => {
  let send: { id: string };

  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue([
      { costName: COST, provider: "postmark", servedFrom: "2024-01-01T00:00:00Z", billedUnitCostInUsdCents: FROZEN, vendorUnitCostInUsdCents: "0.1" },
      { costName: COST, provider: "postmark", servedFrom: "2024-01-01T00:00:00Z", billedUnitCostInUsdCents: REAL, vendorUnitCostInUsdCents: "0.1" },
    ]);
    stepCatalogue.fn.mockResolvedValue([]);
    // A newsletter send on a past day, at the frozen price, and the release run consuming it.
    send = await insertTestRun({ organizationId: ORG, serviceName: "transactional-email-service", taskName: "send", status: "completed", startedAt: new Date(`${PAST}T09:00:00Z`) });
    await insertTestRunCost({ runId: send.id, costName: COST, quantity: "1", unitCostInUsdCents: FROZEN, totalCostInUsdCents: FROZEN, netCostInUsdCents: FROZEN, status: "actual", createdAt: new Date(`${PAST}T09:00:01Z`) });
    const release = await insertTestRun({ organizationId: ORG, serviceName: "transactional-email-service", taskName: "mailing-list-release-newsletter", status: "completed", startedAt: new Date(`${PAST}T10:00:00Z`) });
    expect((await declare("transactional-email-service", [
      { runId: send.id, occurredAt: "run_started_at", produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: SUBJECT }] },
      { runId: release.id, occurredAt: "run_started_at",
        produced: [{ outcomeKey: "newsletter_email_sent", subjectService: "lead-service", subjectId: SUBJECT }],
        consumed: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: SUBJECT }] },
    ])).status).toBe(201);
    // Every day stored once (tick + backfill), so the read serves the stored figures.
    await refreshLedgerDays(new Date(), Infinity, undefined, 10 * 60_000, true);
    await backfill();
  }, 120_000);

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("the tick keeps the recent days, the backfill recomputes the re-priced day, the read serves 0.165c", async () => {
    expect((await readSend(send.id)).cost.grossCents).toBe(FROZEN);
    expect((await readConsumption()).consumption.standardCost.grossCents).toBe(FROZEN);

    const apply = await request(app).post("/internal/cost-reprices/apply").set(getInternalAuthHeaders()).send({
      orgId: ORG, costName: COST, fromUnitCostInUsdCents: FROZEN, toUnitCostInUsdCents: REAL,
      reason: "frozen catalogue price", repricedBy: "test@distribute.you",
    });
    expect(apply.status).toBe(200);
    expect(apply.body.repricedCostCount).toBe(1);

    // The tick while the backfill runs: recent days only, the past day left to the backfill.
    const pastBefore = await computedAt(PAST);
    const tick = await refreshLedgerDays(new Date(), Infinity, undefined, 10 * 60_000, true);
    expect(tick.failed).toEqual([]);
    expect(tick.computed).toContain(TODAY);
    expect(tick.computed).not.toContain(PAST);
    expect(tick.pastDaysDue).toBeGreaterThan(0);
    expect(await computedAt(PAST)).toEqual({ at: pastBefore!.at, stale: true });
    // The stored day still holds the old price until it is recomputed.
    expect((await readSend(send.id)).cost.grossCents).toBe(FROZEN);

    // The backfill recomputes the re-priced day (and the days after it the re-price staled).
    const state = await backfill();
    expect(state.computed).toContain(PAST);
    expect((await computedAt(PAST))!.stale).toBe(false);

    expect((await readSend(send.id)).cost.grossCents).toBe(REAL);
    expect((await readConsumption()).consumption.standardCost.grossCents).toBe(REAL);
  }, 120_000);
});
