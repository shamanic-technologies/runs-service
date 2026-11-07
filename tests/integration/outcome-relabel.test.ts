import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { addDays, computeLedgerDay, daysToCompute, storeLedgerDay, checkLedgerRow, ledgerCheckInputOf, utcDay } from "../../src/services/outcome-ledger.js";

// OUTCOME-RELABEL-1107: the coarse outcome post_published is retired (owner 2026-11-07); its
// recorded occurrences move to their network's fine key through a staff relabel, never deleted.

const ORG = "0c05acc0-1107-4c0a-8b1e-000000000001";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});

// The catalogue after the retirement: the fine keys, no post_published.
const CATALOGUE = new Set(["threads_post_published", "x_post_published", "linkedin_post_published", "website_visit", "message_written"]);
const stepCatalogue = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/outcome-catalogue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/outcome-catalogue.js")>();
  return { ...actual, unknownOutcomeKeys: stepCatalogue.fn };
});

const VERSIONS = [
  { costName: "tok", provider: "acme", servedFrom: "2024-01-01T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" },
];

const app = createTestApp();
const DAY = addDays(utcDay(new Date()), -9);

const post = (outcomeKey: string, subjectId: string, subjectService = "meta-service") => ({ outcomeKey, subjectService, subjectId });

async function runWithCost(cents = "100") {
  const r = await insertTestRun({ organizationId: ORG, serviceName: "meta-service", taskName: "threads-publish", status: "completed", startedAt: new Date(`${DAY}T09:00:00Z`) });
  await insertTestRunCost({ runId: r.id, costName: "tok", quantity: "20", unitCostInUsdCents: "5", totalCostInUsdCents: `${cents}.0000000000`, status: "actual", createdAt: new Date(`${DAY}T10:00:00Z`) });
  return r;
}

/** Inserts the coarse key straight through the bronze log, as recorded before its retirement. */
async function recordCoarse(runId: string, items: Array<{ direction: "produced" | "consumed"; subjectId: string; subjectService?: string }>) {
  const payload = {
    items: items.map((i) => ({
      id: crypto.randomUUID(),
      direction: i.direction,
      outcome_key: "post_published",
      subject_service: i.subjectService ?? "meta-service",
      subject_id: i.subjectId,
      quantity: 1,
      declared_at: `${DAY}T10:30:00Z`,
    })),
  };
  await db.execute(sql`INSERT INTO outcome_declaration_events (run_id, event_type, source_service, payload, occurred_at)
    VALUES (${runId}::uuid, 'outcomes.declared', 'meta-service', ${JSON.stringify(payload)}::jsonb, ${`${DAY}T10:30:00Z`}::timestamptz)`);
}

const keysOf = async (runId: string) =>
  ((await db.execute(sql`SELECT direction, outcome_key, subject_id FROM run_outcomes WHERE run_id = ${runId}::uuid `)) as any[]).map(
    (r) => `${r.direction}:${r.outcome_key}:${r.subject_id}`,
  ).sort();

const relabel = (body: unknown, apply: boolean) =>
  request(app).post(`/internal/outcome-occurrences/relabel${apply ? "" : "/preview"}`).set(getInternalAuthHeaders()).send(body);

const BASE = { fromKey: "post_published", toKey: "threads_post_published", subjectService: "meta-service", reason: "post_published retired", relabeledBy: "DELETE-POST-PUBLISHED-1107" };

describe("OUTCOME-RELABEL-1107: relabelling recorded occurrences to another outcome key", () => {
  beforeAll(async () => {
    await cleanTestData([ORG]);
    await db.execute(sql`DELETE FROM cost_ledger_days`);
    await db.execute(sql`DELETE FROM outcome_coverage_days`);
    await db.execute(sql`DELETE FROM cost_ledger_computed_days`);
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockImplementation(async (keys: string[]) => keys.filter((k) => !CATALOGUE.has(k)));
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("dry run moves nothing; apply moves exactly the stated subjects, keeps the bronze history, and every stored day recomputes to the new key", async () => {
    const a = await runWithCost();
    const b = await runWithCost();
    await recordCoarse(a.id, [{ direction: "produced", subjectId: "t-1" }, { direction: "produced", subjectId: "t-2" }]);
    await recordCoarse(b.id, [{ direction: "produced", subjectId: "t-3" }]);
    // A consumer of t-1's post (a visit run) still under the coarse key: moves with it.
    const visit = await runWithCost();
    await recordCoarse(visit.id, [{ direction: "consumed", subjectId: "t-1" }]);
    await request(app)
      .post(`/v1/runs/${visit.id}/outcomes`)
      .set(getAuthHeaders({ orgId: ORG }))
      .send({ produced: [post("website_visit", "v-1", "lead-service")] })
      .expect(201);

    const d0 = await computeLedgerDay(DAY, VERSIONS as any);
    await storeLedgerDay(d0);
    expect(await daysToCompute()).not.toContain(DAY);
    const totals0 = await request(app).get(`/internal/stats/outcome-costs?since=${DAY}&until=${DAY}&costOrgId=${ORG}&groupBy=outcomeKey`).set(getInternalAuthHeaders());
    expect(totals0.body.produced.find((g: any) => g.dimensions.outcomeKey === "post_published").cost.grossCents).toBe("200.0000000000");

    // Dry run: t-1 and t-3 (t-2 stays), both directions; nothing written.
    const subjects = ["t-1", "t-3", "t-9"];
    const preview = await relabel({ ...BASE, subjectIds: subjects }, false);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      status: "preview",
      movedCount: 3,
      runCount: 3,
      subjectsWithoutFromKey: ["t-9"],
      collisions: [],
      affectedFromDay: DAY,
    });
    expect(preview.body.counts.before.post_published).toEqual({ produced: 3, consumed: 1 });
    expect(preview.body.counts.after).toEqual({ post_published: { produced: 1, consumed: 0 }, threads_post_published: { produced: 2, consumed: 1 } });
    expect(await keysOf(a.id)).toEqual(["produced:post_published:t-1", "produced:post_published:t-2"]);
    const evs0 = (await db.execute(sql`SELECT count(*)::int AS n FROM outcome_declaration_events WHERE event_type = 'outcomes.relabeled'`)) as any[];
    expect(evs0[0].n).toBe(0);

    // Apply.
    const ids0 = ((await db.execute(sql`SELECT id FROM run_outcomes WHERE run_id = ${a.id}::uuid AND subject_id = 't-1'`)) as any[])[0].id;
    const applied = await relabel({ ...BASE, subjectIds: subjects }, true);
    expect(applied.status).toBe(201);
    expect(applied.body).toMatchObject({ status: "relabeled", movedCount: 3 });
    expect(applied.body.counts.after).toEqual(preview.body.counts.after);
    expect(await keysOf(a.id)).toEqual(["produced:post_published:t-2", "produced:threads_post_published:t-1"]);
    expect(await keysOf(visit.id)).toEqual(["consumed:threads_post_published:t-1", "produced:website_visit:v-1"]);
    // Same occurrence (same id), never a delete + insert.
    expect(((await db.execute(sql`SELECT id FROM run_outcomes WHERE run_id = ${a.id}::uuid AND subject_id = 't-1'`)) as any[])[0].id).toBe(ids0);

    // History: the declaration AND the relabel, with the previous key on each item.
    const events = (await db.execute(sql`SELECT event_type, payload FROM outcome_declaration_events WHERE run_id = ${a.id}::uuid ORDER BY occurred_at`)) as any[];
    expect(events.map((e) => e.event_type)).toEqual(["outcomes.declared", "outcomes.relabeled"]);
    expect(events[1].payload).toMatchObject({ fromKey: "post_published", toKey: "threads_post_published", affectedFromDay: DAY, reason: BASE.reason, relabeledBy: BASE.relabeledBy });
    expect(events[1].payload.items).toEqual([expect.objectContaining({ id: ids0, outcome_key: "threads_post_published", previous_outcome_key: "post_published" })]);

    // The consumption still resolves to its producer under the new key.
    const occ = await request(app).get(`/internal/outcome-occurrences?runIds=${visit.id}&limit=1000`).set(getInternalAuthHeaders());
    const consumed = occ.body.occurrences.find((o: any) => o.direction === "consumed");
    expect(consumed.outcomeKey).toBe("threads_post_published");
    expect(consumed.consumption.sourceRunId).toBe(a.id);

    // Derived figures: the stored day is stale, recomputes, and balances on the new keys.
    expect(await daysToCompute()).toContain(DAY);
    const d1 = await computeLedgerDay(DAY, VERSIONS as any);
    await storeLedgerDay(d1);
    expect(await daysToCompute()).not.toContain(DAY);
    const before = d0.orgs.find((o) => o.organizationId === ORG)!;
    const after = d1.orgs.find((o) => o.organizationId === ORG)!;
    expect(after.allocated).toEqual(before.allocated);
    expect(checkLedgerRow(ledgerCheckInputOf(after)).balanced).toBe(true);
    const totals = await request(app).get(`/internal/stats/outcome-costs?since=${DAY}&until=${DAY}&costOrgId=${ORG}&groupBy=outcomeKey`).set(getInternalAuthHeaders());
    expect(totals.status).toBe(200);
    expect(totals.body.complete).toBe(true);
    const byKey = Object.fromEntries(totals.body.produced.map((g: any) => [g.dimensions.outcomeKey, g.cost.grossCents]));
    // Run a: $1 over t-1 (moved) and t-2 (kept) = 50 / 50; run b: $1 on t-3 (moved).
    expect(byKey).toEqual({ post_published: "50.0000000000", threads_post_published: "150.0000000000", website_visit: "100.0000000000" });
    const consumedKeys = totals.body.consumed.map((g: any) => g.dimensions.outcomeKey);
    expect(consumedKeys).not.toContain("post_published");

    // Replay: nothing left, nothing written.
    const replay = await relabel({ ...BASE, subjectIds: subjects }, true);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: "nothing_to_relabel", movedCount: 0, relabeledAt: null, subjectsWithoutFromKey: subjects });
  });

  it("refuses a move that would collide with an occurrence already holding the target key, naming it, and writes nothing", async () => {
    const r = await runWithCost();
    await recordCoarse(r.id, [{ direction: "produced", subjectId: "c-1" }, { direction: "produced", subjectId: "c-2" }]);
    const fine = await request(app).post(`/v1/runs/${r.id}/outcomes`).set(getAuthHeaders({ orgId: ORG })).send({ produced: [post("threads_post_published", "c-1")] });
    expect(fine.status).toBe(201);
    const fineId = ((await db.execute(sql`SELECT id FROM run_outcomes WHERE run_id = ${r.id}::uuid AND outcome_key = 'threads_post_published'`)) as any[])[0].id;

    const preview = await relabel({ ...BASE, subjectIds: ["c-1", "c-2"] }, false);
    expect(preview.status).toBe(200);
    expect(preview.body.collisions).toEqual([expect.objectContaining({ runId: r.id, direction: "produced", subjectId: "c-1", collidingOccurrenceId: fineId })]);

    const refused = await relabel({ ...BASE, subjectIds: ["c-1", "c-2"] }, true);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("relabel_collision");
    expect(refused.body.details.collisions).toHaveLength(1);
    expect(await keysOf(r.id)).toEqual(["produced:post_published:c-1", "produced:post_published:c-2", "produced:threads_post_published:c-1"]);
    const evs = (await db.execute(sql`SELECT count(*)::int AS n FROM outcome_declaration_events WHERE run_id = ${r.id}::uuid AND event_type = 'outcomes.relabeled'`)) as any[];
    expect(evs[0].n).toBe(0);

    // Narrowed to the subject that does not collide, it moves.
    const ok = await relabel({ ...BASE, subjectIds: ["c-2"] }, true);
    expect(ok.status).toBe(201);
    expect(await keysOf(r.id)).toEqual(["produced:post_published:c-1", "produced:threads_post_published:c-1", "produced:threads_post_published:c-2"]);
  });

  it("validates the target against the catalogue and the body", async () => {
    const unknown = await relabel({ ...BASE, toKey: "post_published_v2", subjectIds: ["x"] }, false);
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("unknown_outcome_key");
    expect((await relabel({ ...BASE, toKey: "post_published", subjectIds: ["x"] }, true)).status).toBe(400);
    expect((await relabel({ ...BASE, subjectIds: [] }, true)).status).toBe(400);
    expect((await request(app).post(`/internal/outcome-occurrences/relabel`).send({ ...BASE, subjectIds: ["x"] })).status).toBe(401);
  });
});
