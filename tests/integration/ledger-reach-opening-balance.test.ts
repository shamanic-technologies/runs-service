import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { computeLedgerDay, firstLedgerDay, staleComputedDays, storeLedgerDay, utcDay } from "../../src/services/outcome-ledger.js";

// TODAY-MEETINGS-1117 (owner 2026-11-07: every conversion counts, the same figure on the client's dashboard
// and on our homepage): Doc Dinners' Today page read 63 booked meetings while lead-service held 173, because
// 110 were dated before the ledger's first stored day and counted on no stored day. A reach dated before the
// first day counts on the first day (opening balance); a reach served with NO date counts on the day the
// ledger first received it.

const ORG = "0c05acc0-1117-4c0a-8b1e-0000000000a1";
const BRAND = "brand-today-meetings-1117";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});

const app = createTestApp();
const TODAY = utcDay(new Date());
let FIRST = "";

const elsewhereOf = async (since: string, until: string, whole = true) => {
  const res = await request(app)
    .get(`/internal/stats/outcome-costs?brandId=${BRAND}&since=${since}&until=${until}&groupBy=outcomeKey`)
    .set(getInternalAuthHeaders());
  expect(res.status).toBe(200);
  // Days between FIRST and TODAY no test stored are missing; the stored ones still sum.
  if (whole) expect(res.body.daysMissing).toEqual([]);
  const rows = res.body.producedElsewhere.filter((g: any) => g.dimensions.outcomeKey === "meeting_booked");
  return Object.fromEntries(rows.map((g: any) => [g.dimensions.factory, g.occurrences]));
};

describe("TODAY-MEETINGS-1117: every booked meeting a client stated counts, dated or not", () => {
  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue([]);
    await db.execute(sql`DELETE FROM lead_state_reaches WHERE brand_id = ${BRAND}`);
    FIRST = await firstLedgerDay(TODAY);
    // A CRM meeting from 2024, long before the ledger's first day (no proof of ours).
    await db.execute(sql`
      INSERT INTO lead_state_reaches (organization_id, brand_id, lead_id, state, family, rank, reached_at, changed_at, caused_by_outreach)
      VALUES (${ORG}::uuid, ${BRAND}, 'crm-2024', 'meeting_booked', 'interest', 2, '2024-08-24T10:00:00Z'::timestamptz, now(), null)
    `);
    // An undated CRM fact (lead-service states it, with no date): received now.
    await db.execute(sql`
      INSERT INTO lead_state_reaches (organization_id, brand_id, lead_id, state, family, rank, reached_at, changed_at, caused_by_outreach)
      VALUES (${ORG}::uuid, ${BRAND}, 'crm-undated', 'meeting_booked', 'interest', 2, NULL, now(), false)
    `);
    await storeLedgerDay(await computeLedgerDay(FIRST, []));
    if (TODAY !== FIRST) await storeLedgerDay(await computeLedgerDay(TODAY, []));
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM lead_state_reaches WHERE brand_id = ${BRAND}`);
    await db.execute(sql`DELETE FROM outcome_cost_days WHERE organization_id = ${ORG}::uuid`);
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("a reach dated before the ledger's first day counts on that first day (opening balance)", async () => {
    expect(await elsewhereOf(FIRST, FIRST)).toMatchObject({ no_proof: 1 });
  });

  it("an undated CRM fact counts on the day it was received", async () => {
    expect(await elsewhereOf(TODAY, TODAY)).toMatchObject({ another_factory: 1 });
  });

  it("since inception, both count: total = every fact the client stated", async () => {
    const by = await elsewhereOf(FIRST, TODAY, false);
    expect(by).toEqual({ no_proof: 1, another_factory: 1 });
  });

  it("a change to a pre-inception reach stales the first day (where its Unit counts)", async () => {
    const before = new Date(Date.now() - 1000);
    await db.execute(sql`UPDATE lead_state_reaches SET changed_at = now() WHERE brand_id = ${BRAND} AND lead_id = 'crm-2024'`);
    const stale = await staleComputedDays(new Map([[FIRST, before]]));
    expect(stale.has(FIRST)).toBe(true);
  });
});
