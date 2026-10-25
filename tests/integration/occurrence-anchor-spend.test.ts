import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { computeLedgerDay, storeLedgerDay } from "../../src/services/outcome-ledger.js";

// OCC-READ-ANCHOR-SPEND-1025: GET /internal/outcome-occurrences priced every anchor by
// walking its whole subtree. A newsletter run with 18,250 children took > 30 s on the
// box, so a single consumption resolving to one of its sends answered 500. The
// refresher now stores each anchor's spend per (cost day, org); the read prices an
// anchor whose whole span is stored from those rows (same groups, same amounts) and
// never walks it.

const ORG = "0c05acc0-1025-4c0a-8b1e-0000000000a5";

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
const CATALOGUE = new Set(["message_sent", "conversation"]);
const app = createTestApp();

const run = (extra: Partial<Parameters<typeof insertTestRun>[0]> = {}) =>
  insertTestRun({ organizationId: ORG, serviceName: "transactional-email-service", taskName: "mailing-list-release-newsletter", status: "completed", ...extra });
const cost = (runId: string, cents: string) =>
  insertTestRunCost({
    runId,
    costName: "tok",
    quantity: new Decimal(cents).div(5).toString(),
    unitCostInUsdCents: "5",
    totalCostInUsdCents: new Decimal(cents).toFixed(10),
    status: "actual",
    createdAt: new Date(),
  });
const declare = (serviceName: string, runs: unknown[]) =>
  request(app).post("/v1/platform-runs/outcomes/batch").set(getPlatformAuthHeaders({ serviceName })).send({ runs });
const read = async (query: string) => {
  const res = await request(app).get(`/internal/outcome-occurrences?${query}`).set(getInternalAuthHeaders());
  expect(res.status).toBe(200);
  return res.body;
};
const today = () => new Date().toISOString().slice(0, 10);
const refreshToday = async () => storeLedgerDay(await computeLedgerDay(today(), VERSIONS as any));

describe("Occurrence read prices an anchor from its stored spend (OCC-READ-ANCHOR-SPEND-1025)", () => {
  beforeAll(async () => {
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockImplementation(async (keys: string[]) => keys.filter((k) => !CATALOGUE.has(k)));
    await cleanTestData([ORG]);
  });
  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("serves the stored spend, equal to the walk, and never walks a stored anchor", async () => {
    // The newsletter: 3 sends on the root, spend on its own row, on children and a grandchild.
    const news = await run();
    await cost(news.id, "1");
    const childA = await run({ parentRunId: news.id, taskName: "send-batch" });
    await cost(childA.id, "2");
    const grandchild = await run({ parentRunId: childA.id, taskName: "render" });
    await cost(grandchild.id, "4");
    // A child that declares its own production is ITS anchor: its spend is not the newsletter's.
    const ownAnchor = await run({ parentRunId: news.id, taskName: "send-transactional" });
    await cost(ownAnchor.id, "8");
    const subjects = ["SUB-AS-1", "SUB-AS-2", "SUB-AS-3"];
    expect((await declare("transactional-email-service", [
      { runId: news.id, occurredAt: "run_started_at", produced: subjects.map((subjectId) => ({ outcomeKey: "message_sent", subjectService: "lead-service", subjectId })) },
      { runId: ownAnchor.id, occurredAt: "run_started_at", produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: "SUB-AS-OWN" }] },
    ])).status).toBe(201);
    // A reply judged on another run consumes one of the newsletter's sends.
    const judge = await run({ serviceName: "instantly-service", taskName: "reply-judging" });
    expect((await declare("instantly-service", [
      { runId: judge.id, occurredAt: "run_started_at",
        produced: [{ outcomeKey: "conversation", subjectService: "lead-service", subjectId: "SUB-AS-2" }],
        consumed: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: "SUB-AS-2" }] },
    ])).status).toBe(201);

    const byRun = `runIds=${news.id}&limit=10`;
    const bySubject = "subjectService=lead-service&subjectIds=SUB-AS-2&direction=consumed&outcomeKey=message_sent";
    const liveRun = await read(byRun);
    const liveSubject = await read(bySubject);
    const total = (b: any) => b.occurrences.reduce((s: Decimal, o: any) => s.plus(o.cost.grossCents), new Decimal(0)).toFixed(10);
    expect(total(liveRun)).toBe("7.0000000000"); // 1 + 2 + 4, never the child anchor's 8
    expect(liveSubject.occurrences).toHaveLength(1);
    expect(liveSubject.occurrences[0].consumption.sourceRunId).toBe(news.id);

    await refreshToday();
    const [flag] = (await db.execute(sql`SELECT anchor_spend FROM cost_ledger_computed_days WHERE day = ${today()}::date AND allocation_version = 6`)) as any[];
    expect(flag.anchor_spend).toBe(true);
    const storedRows = (await db.execute(sql`SELECT gross::text AS g FROM cost_anchor_spend_days WHERE anchor_id = ${news.id}::uuid`)) as any[];
    expect(storedRows.map((r) => new Decimal(r.g).toFixed(10))).toEqual(["7.0000000000"]);

    // Stored = walked, to the cent, for the run read and the single-consumption read.
    expect(await read(byRun)).toEqual(liveRun);
    expect(await read(bySubject)).toEqual(liveSubject);

    // The stored rows ARE what the read serves: a spend the walk would see is not walked.
    await cost(grandchild.id, "3");
    expect(total(await read(byRun))).toBe("7.0000000000");
    // ...until the day is recomputed.
    await refreshToday();
    expect(total(await read(byRun))).toBe("10.0000000000");

    // A day stored before 0080 (flag off) keeps the anchor live, to the same body.
    const stored = await read(byRun);
    await db.execute(sql`UPDATE cost_ledger_computed_days SET anchor_spend = false WHERE day = ${today()}::date AND allocation_version = 6`);
    expect(await read(byRun)).toEqual(stored);
    await refreshToday();

    // An anchor born after the day's last computation is walked live (its spend is in no stored row).
    const late = await run();
    await cost(late.id, "5");
    expect((await declare("transactional-email-service", [
      { runId: late.id, occurredAt: "run_started_at", produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: "SUB-AS-LATE" }] },
    ])).status).toBe(201);
    const lateRead = await read(`runIds=${late.id}&limit=10`);
    expect(lateRead.occurrences[0].cost.grossCents).toBe("5.0000000000");
  });
});
