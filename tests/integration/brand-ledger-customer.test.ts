import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { clearBrandLedgerCache } from "../../src/services/brand-ledger.js";
import { addDays, computeLedgerDay, storeLedgerDay, utcDay } from "../../src/services/outcome-ledger.js";

// FACTORY-USER-LEDGER-1102: a client reads the Ledger of its brand, scoped to its own org.
// One brand held by two orgs: each org reads only its runs/rows, the two add up to the staff
// read, the books still balance, and no vendor figure is in either customer body.

const ORG_A = "0c05acc0-1102-4c0a-8b1e-0000000000a1";
const ORG_B = "0c05acc0-1102-4c0a-8b1e-0000000000b2";
const BRAND = "brand-user-ledger-1102";

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
const LINES = ["production", "standardCharged", "reuseGain", "producedNone", "support", "undeclared", "abnormal", "spend", "difference"] as const;
const BASES = ["grossCents", "netCents"] as const;

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

async function declare(orgId: string, runId: string, body: unknown) {
  const res = await request(app).post(`/v1/runs/${runId}/outcomes`).set(getAuthHeaders({ orgId })).send(body);
  expect([200, 201]).toContain(res.status);
}

const ids: Record<string, string> = {};
const range = `since=${YESTERDAY}&until=${TODAY}`;
const staff = (path: string) => request(app).get(`/internal/brands/${BRAND}${path}`).set(getInternalAuthHeaders());
const customer = (orgId: string, path: string) => request(app).get(`/v1/brands/${BRAND}${path}`).set(getAuthHeaders({ orgId }));

describe("GET /v1/brands/:brandId/ledger (+ /runs): a brand's books for the caller's org only", () => {
  beforeAll(async () => {
    await cleanTestData([ORG_A, ORG_B]);
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockResolvedValue([]);
    const run = (orgId: string, startedAt: string, extra: Partial<Parameters<typeof insertTestRun>[0]> = {}) =>
      insertTestRun({ organizationId: orgId, serviceName: "svc", taskName: "task", status: "completed", brandIds: [BRAND], startedAt: new Date(startedAt), ...extra });

    // Org A: finds two emails yesterday, checks one today (a reuse of p1 too), and spends on a run that declares nothing.
    const a1 = await run(ORG_A, `${YESTERDAY}T01:00:00Z`);
    await cost(a1.id, "2", YESTERDAY);
    await declare(ORG_A, a1.id, { produced: [occ("email_found", "p1"), occ("email_found", "p2")] });
    const a2 = await run(ORG_A, `${TODAY}T00:10:00Z`);
    await cost(a2.id, "1", TODAY);
    await declare(ORG_A, a2.id, { produced: [occ("email_checked", "p1")], consumed: [occ("email_found", "p1")] });
    const a3 = await run(ORG_A, `${TODAY}T00:20:00Z`);
    await cost(a3.id, "0.4", TODAY);
    await declare(ORG_A, a3.id, { produced: [occ("email_checked", "p2")], consumed: [occ("email_found", "p1"), occ("email_found", "p2")] });
    // Org B on the same brand: finds one email and spends on a run that declares nothing.
    const b1 = await run(ORG_B, `${TODAY}T00:15:00Z`);
    await cost(b1.id, "3", TODAY);
    await declare(ORG_B, b1.id, { produced: [occ("email_found", "q1")] });
    const b2 = await run(ORG_B, `${TODAY}T00:25:00Z`);
    await cost(b2.id, "0.7", TODAY);
    Object.assign(ids, { a1: a1.id, a2: a2.id, a3: a3.id, b1: b1.id, b2: b2.id });

    for (const day of [YESTERDAY, TODAY]) await storeLedgerDay(await computeLedgerDay(day, VERSIONS as any));
    clearBrandLedgerCache();
  });

  afterAll(async () => {
    await cleanTestData([ORG_A, ORG_B]);
    await closeDb();
  });

  it("each org reads only its own books, the two add up to the staff books, and each balances", async () => {
    const [all, a, b] = await Promise.all([staff(`/ledger?${range}`), customer(ORG_A, `/ledger?${range}`), customer(ORG_B, `/ledger?${range}`)]);
    expect([all.status, a.status, b.status]).toEqual([200, 200, 200]);
    expect(a.body.books.spend.grossCents).toBe("17.0000000000"); // 10 + 5 + 2
    expect(b.body.books.spend.grossCents).toBe("18.5000000000"); // 15 + 3.5
    expect(all.body.books.spend.grossCents).toBe("35.5000000000");
    for (const body of [a.body, b.body]) {
      expect(body.complete).toBe(true);
      expect(body.books.balanced).toBe(true);
      for (const d of body.days) expect(d.balanced).toBe(true);
      for (const base of BASES) expect(body.books.difference[base]).toBe("0.0000000000");
    }
    for (const line of LINES) {
      for (const base of BASES) {
        expect(new Decimal(a.body.books[line][base]).plus(b.body.books[line][base]).toFixed(10), `books.${line}.${base}`).toBe(all.body.books[line][base]);
        for (let i = 0; i < all.body.days.length; i++) {
          expect(new Decimal(a.body.days[i][line][base]).plus(b.body.days[i][line][base]).toFixed(10), `days[${i}].${line}.${base}`).toBe(all.body.days[i][line][base]);
        }
      }
    }
    expect(a.body.days.map((d: any) => d.day)).toEqual(all.body.days.map((d: any) => d.day));
    const occs = (body: any) => Object.fromEntries(body.outcomes.map((o: any) => [o.outcomeKey, o.occurrences]));
    expect(occs(a.body)).toEqual({ email_found: 2, email_checked: 2 });
    expect(occs(b.body)).toEqual({ email_found: 1 });
    expect(occs(all.body)).toEqual({ email_found: 3, email_checked: 2 });
  });

  it("LEDGER-BRAND-SINCE-1106: with no since, each org's books start on ITS first spend day on the brand", async () => {
    const a = await customer(ORG_A, "/ledger");
    const b = await customer(ORG_B, "/ledger");
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.since).toBe(YESTERDAY);
    expect(b.body.since).toBe(TODAY); // org B first spent on the brand today
    expect((await staff("/ledger")).body.since).toBe(YESTERDAY);
    expect(a.body.books).toEqual((await customer(ORG_A, `/ledger?${range}`)).body.books);
    expect(b.body.books).toEqual((await customer(ORG_B, `/ledger?${range}`)).body.books);
  });

  it("serves no vendor figure in either customer body (the staff body keeps it)", async () => {
    const [all, books, runs] = await Promise.all([
      staff(`/ledger?${range}`),
      customer(ORG_A, `/ledger?${range}`),
      customer(ORG_A, `/ledger/runs?before=${TODAY}T23:59:59Z`),
    ]);
    expect(JSON.stringify(all.body)).toContain("vendorCents");
    for (const body of [books.body, runs.body]) {
      expect(JSON.stringify(body)).not.toMatch(/vendor|unpriced/i);
    }
    expect(Object.keys(books.body.books.spend).sort()).toEqual(["grossCents", "netCents"]);
  });

  it("lists only the org's production orders, with counts of its own runs", async () => {
    const page = (orgId: string | null, q = "") => (orgId ? customer(orgId, `/ledger/runs?before=${TODAY}T23:59:59Z${q}`) : staff(`/ledger/runs?before=${TODAY}T23:59:59Z${q}`));
    const [a, b, all] = await Promise.all([page(ORG_A), page(ORG_B), page(null)]);
    expect(a.body.runs.map((r: any) => r.id)).toEqual([ids.a3, ids.a2]);
    expect(b.body.runs.map((r: any) => r.id)).toEqual([ids.b2, ids.b1]);
    expect(all.body.runs.map((r: any) => r.id)).toEqual([ids.b2, ids.a3, ids.b1, ids.a2]);
    expect(a.body.runs[0].cost).toEqual({ grossCents: "2.0000000000", netCents: "2.0000000000" });
    // Paging stays inside the org: the window before today holds only A's first run.
    const older = await customer(ORG_B, `/ledger/runs?before=${encodeURIComponent(b.body.nextBefore)}`);
    expect(older.body.runs).toEqual([]);
    const olderA = await customer(ORG_A, `/ledger/runs?before=${encodeURIComponent(a.body.nextBefore)}`);
    expect(olderA.body.runs.map((r: any) => r.id)).toEqual([ids.a1]);
    expect((await page(ORG_A, "&kind=made")).body.runs.map((r: any) => r.id)).toEqual([ids.a3, ids.a2]);
    expect((await page(ORG_B, "&kind=none")).body.runs.map((r: any) => r.id)).toEqual([ids.b2]);

    // Counts run in the background: poll until they land, per org.
    const counted = async (orgId: string | null) => {
      let r = await page(orgId);
      for (let i = 0; i < 50 && r.body.counts === null; i++) {
        await new Promise((res) => setTimeout(res, 100));
        r = await page(orgId);
      }
      return r.body.counts;
    };
    const [ca, cb, call] = [await counted(ORG_A), await counted(ORG_B), await counted(null)];
    expect(ca).toMatchObject({ all: 2, made: 2, running: 0, none: 0 });
    expect(cb).toMatchObject({ all: 2, made: 1, running: 0, none: 1 });
    expect(call).toMatchObject({ all: 4, made: 3, running: 0, none: 1 });
  });

  it("needs the api key and a valid x-org-id", async () => {
    expect((await request(app).get(`/v1/brands/${BRAND}/ledger`)).status).toBe(401);
    const noOrg = await request(app).get(`/v1/brands/${BRAND}/ledger`).set({ "X-API-Key": "test-api-key" });
    expect(noOrg.status).toBe(400);
    expect((await request(app).get(`/v1/brands/${BRAND}/ledger/runs`).set({ "X-API-Key": "test-api-key", "x-org-id": "nope" })).status).toBe(400);
    expect((await customer(ORG_A, `/ledger?since=${TODAY}&until=${YESTERDAY}`)).status).toBe(400);
  });
});
