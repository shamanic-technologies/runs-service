import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db, statsDb } from "../../src/db/index.js";
import { sql } from "drizzle-orm";

// SOCIAL-OUTCOMES-1107: features-service builds a brand's "Newsletter email sent" page from
// GET /internal/outcome-occurrences: the org's newsletter_email_sent CONSUMED occurrences (none
// exist), then every page of a newsletter release run, produced and consumed (one release =
// ~15-20k Units, each consuming the subscriber's message_sent). In prod each of those pages
// 500'd: the org read walked the whole occurrence table in id order, the consumed page resolved
// each consumption by re-scanning every subject member, and the 30 s stats timeout fired at box
// load 30-45. Here: the same shapes answer 200 with the right producers, and a timeout is a
// named 503.

const ORG = "50c1a100-1107-4c0a-8b1e-000000000001";
const SVC = "transactional-email-service";
const N = 250; // subscribers
const RESENT = 20; // subscribers sent twice before the newsletter: the later send is the producer
const NO_SEND = 10; // the last subscribers were never sent anything: unknown provenance

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
const sub = (i: number) => `sub-${i}`;
const run = (taskName: string) =>
  insertTestRun({ organizationId: ORG, serviceName: SVC, taskName, status: "completed", startedAt: new Date(Date.now() - 3600_000) });

async function declare(runId: string, body: unknown) {
  const res = await request(app).post(`/v1/runs/${runId}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send(body);
  expect(res.status).toBe(201);
}

async function readAll(params: Record<string, string>, limit: number) {
  const out: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const q = new URLSearchParams({ ...params, limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    const res = await request(app).get(`/internal/outcome-occurrences?${q}`).set(getInternalAuthHeaders());
    expect(res.status).toBe(200);
    out.push(...res.body.occurrences);
    if (!res.body.nextCursor) break;
    cursor = res.body.nextCursor;
  }
  return out;
}

describe("Newsletter outcome page reads (SOCIAL-OUTCOMES-1107)", () => {
  const firstSend = new Map<string, string>();
  const secondSend = new Map<string, string>();
  let newsletter: string;
  let later: string;

  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue([
      { costName: "tok", provider: "acme", servedFrom: "2024-01-01T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" },
    ]);
    stepCatalogue.fn.mockResolvedValue([]);
    for (let i = 0; i < N - NO_SEND; i++) {
      const r = await run("send");
      await declare(r.id, { produced: [{ outcomeKey: "message_sent", subjectService: SVC, subjectId: sub(i) }] });
      firstSend.set(sub(i), r.id);
    }
    for (let i = 0; i < RESENT; i++) {
      const r = await run("send");
      await declare(r.id, { produced: [{ outcomeKey: "message_sent", subjectService: SVC, subjectId: sub(i) }] });
      secondSend.set(sub(i), r.id);
    }
    newsletter = (await run("newsletter-email-units")).id;
    await insertTestRunCost({ runId: newsletter, costName: "tok", quantity: "50", unitCostInUsdCents: "5", totalCostInUsdCents: "250.0000000000", status: "actual" });
    const subs = Array.from({ length: N }, (_, i) => ({ subjectService: SVC, subjectId: sub(i) }));
    await declare(newsletter, {
      produced: subs.map((s) => ({ outcomeKey: "newsletter_email_sent", ...s })),
      consumed: subs.map((s) => ({ outcomeKey: "message_sent", ...s })),
    });
    // A second release to the first 10 subscribers re-uses their send.
    later = (await run("newsletter-email-units")).id;
    await declare(later, { consumed: subs.slice(0, 10).map((s) => ({ outcomeKey: "message_sent", ...s })) });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("the org's newsletter_email_sent CONSUMED read answers 200 with nothing, through its own index", async () => {
    const rows = await readAll({ orgId: ORG, outcomeKey: "newsletter_email_sent", direction: "consumed" }, 1000);
    expect(rows).toEqual([]);
    const idx = (await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_run_outcomes_key_direction_id'`)) as any[];
    expect(idx[0]?.indexdef).toContain("(outcome_key, direction, id)");
  });

  it("every produced page of a release answers, in id order, each Unit priced", async () => {
    const rows = await readAll({ runIds: newsletter, outcomeKey: "newsletter_email_sent", direction: "produced" }, 100);
    expect(rows).toHaveLength(N);
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort());
    for (const r of rows) expect(r.cost.grossCents).toBe("1.0000000000"); // 250 cents over 250 Units
  });

  it("every consumed page resolves each send to the latest one before it, reuse and unknown provenance kept", async () => {
    const rows = await readAll({ runIds: newsletter, direction: "consumed" }, 100);
    expect(rows).toHaveLength(N);
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort());
    for (const r of rows) {
      const want = secondSend.get(r.subjectId) ?? firstSend.get(r.subjectId) ?? null;
      expect(r.consumption.sourceRunId).toBe(want);
      expect(r.consumption.provenance).toBe(want ? "known" : "unknown");
      expect(r.consumption.reuse).toBe(false);
    }
    const again = await readAll({ runIds: later, direction: "consumed" }, 1000);
    expect(again).toHaveLength(10);
    for (const r of again) {
      expect(r.consumption.sourceRunId).toBe(secondSend.get(r.subjectId));
      expect(r.consumption.reuse).toBe(true);
    }
  });

  it("a subject read answers through the subject index", async () => {
    const rows = await readAll({ subjectService: SVC, subjectIds: `${sub(0)},${sub(N - 1)}` }, 1000);
    // sub-0: two sends + newsletter Unit + two consumptions; the last subscriber: its Unit + its consumption.
    expect(rows).toHaveLength(7);
  });

  it("a statement past the read's timeout is a named 503, never a bare 500", async () => {
    const timeout = Object.assign(new Error("Failed query: ..."), { cause: Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }) });
    const spy = vi.spyOn(statsDb, "transaction").mockRejectedValueOnce(timeout);
    const res = await request(app)
      .get(`/internal/outcome-occurrences?runIds=${newsletter}&direction=consumed&limit=1000`)
      .set(getInternalAuthHeaders());
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/^outcome_occurrences_timeout:/);
  });

  // BOX-LOAD-1107-RUNS: a page prices only its own occurrences (and its consumptions'
  // producers); each share is still cut over EVERY occurrence of the anchor. An uneven
  // split (1 cent over 3 Units: cumulative rounding) read one row per page must equal the
  // one-page read, Unit for Unit, cost for cost, standard cost included.
  it("a page of one prices each Unit exactly as the whole-run read does", async () => {
    const uneven = (await run("uneven-units")).id;
    await insertTestRunCost({ runId: uneven, costName: "tok", quantity: "0.2", unitCostInUsdCents: "5", totalCostInUsdCents: "1.0000000000", status: "actual" });
    const subs = [0, 1, 2].map((i) => ({ subjectService: SVC, subjectId: `uneven-${i}` }));
    await declare(uneven, { produced: subs.map((s) => ({ outcomeKey: "message_sent", ...s })) });
    const user = (await run("uneven-consumer")).id;
    await declare(user, { consumed: subs.map((s) => ({ outcomeKey: "message_sent", ...s })) });

    const strip = (rows: any[]) => rows.map((r) => ({ id: r.id, cost: r.cost, costSlices: r.costSlices, consumption: r.consumption }));
    const whole = strip(await readAll({ runIds: uneven, direction: "produced" }, 100));
    expect(whole).toHaveLength(3);
    expect(whole.map((r) => r.cost.grossCents).sort()).toEqual(["0.3333333333", "0.3333333333", "0.3333333334"]);
    expect(strip(await readAll({ runIds: uneven, direction: "produced" }, 1))).toEqual(whole);

    const consumedWhole = strip(await readAll({ runIds: user, direction: "consumed" }, 100));
    expect(consumedWhole.map((r) => r.consumption.standardCost.grossCents).sort()).toEqual(["0.3333333333", "0.3333333333", "0.3333333334"]);
    expect(strip(await readAll({ runIds: user, direction: "consumed" }, 1))).toEqual(consumedWhole);
  });
});
