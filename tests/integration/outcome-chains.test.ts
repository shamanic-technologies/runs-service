import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { buildOutcomeChains } from "../../src/services/outcome-chains.js";

// SCRIPT-VALUE-RATING-1113-RUNS: features-service rates each script on what its Units led to further up
// the produce / consume chain: (1) one-step rates between outcomes, (2) per script run, the outcomes its
// chain reached, any depth. Keys are this file's own (catalogue mocked): the build is fleet-wide.

const ORG = "0c11e113-1113-4c0a-8b1e-000000000001";
const B1 = "brand-chn-1113-a";
const B2 = "brand-chn-1113-b";
const WRITTEN = "chn1113_written";
const SENT = "chn1113_sent";
const INTERESTED = "chn1113_interested";
const W_V1 = "chn1113_written/dy_writer/v1";
const W_V2 = "chn1113_written/dy_writer/v2";
const NESTED = "chn1113_other/dy_nested/v1";
const C1 = "0c11e113-1113-4c0a-8b1e-0000000000c1";
const C2 = "0c11e113-1113-4c0a-8b1e-0000000000c2";

const stepCatalogue = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/outcome-catalogue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/outcome-catalogue.js")>();
  return { ...actual, unknownOutcomeKeys: stepCatalogue.fn };
});

const app = createTestApp();
const H = getInternalAuthHeaders();
const at = (iso: string) => new Date(iso);
const declare = (service: string, runs: unknown[]) =>
  request(app).post("/v1/platform-runs/outcomes/batch").set(getPlatformAuthHeaders({ serviceName: service })).send({ runs });
const lead = (id: string) => ({ subjectService: "lead-service", subjectId: `chn1113-${id}` });

const mineSteps = (body: any) => body.steps.filter((s: any) => s.fromOutcome.startsWith("chn1113_"));
const mineConsumed = (body: any) => body.consumed.filter((s: any) => s.outcome.startsWith("chn1113_"));

async function get(path: string) {
  const res = await request(app).get(path).set(H);
  expect(res.status).toBe(200);
  return res.body;
}

describe("SCRIPT-VALUE-RATING-1113: outcome chains", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await cleanTestData([ORG]);
    stepCatalogue.fn.mockResolvedValue([]);

    // Two writer decisions (script v1 brand B1: leads 1 + 2; script v2 brand B2: lead 3), each with a child
    // still working for it; the v1 child declares lead 2's message (a child's Unit is the decision's).
    const w1 = await insertTestRun({ organizationId: ORG, serviceName: "workflow", taskName: "script", scriptSlug: W_V1, brandIds: [B1], campaignId: C1, status: "completed", startedAt: at("2026-11-10T09:00:00Z") });
    const w1child = await insertTestRun({ organizationId: ORG, serviceName: "chat-service", taskName: "complete", scriptSlug: W_V1, brandIds: [B1], parentRunId: w1.id, status: "completed", startedAt: at("2026-11-10T09:00:01Z") });
    const w2 = await insertTestRun({ organizationId: ORG, serviceName: "workflow", taskName: "script", scriptSlug: W_V2, brandIds: [B2], campaignId: C2, status: "completed", startedAt: at("2026-11-11T09:00:00Z") });
    // A writer decision that produced nothing still counts as a run.
    const w3 = await insertTestRun({ organizationId: ORG, serviceName: "workflow", taskName: "script", scriptSlug: W_V2, brandIds: [B2], campaignId: C2, status: "failed", startedAt: at("2026-11-11T10:00:00Z") });
    // A script opened under the v1 decision's own work is its own decision: it pays its own way.
    const nested = await insertTestRun({ organizationId: ORG, serviceName: "workflow", taskName: "script", scriptSlug: NESTED, brandIds: [B1], parentRunId: w1child.id, status: "completed", startedAt: at("2026-11-10T09:00:02Z") });
    const nestedChild = await insertTestRun({ organizationId: ORG, serviceName: "chat-service", taskName: "complete", scriptSlug: NESTED, parentRunId: nested.id, status: "completed", startedAt: at("2026-11-10T09:00:03Z") });
    Object.assign(ids, { w1: w1.id, w1child: w1child.id, w2: w2.id, w3: w3.id, nested: nested.id, nestedChild: nestedChild.id });
    // v1 decision: 10 charged on itself + 5 held on its child (net 4); a cancelled 50 is no spend. Nested: 100 + 7.
    const cost = (runId: string, total: string, extra: Record<string, string> = {}) =>
      insertTestRunCost({ runId, costName: "chn1113-tokens", quantity: "1", unitCostInUsdCents: total, totalCostInUsdCents: total, ...extra });
    await cost(w1.id, "10");
    await cost(w1.id, "50", { status: "cancelled" });
    await cost(w1child.id, "5", { status: "provisioned", netCostInUsdCents: "4" });
    await cost(nested.id, "100");
    await cost(nestedChild.id, "7");
    for (const [k, brand] of [["1", B1], ["2", B1], ["3", B2]] as const) {
      const s = await insertTestRun({ organizationId: ORG, serviceName: "instantly-service", taskName: "send", brandIds: [brand], workflowSlug: "chn1113-send", status: "completed", startedAt: at("2026-11-11T12:00:00Z") });
      ids[`send${k}`] = s.id;
    }
    // One reply-judging run for every lead (a per-org-day judge); its parent declares nothing.
    const judgeTop = await insertTestRun({ organizationId: ORG, serviceName: "instantly-service", taskName: "reply-tick", status: "completed", startedAt: at("2026-11-12T08:00:00Z") });
    const judge = await insertTestRun({ organizationId: ORG, serviceName: "instantly-service", taskName: "reply-judging", workflowSlug: "chn1113-judge", parentRunId: judgeTop.id, status: "completed", startedAt: at("2026-11-12T08:00:01Z") });
    Object.assign(ids, { judgeTop: judgeTop.id, judge: judge.id });

    expect((await declare("workflow", [
      { runId: ids.w1, produced: [{ outcomeKey: WRITTEN, ...lead("1") }] },
      { runId: ids.w2, produced: [{ outcomeKey: WRITTEN, ...lead("3") }] },
    ])).status).toBe(201);
    expect((await declare("chat-service", [{ runId: ids.w1child, produced: [{ outcomeKey: WRITTEN, ...lead("2") }] }])).status).toBe(201);
    expect((await declare("instantly-service", [1, 2, 3].map((n) => ({
      runId: ids[`send${n}`],
      consumed: [{ outcomeKey: WRITTEN, ...lead(String(n)) }],
      produced: [{ outcomeKey: SENT, ...lead(String(n)) }],
    })))).status).toBe(201);
    expect((await declare("instantly-service", [{
      runId: ids.judge,
      consumed: [1, 2, 3].map((n) => ({ outcomeKey: SENT, ...lead(String(n)) })),
      produced: [{ outcomeKey: INTERESTED, ...lead("1") }],
    }])).status).toBe(201);
  });

  afterAll(async () => {
    const mine = `{${Object.values(ids).join(",")}}`;
    await db.execute(sql`DELETE FROM outcome_declaration_events WHERE run_id = ANY(${mine}::uuid[])`);
    await db.execute(sql`DELETE FROM run_lifecycle_events WHERE run_id = ANY(${mine}::uuid[])`);
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("answers 503 before the first build", async () => {
    const built = (await db.execute(sql`SELECT count(*)::int AS n FROM outcome_chain_builds`)) as any[];
    if (built[0].n > 0) return; // another file of the shard built already
    const res = await request(app).get("/internal/stats/outcome-chains/step-rates").set(H);
    expect(res.status).toBe(503);
  });

  it("one-step rates: the share of consumed Units whose consuming run produced the next outcome, fleet and per brand", async () => {
    const b = await buildOutcomeChains();
    expect(b).not.toBeNull();

    const fleet = await get("/internal/stats/outcome-chains/step-rates");
    expect(fleet.brandId).toBeNull();
    expect(mineConsumed(fleet)).toEqual([
      { outcome: SENT, consumedUnits: 3 },
      { outcome: WRITTEN, consumedUnits: 3 },
    ]);
    // The judge consumed 3 sends and produced one positive reply: linked to lead 1's send only.
    // written -> interested was never chained in one step: absent.
    expect(mineSteps(fleet)).toEqual([
      { fromOutcome: SENT, toOutcome: INTERESTED, consumedUnits: 3, ledUnits: 1, share: 0.333333, ledUnitsByPerformer: { script: 1 } },
      { fromOutcome: WRITTEN, toOutcome: SENT, consumedUnits: 3, ledUnits: 3, share: 1, ledUnitsByPerformer: { script: 3 } },
    ]);

    const b1 = await get(`/internal/stats/outcome-chains/step-rates?brandId=${B1}`);
    expect(mineSteps(b1)).toEqual([
      { fromOutcome: SENT, toOutcome: INTERESTED, consumedUnits: 2, ledUnits: 1, share: 0.5, ledUnitsByPerformer: { script: 1 } },
      { fromOutcome: WRITTEN, toOutcome: SENT, consumedUnits: 2, ledUnits: 2, share: 1, ledUnitsByPerformer: { script: 2 } },
    ]);
    const b2 = await get(`/internal/stats/outcome-chains/step-rates?brandId=${B2}`);
    expect(mineSteps(b2)).toEqual([{ fromOutcome: WRITTEN, toOutcome: SENT, consumedUnits: 1, ledUnits: 1, share: 1, ledUnitsByPerformer: { script: 1 } }]);
    expect(mineConsumed(b2)).toEqual([
      { outcome: SENT, consumedUnits: 1 },
      { outcome: WRITTEN, consumedUnits: 1 },
    ]);
  });

  it("script reach: per script run and day, what its chain reached two hops up", async () => {
    const v = await get(`/internal/stats/outcome-chains/script-reach?scriptDynasties=chn1113_written/dy_writer`);
    const zero = { costInUsdCents: "0", netCostInUsdCents: "0" };
    expect(v.groups).toEqual([
      { scriptSlug: W_V1, day: "2026-11-10", producedOutcomes: [WRITTEN], reachedOutcomes: [INTERESTED, SENT], runs: 1, costInUsdCents: "15.0000000000", netCostInUsdCents: "14.0000000000" },
      { scriptSlug: W_V2, day: "2026-11-11", producedOutcomes: [], reachedOutcomes: [], runs: 1, ...zero },
      { scriptSlug: W_V2, day: "2026-11-11", producedOutcomes: [WRITTEN], reachedOutcomes: [SENT], runs: 1, ...zero },
    ]);
    const nested = await get(`/internal/stats/outcome-chains/script-reach?scriptSlugs=${NESTED}`);
    expect(nested.groups).toEqual([
      { scriptSlug: NESTED, day: "2026-11-10", producedOutcomes: [], reachedOutcomes: [], runs: 1, costInUsdCents: "107.0000000000", netCostInUsdCents: "107.0000000000" },
    ]);
    const d = await get(`/internal/stats/outcome-chains/script-reach?scriptDynasties=chn1113_written/dy_writer&groupBy=dynasty&brandId=${B2}&since=2026-11-11&until=2026-11-11`);
    expect(d.groups).toEqual([
      { scriptDynasty: "chn1113_written/dy_writer", day: "2026-11-11", producedOutcomes: [], reachedOutcomes: [], runs: 1, ...zero },
      { scriptDynasty: "chn1113_written/dy_writer", day: "2026-11-11", producedOutcomes: [WRITTEN], reachedOutcomes: [SENT], runs: 1, ...zero },
    ]);
    const one = await get(`/internal/stats/outcome-chains/script-reach?scriptSlugs=${W_V1}`);
    expect(one.groups.map((g: any) => g.scriptSlug)).toEqual([W_V1]);
  });

  it("CAMPAIGN-SCRIPTS-1113: narrowed to campaigns, the same groups count only the decisions run for them", async () => {
    const base = "/internal/stats/outcome-chains/script-reach?scriptDynasties=chn1113_written/dy_writer";
    const all = await get(base);
    expect(all.campaignIds).toBeUndefined();
    const c1 = await get(`${base}&campaignIds=${C1}`);
    expect(c1.campaignIds).toEqual([C1]);
    expect(c1.groups).toEqual([
      { scriptSlug: W_V1, day: "2026-11-10", producedOutcomes: [WRITTEN], reachedOutcomes: [INTERESTED, SENT], runs: 1, costInUsdCents: "15.0000000000", netCostInUsdCents: "14.0000000000" },
    ]);
    const c2 = await get(`${base}&campaignIds=${C2}&groupBy=dynasty`);
    expect(c2.groups.map((g: any) => [g.scriptDynasty, g.runs])).toEqual([
      ["chn1113_written/dy_writer", 1],
      ["chn1113_written/dy_writer", 1],
    ]);
    // Both campaigns = every decision of the dynasty: byte-equal groups to the unfiltered read.
    const both = await get(`${base}&campaignIds=${C2},${C1},${C1}`);
    expect(both.campaignIds).toEqual([C2, C1]);
    expect(both.groups).toEqual(all.groups);
    // The nested decision (no campaign of its own) and an unknown campaign count nothing.
    expect((await get(`/internal/stats/outcome-chains/script-reach?scriptSlugs=${NESTED}&campaignIds=${C1}`)).groups).toEqual([]);
    expect((await get(`${base}&campaignIds=0c11e113-1113-4c0a-8b1e-0000000000ff`)).groups).toEqual([]);
    // A decision row written before the campaign column is read again by the next build.
    await db.execute(sql`UPDATE script_chain_decisions SET campaign_id = NULL, campaign_read = false WHERE decision_run_id = ${ids.w1}::uuid`);
    expect((await get(`${base}&campaignIds=${C1}`)).groups).toEqual([]);
    await buildOutcomeChains();
    expect((await get(`${base}&campaignIds=${C1}`)).groups).toEqual(c1.groups);
    expect((await request(app).get(`${base}&campaignIds=,`).set(H)).status).toBe(400);
  });

  it("a reported Unit resolves to the script decision that made it, in script-reach terms", async () => {
    const resolve = async (units: unknown[]) => {
      const res = await request(app).post("/internal/stats/outcome-chains/unit-decisions").set(H).send({ units });
      expect(res.status).toBe(200);
      return res.body.units as any[];
    };
    // A Unit declared after the last build, on a new decision.
    const late = await insertTestRun({ organizationId: ORG, serviceName: "workflow", taskName: "script", scriptSlug: W_V2, brandIds: [B2], status: "completed", startedAt: at("2026-11-12T09:00:00Z") });
    ids.late = late.id;
    expect((await declare("workflow", [{ runId: late.id, produced: [{ outcomeKey: WRITTEN, ...lead("4") }] }])).status).toBe(201);

    const out = await resolve([
      { outcomeKey: WRITTEN, ...lead("1") },
      { outcomeKey: WRITTEN, ...lead("2") }, // declared by the v1 decision's child
      { outcomeKey: SENT, ...lead("1") }, // the send run names no script
      { outcomeKey: WRITTEN, ...lead("1"), at: "2026-01-01T00:00:00Z" }, // not declared yet then
      { outcomeKey: WRITTEN, ...lead("nobody") },
      { outcomeKey: WRITTEN, ...lead("4") },
    ]);
    expect(out.map((u) => [u.status, u.decisionRunId])).toEqual([
      ["script_decision", ids.w1],
      ["script_decision", ids.w1],
      ["no_script", null],
      ["no_unit", null],
      ["no_unit", null],
      ["not_in_build", ids.late],
    ]);
    expect(out[0].decision).toEqual({
      scriptSlug: W_V1, day: "2026-11-10", brandIds: [B1], producedOutcomes: [WRITTEN], reachedOutcomes: [INTERESTED, SENT],
      costInUsdCents: "15.0000000000", netCostInUsdCents: "14.0000000000",
    });
    expect(out[1].runId).toBe(ids.w1child);
    expect((await request(app).post("/internal/stats/outcome-chains/unit-decisions").set(H).send({ units: [] })).status).toBe(400);
    expect((await request(app).post("/internal/stats/outcome-chains/unit-decisions").set(H).send({ units: [{ outcomeKey: WRITTEN }] })).status).toBe(400);
  });

  it("a reversed Unit leaves every figure; the changes feed serves exactly the rows that moved", async () => {
    await buildOutcomeChains(); // takes in the Unit the previous test declared
    // Full copy first, then the cursor.
    let cursor: string | undefined;
    let full: any = { consumed: [], steps: [], reach: [] };
    let caughtUp = false;
    for (let i = 0; i < 2000 && !caughtUp; i++) {
      // Small pages: other files of the shard hold rows too.
      const page = await get(`/internal/stats/outcome-chains/changes?limit=7${cursor ? `&cursor=${cursor}` : ""}`);
      for (const t of ["consumed", "steps", "reach"]) full[t].push(...page[t]);
      cursor = page.nextCursor;
      caughtUp = page.caughtUp;
    }
    expect(caughtUp).toBe(true);
    expect(full.steps.filter((s: any) => s.fromOutcome === SENT && s.ledUnits > 0)).toHaveLength(1);
    expect(full.reach.filter((r: any) => r.scriptSlug === W_V1)).toEqual([
      expect.objectContaining({ day: "2026-11-10", brandIds: [B1], producedOutcomes: [WRITTEN], reachedOutcomes: [INTERESTED, SENT], runs: 1 }),
    ]);

    // Nothing moved: an unchanged build serves no row.
    await buildOutcomeChains();
    const quiet = await get(`/internal/stats/outcome-chains/changes?cursor=${cursor}`);
    expect([...quiet.consumed, ...quiet.steps, ...quiet.reach].filter((r: any) => JSON.stringify(r).includes("chn1113"))).toEqual([]);

    const rev = await request(app)
      .post("/v1/platform-runs/outcomes/reversals")
      .set({ ...getPlatformAuthHeaders({ serviceName: "instantly-service" }), "x-org-id": ORG })
      .send({ reversedBy: "test", reversals: [{ runId: ids.judge, outcomeKey: INTERESTED, ...lead("1"), reason: "not a reply" }] });
    expect(rev.status).toBe(201);
    await buildOutcomeChains();

    const fleet = await get("/internal/stats/outcome-chains/step-rates");
    expect(mineSteps(fleet).map((s: any) => `${s.fromOutcome}>${s.toOutcome}`)).toEqual([`${WRITTEN}>${SENT}`]);

    const moved = await get(`/internal/stats/outcome-chains/changes?cursor=${quiet.nextCursor}`);
    expect(moved.caughtUp).toBe(true);
    const mine = (rows: any[]) => rows.filter((r: any) => JSON.stringify(r).includes("chn1113"));
    // The pair is served once at 0 (replace, never add); the v1 run moves from one reach row to another.
    expect(mine(moved.steps)).toEqual([expect.objectContaining({ fromOutcome: SENT, toOutcome: INTERESTED, brandIds: [B1], ledUnits: 0, ledUnitsByPerformer: {} })]);
    expect(mine(moved.consumed)).toEqual([]);
    expect(mine(moved.reach).map((r: any) => [r.reachedOutcomes, r.runs])).toEqual(
      expect.arrayContaining([[[INTERESTED, SENT], 0], [[SENT], 1]]),
    );
    expect(mine(moved.reach)).toHaveLength(2);
  });

  it("a burst of 10 reads at once all answer, fast", async () => {
    const t0 = Date.now();
    const paths = Array.from({ length: 10 }, (_, i) =>
      i % 3 === 0
        ? "/internal/stats/outcome-chains/step-rates"
        : i % 3 === 1
          ? `/internal/stats/outcome-chains/script-reach?brandId=${B1}`
          : `/internal/stats/outcome-chains/step-rates?brandId=${B2}`,
    );
    const out = await Promise.all(paths.map((p) => request(app).get(p).set(H)));
    expect(out.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("refuses bad filters and cursors", async () => {
    expect((await request(app).get("/internal/stats/outcome-chains/script-reach?groupBy=brand").set(H)).status).toBe(400);
    expect((await request(app).get("/internal/stats/outcome-chains/script-reach?since=2026-1-1").set(H)).status).toBe(400);
    expect((await request(app).get("/internal/stats/outcome-chains/changes?cursor=nope").set(H)).status).toBe(400);
    expect((await request(app).get("/internal/stats/outcome-chains/changes?limit=0").set(H)).status).toBe(400);
    expect((await request(app).get("/internal/stats/outcome-chains/step-rates")).status).toBe(401);
  });
});
