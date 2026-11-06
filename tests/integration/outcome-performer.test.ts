import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { createTestApp, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";

// OUTCOME-PERFORMER-1106: every produced occurrence may name WHO performed it
// (our script X, the client's team, their CRM, the website tracker, a mailbox,
// the organic market); stored once, served per occurrence and groupable in stats.

const ORG = "0c05acc0-1106-4c0a-8b1e-0000000000c1";

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
const CATALOGUE = new Set(["meeting_booked", "form_submitted", "message_sent", "lead_found", "website_visit"]);

const app = createTestApp();
const lead = (outcomeKey: string, subjectId: string, performer?: unknown) => ({
  outcomeKey,
  subjectService: "lead-service",
  subjectId,
  ...(performer !== undefined && { performer }),
});
const declare = (runId: string, body: unknown, serviceName = "lead-service") =>
  request(app).post(`/v1/platform-runs/${runId}/outcomes`).set(getPlatformAuthHeaders({ serviceName })).send(body);
const batch = (body: unknown, serviceName = "lead-service") =>
  request(app).post("/v1/platform-runs/outcomes/batch").set(getPlatformAuthHeaders({ serviceName })).send(body);
const stored = async (runId: string) =>
  (await db.execute(sql`
    SELECT outcome_key, subject_id, performer_kind, performer_workflow_slug, performer_name
    FROM run_outcomes WHERE run_id = ${runId}::uuid ORDER BY outcome_key, subject_id
  `)) as any[];
const occurrences = async (query: string) => {
  const res = await request(app).get(`/internal/outcome-occurrences?${query}`).set(getInternalAuthHeaders());
  expect(res.status).toBe(200);
  return res.body.occurrences as any[];
};
const recording = () => insertTestRun({ organizationId: ORG, serviceName: "lead-service", taskName: "outcome-recording", status: "completed" });

describe("OUTCOME-PERFORMER-1106: who performed each outcome occurrence", () => {
  beforeAll(async () => {
    await cleanTestData([ORG]);
    catalog.fn.mockResolvedValue([]);
    stepCatalogue.fn.mockImplementation(async (keys: string[]) => keys.filter((k) => !CATALOGUE.has(k)));
  });

  afterAll(async () => {
    await cleanTestData([ORG]);
    await closeDb();
  });

  it("a declaration stating a performer stores it; a replay is already_recorded", async () => {
    const run = await recording();
    const body = { produced: [lead("form_submitted", "L1", { kind: "crm", name: "gohighlevel" })] };
    const res = await declare(run.id, body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ recordedCount: 1, alreadyRecordedCount: 0, performerStatedCount: 0 });
    expect(res.body.occurrences[0]).toMatchObject({ status: "recorded", performer: { kind: "crm", name: "gohighlevel" } });
    expect(await stored(run.id)).toEqual([
      { outcome_key: "form_submitted", subject_id: "L1", performer_kind: "crm", performer_workflow_slug: null, performer_name: "gohighlevel" },
    ]);

    const replay = await declare(run.id, body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ recordedCount: 0, alreadyRecordedCount: 1, performerStatedCount: 0 });
    expect(replay.body.occurrences[0]).toMatchObject({ status: "already_recorded", performer: { kind: "crm", name: "gohighlevel" } });
    // Stating less (no name) is the same performer.
    const less = await declare(run.id, { produced: [lead("form_submitted", "L1", { kind: "crm" })] });
    expect(less.status).toBe(200);
    expect(less.body.occurrences[0].status).toBe("already_recorded");
  });

  it("absent = unchanged: no performer key, no performerStatedCount, nothing stored", async () => {
    const run = await recording();
    const res = await declare(run.id, { produced: [lead("website_visit", "L2")] });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(["allocationVersion", "alreadyRecordedCount", "occurrences", "recordedCount", "runId"]);
    expect(Object.keys(res.body.occurrences[0]).sort()).toEqual(
      ["declaredAt", "direction", "id", "outcomeKey", "quantity", "recordedAt", "status", "subjectId", "subjectService"],
    );
    expect((await stored(run.id))[0].performer_kind).toBeNull();
    const b = await batch({ runs: [{ runId: run.id, produced: [lead("website_visit", "L2")] }] });
    expect(b.status).toBe(200);
    expect(Object.keys(b.body).sort()).toEqual(["allocationVersion", "alreadyRecordedCount", "recordedCount", "redatedCount", "runs"]);
  });

  it("the batch door states a performer ONCE on an occurrence recorded without one; never overwrites a different one", async () => {
    const run = await recording();
    const at = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect((await batch({ runs: [{ runId: run.id, occurredAt: at, produced: [lead("meeting_booked", "L3")] }] })).status).toBe(201);

    const script = { kind: "script", workflowSlug: "ai-meeting-booking-v3" };
    const res = await batch({ runs: [{ runId: run.id, occurredAt: at, redate: true, produced: [lead("meeting_booked", "L3", script)] }] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ recordedCount: 0, redatedCount: 0, performerStatedCount: 1, alreadyRecordedCount: 0 });
    expect(res.body.runs[0].occurrences[0]).toMatchObject({ status: "performer_stated", performer: script });
    expect((await stored(run.id))[0]).toMatchObject({ performer_kind: "script", performer_workflow_slug: "ai-meeting-booking-v3" });

    const replay = await batch({ runs: [{ runId: run.id, produced: [lead("meeting_booked", "L3", script)] }] });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ performerStatedCount: 0, alreadyRecordedCount: 1 });

    const other = await batch({ runs: [{ runId: run.id, produced: [lead("meeting_booked", "L3", { kind: "client_team" })] }] });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("performer_conflict");
    expect(other.body.conflicts[0]).toMatchObject({ runId: run.id, storedPerformer: script, statedPerformer: { kind: "client_team" } });
    const otherScript = await declare(run.id, { produced: [lead("meeting_booked", "L3", { kind: "script", workflowSlug: "other" })] });
    expect(otherScript.status).toBe(409);
    expect((await stored(run.id))[0]).toMatchObject({ performer_kind: "script", performer_workflow_slug: "ai-meeting-booking-v3" });
    // Bronze keeps the statement.
    const [ev] = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM outcome_declaration_events WHERE run_id = ${run.id}::uuid AND event_type = 'outcomes.performer_stated'
    `)) as any[];
    expect(ev.n).toBe(1);
  });

  it("only the run's owner or a service that declared on it states a performer on recorded occurrences", async () => {
    const run = await recording();
    expect((await declare(run.id, { produced: [lead("meeting_booked", "L4")] })).status).toBe(201);
    const res = await batch({ runs: [{ runId: run.id, produced: [lead("meeting_booked", "L4", { kind: "organic" })] }] }, "crm-service");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "not_run_declarer", details: { runIds: [run.id] } });
    expect((await stored(run.id))[0].performer_kind).toBeNull();
  });

  it("vocabulary: unknown kind, script without workflowSlug, workflowSlug on another kind, unknown key = 400", async () => {
    const run = await recording();
    for (const performer of [{ kind: "agency" }, { kind: "script" }, { kind: "crm", workflowSlug: "x" }, { kind: "crm", extra: 1 }, { kind: "crm", name: "" }]) {
      const res = await declare(run.id, { produced: [lead("meeting_booked", "L5", performer)] });
      expect(res.status, JSON.stringify(performer)).toBe(400);
    }
    expect(await stored(run.id)).toEqual([]);
  });

  it("served per occurrence (stated > the run's script > unknown) and groupable by performer and script", async () => {
    const scriptRun = await insertTestRun({
      organizationId: ORG, serviceName: "instantly-service", taskName: "send", status: "completed",
      workflowSlug: "ai-meeting-booking-v3", brandIds: ["brand-a"], campaignId: "camp-1",
    });
    expect((await declare(scriptRun.id, { produced: [lead("message_sent", "L6")] }, "instantly-service")).status).toBe(201);
    const tracker = await insertTestRun({ organizationId: ORG, serviceName: "instantly-service", taskName: "website-visit", status: "completed", brandIds: ["brand-a"] });
    expect((await declare(tracker.id, { produced: [lead("website_visit", "L6", { kind: "tracker" }), lead("website_visit", "L7")] }, "instantly-service")).status).toBe(201);

    const sent = (await occurrences(`runIds=${scriptRun.id}`))[0];
    expect(sent.performer).toEqual({ kind: "script", workflowSlug: "ai-meeting-booking-v3", name: null, basis: "run_workflow" });
    const visits = await occurrences(`runIds=${tracker.id}`);
    expect(visits.find((o) => o.subjectId === "L6").performer).toEqual({ kind: "tracker", workflowSlug: null, name: null, basis: "stated" });
    expect(visits.find((o) => o.subjectId === "L7").performer).toBeNull();
    expect((await occurrences(`orgId=${ORG}&performerKind=tracker`)).map((o) => o.subjectId)).toEqual(["L6"]);
    expect((await occurrences(`orgId=${ORG}&performerKind=none`)).every((o) => o.performer === null)).toBe(true);
    const bad = await request(app).get(`/internal/outcome-occurrences?orgId=${ORG}&performerKind=agency`).set(getInternalAuthHeaders());
    expect(bad.status).toBe(400);

    // The script's whole output: the send its run declared AND the meeting lead-service stated it performed.
    const stats = await request(app)
      .get(`/internal/stats/outcome-performers?orgId=${ORG}&groupBy=workflowSlug,outcomeKey,performerBasis`)
      .set(getInternalAuthHeaders());
    expect(stats.status).toBe(200);
    const script = stats.body.groups.filter((g: any) => g.workflowSlug === "ai-meeting-booking-v3");
    expect(script).toEqual([
      { workflowSlug: "ai-meeting-booking-v3", outcomeKey: "meeting_booked", performerBasis: "stated", count: 1, quantity: "1.000000" },
      { workflowSlug: "ai-meeting-booking-v3", outcomeKey: "message_sent", performerBasis: "run_workflow", count: 1, quantity: "1.000000" },
    ]);
    const byKind = await request(app)
      .get(`/internal/stats/outcome-performers?orgId=${ORG}&groupBy=performerKind`)
      .set(getInternalAuthHeaders());
    expect(byKind.status).toBe(200);
    const count = (k: string | null) => byKind.body.groups.find((g: any) => g.performerKind === k)?.count ?? 0;
    expect(count("crm")).toBe(1);
    expect(count("script")).toBe(2);
    expect(count("tracker")).toBe(1);
    expect(byKind.body.groups.reduce((n: number, g: any) => n + g.count, 0)).toBe(byKind.body.totals.count);

    const brand = await request(app)
      .get(`/internal/stats/outcome-performers?orgId=${ORG}&groupBy=brandId,performerKind&outcomeKey=website_visit`)
      .set(getInternalAuthHeaders());
    expect(brand.body.groups).toEqual([
      { brandId: "brand-a", performerKind: "tracker", count: 1, quantity: "1.000000" },
      { brandId: "brand-a", performerKind: null, count: 1, quantity: "1.000000" },
      { brandId: null, performerKind: null, count: 1, quantity: "1.000000" },
    ]);
    const filtered = await request(app)
      .get(`/internal/stats/outcome-performers?orgId=${ORG}&workflowSlug=ai-meeting-booking-v3&groupBy=outcomeKey`)
      .set(getInternalAuthHeaders());
    expect(filtered.body.totals.count).toBe(2);

    for (const q of ["groupBy=nope", "groupBy=day,day", "performerKind=agency", "since=2026-13-01"]) {
      const r = await request(app).get(`/internal/stats/outcome-performers?${q}`).set(getInternalAuthHeaders());
      expect(r.status, q).toBe(400);
    }
  });
});
