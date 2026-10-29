import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { addDays, staleComputedDays, utcDay } from "../../src/services/outcome-ledger.js";

// FACTORY-P4-PAGES: a lead state re-dated, or an equivalence stated, after days were computed stales the
// days its subject's production orders ran on, never every day after the subject's first one (one lead
// first declared in June re-staled 141 of 270 days every tick and the history never converged).

const stepCatalogue = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/outcome-catalogue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/outcome-catalogue.js")>();
  return { ...actual, unknownOutcomeKeys: stepCatalogue.fn };
});

const ORG = "0c05acc0-1029-4c0a-8b1e-0000000000d1";
const LEAD = "lead-stale-narrow-1";
const app = createTestApp();
const TODAY = utcDay(new Date());
const A = addDays(TODAY, -20);
const B = addDays(TODAY, -15);
const C = addDays(TODAY, -10);

describe("staleness narrowed to the subject's run days", () => {
  beforeAll(async () => {
    await cleanTestData([ORG]);
    stepCatalogue.fn.mockResolvedValue([]);
    await db.execute(sql`DELETE FROM lead_state_reaches WHERE lead_id = ${LEAD}`);
    for (const [day, kind] of [[A, "produced"], [C, "consumed"]] as const) {
      const r = await insertTestRun({ organizationId: ORG, serviceName: "svc", taskName: "t", status: "completed", startedAt: new Date(`${day}T08:00:00Z`) });
      await db.execute(sql`UPDATE runs SET completed_at = ${`${day}T09:00:00Z`}::timestamptz WHERE id = ${r.id}::uuid`);
      const occ = { outcomeKey: "lead_found", subjectService: "lead-service", subjectId: LEAD };
      const res = await request(app).post(`/v1/runs/${r.id}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send(kind === "produced" ? { produced: [occ] } : { consumed: [occ] });
      expect([200, 201]).toContain(res.status);
      await db.execute(sql`UPDATE run_outcomes SET declared_at = ${`${day}T08:30:00Z`}::timestamptz, recorded_at = ${`${day}T08:30:00Z`}::timestamptz WHERE run_id = ${r.id}::uuid`);
    }
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM lead_state_reaches WHERE lead_id = ${LEAD}`);
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("a reach changed after the days were computed stales the lead's run days only", async () => {
    const computedAt = new Date(Date.now() - 60_000);
    const computed = new Map([A, B, C, addDays(TODAY, -5)].map((d) => [d, computedAt]));
    expect([...(await staleComputedDays(computed, computedAt))].filter((d) => computed.has(d))).toEqual([]);
    await db.execute(sql`
      INSERT INTO lead_state_reaches (organization_id, brand_id, lead_id, state, family, rank, reached_at, changed_at)
      VALUES (${ORG}::uuid, 'b', ${LEAD}, 'lead_interested', 'interest', 1, ${`${addDays(TODAY, -30)}T00:00:00Z`}::timestamptz, now())
    `);
    const stale = [...(await staleComputedDays(computed, computedAt))].filter((d) => computed.has(d)).sort();
    expect(stale).toEqual([A, C]);
  });
});
