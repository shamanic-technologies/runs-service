import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { addDays, computeLedgerDay, storeLedgerDay, utcDay } from "../../src/services/outcome-ledger.js";

// LEDGER-OTHER-FACTORY-1107 (owner 2026-11-07: « ON VEUT LE TOTAL ET LES STATS PAR OUTCOME ...
// INDEPENDAMMENT DES SOURCES »): a lead state another factory reached (or with no proof of ours) is
// stored as its own Unit, served in producedElsewhere, never in produced[] (our unit cost divides ours).

const ORG = "0c05acc0-1107-4c0a-8b1e-0000000000f1";
const BRAND = "brand-other-factory-1107";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});

const app = createTestApp();
const DAY = addDays(utcDay(new Date()), -350);

describe("LEDGER-OTHER-FACTORY-1107: the total Units of a lead state, every source", () => {
  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue([]);
    await db.execute(sql`DELETE FROM lead_state_reaches WHERE brand_id = ${BRAND}`);
    for (const [lead, caused] of [["of-ours", true], ["of-theirs-1", false], ["of-theirs-2", false], ["of-unknown", null]] as const) {
      await db.execute(sql`
        INSERT INTO lead_state_reaches (organization_id, brand_id, lead_id, state, family, rank, reached_at, changed_at, caused_by_outreach)
        VALUES (${ORG}::uuid, ${BRAND}, ${lead}, 'paid_client', 'interest', 4, ${`${DAY}T10:00:00Z`}::timestamptz, now(), ${caused})
      `);
    }
    // A removed reach is no Unit, whoever made it.
    await db.execute(sql`
      INSERT INTO lead_state_reaches (organization_id, brand_id, lead_id, state, family, rank, reached_at, changed_at, caused_by_outreach, removed_at)
      VALUES (${ORG}::uuid, ${BRAND}, 'of-removed', 'paid_client', 'interest', 4, ${`${DAY}T11:00:00Z`}::timestamptz, now(), false, now())
    `);
    await storeLedgerDay(await computeLedgerDay(DAY, []));
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM lead_state_reaches WHERE brand_id = ${BRAND}`);
    await db.execute(sql`DELETE FROM outcome_cost_days WHERE organization_id = ${ORG}::uuid`);
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("ours stay in produced[]; another factory's and unproven ones are in producedElsewhere, total = 4", async () => {
    const res = await request(app)
      .get(`/internal/stats/outcome-costs?brandId=${BRAND}&since=${DAY}&until=${DAY}&groupBy=outcomeKey`)
      .set(getInternalAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.daysMissing).toEqual([]);
    const ours = res.body.produced.find((g: any) => g.dimensions.outcomeKey === "paid_client");
    expect(ours.occurrences).toBe(1);
    const elsewhere = res.body.producedElsewhere.filter((g: any) => g.dimensions.outcomeKey === "paid_client");
    const by = Object.fromEntries(elsewhere.map((g: any) => [g.dimensions.factory, g.occurrences]));
    expect(by).toEqual({ another_factory: 2, no_proof: 1 });
    expect(ours.occurrences + elsewhere.reduce((s: number, g: any) => s + g.occurrences, 0)).toBe(4);
  });

  it("a day stored before 0104 is missing until recomputed", async () => {
    await db.execute(sql`UPDATE cost_ledger_computed_days SET other_factories = false WHERE day = ${DAY}::date`);
    const res = await request(app)
      .get(`/internal/stats/outcome-costs?brandId=${BRAND}&since=${DAY}&until=${DAY}&groupBy=outcomeKey`)
      .set(getInternalAuthHeaders());
    expect(res.body.daysMissing).toEqual([DAY]);
    await storeLedgerDay(await computeLedgerDay(DAY, []));
  });
});
