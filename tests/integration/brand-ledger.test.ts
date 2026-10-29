import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { addDays, computeLedgerDay, storeLedgerDay, utcDay } from "../../src/services/outcome-ledger.js";

// FACTORY-P4-PAGES: the books of one brand. The line must reconcile to the cent, agree with the
// totals read on the same brand, and the runs page must list the brand's production orders.

const ORG = "0c05acc0-1029-4c0a-8b1e-0000000000b1";
const B1 = "brand-p4-ledger-1";
const B2 = "brand-p4-ledger-2";

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
const YESTERDAY = addDays(TODAY, -1);
const BASES = ["grossCents", "netCents", "vendorCents", "unpricedGrossCents"] as const;

async function cost(runId: string, qty: string, day: string) {
  await insertTestRunCost({
    runId,
    costName: "tok",
    quantity: qty,
    unitCostInUsdCents: "5",
    totalCostInUsdCents: new Decimal(qty).times(5).toFixed(10),
    status: "actual",
    createdAt: new Date(`${day}T00:00:01Z`),
  });
}

const occ = (outcomeKey: string, subjectId: string) => ({ outcomeKey, subjectService: "lead-service", subjectId });

async function declare(runId: string, body: unknown) {
  const res = await request(app).post(`/v1/runs/${runId}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send(body);
  expect([200, 201]).toContain(res.status);
}

const runIds: Record<string, string> = {};

describe("GET /internal/brands/:brandId/ledger (+ /runs): the books of one brand", () => {
  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockResolvedValue([]);
    const run = (extra: Partial<Parameters<typeof insertTestRun>[0]>, startedAt: string) =>
      insertTestRun({ organizationId: ORG, serviceName: "svc", taskName: "task", status: "completed", startedAt: new Date(startedAt), ...extra });

    // A finds two emails yesterday; B (co-branded) checks them today and reuses one; N spends and declares nothing.
    const a = await run({ brandIds: [B1], campaignId: "cmp-a" }, `${YESTERDAY}T01:00:00Z`);
    await cost(a.id, "2", YESTERDAY);
    await declare(a.id, { produced: [occ("email_found", "p1"), occ("email_found", "p2")] });
    const b = await run({ brandIds: [B1, B2], campaignId: "cmp-b" }, `${TODAY}T00:10:00Z`);
    await cost(b.id, "1", TODAY);
    await declare(b.id, { produced: [occ("email_checked", "p1")], consumed: [occ("email_found", "p1")] });
    const r = await run({ brandIds: [B1], campaignId: "cmp-b" }, `${TODAY}T00:20:00Z`);
    await cost(r.id, "0.4", TODAY);
    await declare(r.id, { produced: [occ("email_checked", "p2")], consumed: [occ("email_found", "p1"), occ("email_found", "p2")] });
    const n = await run({ brandIds: [B1] }, `${TODAY}T00:30:00Z`);
    await cost(n.id, "0.6", TODAY);
    Object.assign(runIds, { a: a.id, b: b.id, r: r.id, n: n.id });

    for (const day of [YESTERDAY, TODAY]) await storeLedgerDay(await computeLedgerDay(day, VERSIONS as any));
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("reconciles to the cent: standard - reuse gain + produced none + abnormal = spend, every basis", async () => {
    const res = await request(app).get(`/internal/brands/${B1}/ledger?since=${YESTERDAY}&until=${TODAY}`).set(getInternalAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.complete).toBe(true);
    const k = res.body.books;
    expect(k.balanced).toBe(true);
    for (const base of BASES) {
      expect(k.difference[base]).toBe("0.0000000000");
      const line = new Decimal(k.standardCharged[base]).minus(k.reuseGain[base]).plus(k.producedNone[base]).plus(k.abnormal[base]);
      expect(line.toFixed(10)).toBe(new Decimal(k.spend[base]).toFixed(10));
      expect(new Decimal(k.standardCharged[base]).minus(k.reuseGain[base]).toFixed(10)).toBe(k.production[base]);
    }
    // Every cost row of the brand's runs happened: 10 + 5 + 2 + 3 cents gross.
    expect(k.spend.grossCents).toBe("20.0000000000");
    // N declared nothing: its 3 cents are produced none.
    expect(new Decimal(k.producedNone.grossCents).gte(3)).toBe(true);
    // R reused p1 (first consumed by B): a reuse gain at p1's standard (5 cents).
    expect(new Decimal(k.reuseGain.grossCents).gt(0)).toBe(true);
  });

  it("agrees with the totals read on the same brand, and the days add up to the books", async () => {
    const [mine, totals] = await Promise.all([
      request(app).get(`/internal/brands/${B1}/ledger?since=${YESTERDAY}&until=${TODAY}`).set(getInternalAuthHeaders()),
      request(app).get(`/internal/stats/outcome-costs?brandId=${B1}&since=${YESTERDAY}&until=${TODAY}`).set(getInternalAuthHeaders()),
    ]);
    expect(totals.status).toBe(200);
    const scope = totals.body.scope[0];
    expect(mine.body.books.spend).toEqual(scope.spend);
    expect(mine.body.books.producedNone).toEqual(scope.producedNone);
    expect(mine.body.books.abnormal).toEqual(scope.abnormal);
    const gain = totals.body.consumed.reduce((a: Decimal, g: any) => a.plus(g.reuseGain.grossCents), new Decimal(0));
    expect(mine.body.books.reuseGain.grossCents).toBe(gain.toFixed(10));
    for (const base of BASES) {
      for (const f of ["spend", "production", "standardCharged", "reuseGain", "producedNone", "abnormal"]) {
        const sum = mine.body.days.reduce((a: Decimal, d: any) => a.plus(d[f][base]), new Decimal(0));
        expect(sum.toFixed(10), `${f}.${base}`).toBe(mine.body.books[f][base]);
      }
    }
    expect(mine.body.days.map((d: any) => d.day)).toEqual([YESTERDAY, TODAY]);
    const quiet = await request(app).get(`/internal/brands/${B2}/ledger?since=${YESTERDAY}&until=${TODAY}`).set(getInternalAuthHeaders());
    expect(quiet.body.days.map((d: any) => [d.day, d.spend.grossCents])).toEqual([[YESTERDAY, "0.0000000000"], [TODAY, quiet.body.books.spend.grossCents]]);
    const produced = Object.fromEntries(mine.body.outcomes.map((o: any) => [o.outcomeKey, o.occurrences]));
    expect(produced).toEqual({ email_found: 2, email_checked: 2 });
  });

  it("refuses an unknown parameter and a bad range", async () => {
    expect((await request(app).get(`/internal/brands/${B1}/ledger?brand=x`).set(getInternalAuthHeaders())).status).toBe(400);
    expect((await request(app).get(`/internal/brands/${B1}/ledger?since=${TODAY}&until=${YESTERDAY}`).set(getInternalAuthHeaders())).status).toBe(400);
    expect((await request(app).get(`/internal/brands/${B1}/ledger`)).status).toBe(401);
  });

  it("lists the brand's production orders newest first, with cost and declared outcomes, and pages on", async () => {
    const res = await request(app).get(`/internal/brands/${B1}/ledger/runs?before=${TODAY}T23:59:59Z`).set(getInternalAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: any) => r.id)).toEqual([runIds.n, runIds.r, runIds.b]);
    const r = res.body.runs[1];
    expect(r.cost.grossCents).toBe("2.0000000000");
    expect(r.produced).toEqual([{ outcomeKey: "email_checked", occurrences: 1 }]);
    expect(r.consumed).toEqual([{ outcomeKey: "email_found", occurrences: 2 }]);
    expect(res.body.runs[0].produced).toEqual([]);

    // Page by one: the keyset continues after the oldest run shown, then the window moves back a day.
    const p1 = await request(app).get(`/internal/brands/${B1}/ledger/runs?before=${TODAY}T23:59:59Z&limit=1`).set(getInternalAuthHeaders());
    expect(p1.body.runs.map((x: any) => x.id)).toEqual([runIds.n]);
    const p2 = await request(app)
      .get(`/internal/brands/${B1}/ledger/runs?before=${encodeURIComponent(p1.body.nextBefore)}&beforeId=${p1.body.nextBeforeId}&limit=1`)
      .set(getInternalAuthHeaders());
    expect(p2.body.runs.map((x: any) => x.id)).toEqual([runIds.r]);
    const older = await request(app).get(`/internal/brands/${B1}/ledger/runs?before=${encodeURIComponent(res.body.nextBefore)}`).set(getInternalAuthHeaders());
    expect(older.body.runs.map((x: any) => x.id)).toEqual([runIds.a]);
    expect((await request(app).get(`/internal/brands/${B2}/ledger/runs?before=${TODAY}T23:59:59Z`).set(getInternalAuthHeaders())).body.runs.map((x: any) => x.id)).toEqual([runIds.b]);
    expect((await request(app).get(`/internal/brands/${B1}/ledger/runs?limit=500`).set(getInternalAuthHeaders())).status).toBe(400);
  });
});
