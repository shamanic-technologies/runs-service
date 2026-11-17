import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { buildOutcomeChains } from "../../src/services/outcome-chains.js";

// UNIT-LINK-BRONZE-1117: the ledger STORES which Unit a Unit came from (both ids, both dates) and the
// campaign(s) a Unit carries, so a consumer reads the delay between two outcomes and a late outcome's
// campaign instead of matching Units by subject. Keys are this file's own (catalogue mocked): no outcome
// is named in the code under test.

const ORG = "0c11e117-1117-4c0a-8b1e-000000000001";
const B1 = "brand-ul-1117-a";
const C1 = "0c11e117-1117-4c0a-8b1e-0000000000c1";
const C2 = "0c11e117-1117-4c0a-8b1e-0000000000c2";
const FOUND = "ul1117_found";
const SENT = "ul1117_sent";
const REPLY = "ul1117_reply";
const BOOKED = "ul1117_booked";
const CLICK = "ul1117_click";

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
const lead = (id: string) => ({ subjectService: "lead-service", subjectId: `ul1117-${id}` });
const SUB = { subjectService: "transactional-email-service", subjectId: "ul1117-sub-3" };

async function get(path: string) {
  const res = await request(app).get(path).set(H);
  expect(res.status).toBe(200);
  return res.body;
}

/** Every stored link of this file, read through the feed in small pages (other files of the shard hold links too). */
async function allLinks(from?: string): Promise<{ links: any[]; cursor: string }> {
  let cursor = from;
  const links: any[] = [];
  for (let i = 0; i < 5000; i++) {
    const page = await get(`/internal/stats/outcome-chains/unit-links?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
    links.push(...page.links.filter((l: any) => l.fromUnit.outcomeKey.startsWith("ul1117_")));
    cursor = page.nextCursor;
    if (page.caughtUp) return { links, cursor: cursor as string };
  }
  throw new Error("the unit-links feed never caught up");
}

const edge = (l: any) => `${l.fromUnit.outcomeKey}>${l.toUnit.outcomeKey}:${l.subjectId}`;

describe("UNIT-LINK-BRONZE-1117: stored links between Units + the campaign(s) a Unit carries", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await cleanTestData([ORG]);
    await db.execute(sql`DELETE FROM unit_links WHERE from_outcome LIKE 'ul1117_%'`);
    stepCatalogue.fn.mockResolvedValue([]);

    const run = async (name: string, serviceName: string, taskName: string, startedAt: string, extra: { campaignId?: string; brandIds?: string[] } = {}) => {
      const r = await insertTestRun({ organizationId: ORG, serviceName, taskName, status: "completed", startedAt: at(startedAt), ...extra });
      ids[name] = r.id;
    };
    // Two sends, each for its own campaign.
    await run("send1", "instantly-service", "send", "2026-11-01T10:00:00Z", { campaignId: C1, brandIds: [B1] });
    await run("send2", "instantly-service", "send", "2026-11-02T10:00:00Z", { campaignId: C2, brandIds: [B1] });
    await run("send3", "instantly-service", "send", "2026-11-02T11:00:00Z", { campaignId: C2 });
    // A judge of every reply of the org-day, and a recorder of late outcomes: neither names a campaign.
    await run("judge", "crm-service", "reply-judge", "2026-11-03T10:00:00Z", { brandIds: [B1] });
    await run("rec", "lead-service", "outcome-recording", "2026-11-05T10:00:00Z");
    await run("recAlone", "lead-service", "outcome-recording", "2026-11-05T11:00:00Z");
    // A subscriber's click, stated on the subscriber: the same person as lead 3.
    await run("click", "transactional-email-service", "click", "2026-11-04T10:00:00Z");
    // A chain no campaign ever touched.
    await run("find4", "apollo-service", "find", "2026-11-01T08:00:00Z");
    await run("send4", "instantly-service", "send", "2026-11-01T09:00:00Z");

    const eq = await request(app)
      .post("/v1/platform-runs/subject-equivalences")
      .set(getPlatformAuthHeaders({ serviceName: "transactional-email-service" }))
      .send({ items: [{ ...SUB, targetService: "lead-service", targetId: "ul1117-3" }], reason: "subscriber resolved to its lead", statedBy: "t" });
    expect(eq.status).toBeLessThan(300);

    expect((await declare("instantly-service", [
      { runId: ids.send1, occurredAt: "2026-11-01T10:00:00.000Z", produced: [{ outcomeKey: SENT, ...lead("1") }] },
      { runId: ids.send2, occurredAt: "2026-11-02T10:00:00.000Z", produced: [{ outcomeKey: SENT, ...lead("2") }] },
      { runId: ids.send3, occurredAt: "2026-11-02T11:00:00.000Z", produced: [{ outcomeKey: SENT, ...lead("3") }] },
    ])).status).toBe(201);
    expect((await declare("crm-service", [{
      runId: ids.judge,
      occurredAt: "2026-11-03T10:00:00.000Z",
      consumed: [{ outcomeKey: SENT, ...lead("1") }, { outcomeKey: SENT, ...lead("2") }],
      produced: [{ outcomeKey: REPLY, ...lead("1") }],
    }])).status).toBe(201);
    expect((await declare("lead-service", [
      { runId: ids.rec, occurredAt: "2026-11-05T10:00:00.000Z", consumed: [{ outcomeKey: REPLY, ...lead("1") }], produced: [{ outcomeKey: BOOKED, ...lead("1") }] },
      { runId: ids.recAlone, occurredAt: "2026-11-05T11:00:00.000Z", produced: [{ outcomeKey: BOOKED, ...lead("9") }] },
    ])).status).toBe(201);
    expect((await declare("transactional-email-service", [
      { runId: ids.click, occurredAt: "2026-11-04T10:00:00.000Z", consumed: [{ outcomeKey: SENT, ...SUB }], produced: [{ outcomeKey: CLICK, ...SUB }] },
    ])).status).toBe(201);
    expect((await declare("apollo-service", [{ runId: ids.find4, occurredAt: "2026-11-01T08:00:00.000Z", produced: [{ outcomeKey: FOUND, ...lead("4") }] }])).status).toBe(201);
    expect((await declare("instantly-service", [
      { runId: ids.send4, occurredAt: "2026-11-01T09:00:00.000Z", consumed: [{ outcomeKey: FOUND, ...lead("4") }], produced: [{ outcomeKey: SENT, ...lead("4") }] },
    ])).status).toBe(201);
  });

  afterAll(async () => {
    const mine = `{${Object.values(ids).join(",")}}`;
    await db.execute(sql`DELETE FROM outcome_declaration_events WHERE run_id = ANY(${mine}::uuid[])`);
    await db.execute(sql`DELETE FROM run_lifecycle_events WHERE run_id = ANY(${mine}::uuid[])`);
    await db.execute(sql`DELETE FROM unit_links WHERE from_outcome LIKE 'ul1117_%'`);
    await cleanTestData([ORG]);
    await closeDb();
  });

  let cursor = "";

  it("stores one link per edge with both Units' ids and dates; the delay is read, not rebuilt", async () => {
    const b = await buildOutcomeChains();
    expect(b).not.toBeNull();
    expect(b!.unitLinksWritten).toBeGreaterThanOrEqual(4);

    const read = await allLinks();
    cursor = read.cursor;
    expect(read.links.map(edge).sort()).toEqual([
      `${FOUND}>${SENT}:ul1117-4`,
      `${REPLY}>${BOOKED}:ul1117-1`,
      `${SENT}>${CLICK}:ul1117-3`,
      `${SENT}>${REPLY}:ul1117-1`,
    ]);

    const units = (await db.execute(sql`
      SELECT id, run_id, outcome_key, subject_id FROM run_outcomes
      WHERE direction = 'produced' AND run_id = ANY(${`{${Object.values(ids).join(",")}}`}::uuid[])`)) as any[];
    const unit = (key: string, subjectId: string) => units.find((u) => u.outcome_key === key && u.subject_id === subjectId).id;

    const reply = read.links.find((l) => edge(l) === `${SENT}>${REPLY}:ul1117-1`);
    expect(reply).toEqual({
      fromUnit: { id: unit(SENT, "ul1117-1"), outcomeKey: SENT, at: "2026-11-01T10:00:00.000Z", runId: ids.send1, brandIds: [B1], campaignId: C1, campaignIds: [C1] },
      // The judge names no campaign: its Unit carries the campaign of the send it came from.
      toUnit: { id: unit(REPLY, "ul1117-1"), outcomeKey: REPLY, at: "2026-11-03T10:00:00.000Z", runId: ids.judge, brandIds: [B1], campaignId: null, campaignIds: [C1] },
      subjectService: "lead-service",
      subjectId: "ul1117-1",
      delaySeconds: 2 * 86400,
      linkedAt: expect.any(String),
      removedAt: null,
    });

    // Two hops up through a campaign-less Unit: the booking carries the send's campaign.
    const booked = read.links.find((l) => edge(l) === `${REPLY}>${BOOKED}:ul1117-1`);
    expect(booked.fromUnit).toMatchObject({ campaignId: null, campaignIds: [C1] });
    expect(booked.toUnit).toMatchObject({ id: unit(BOOKED, "ul1117-1"), campaignId: null, campaignIds: [C1], brandIds: [] });
    expect(booked.delaySeconds).toBe(2 * 86400);

    // A stated subject equivalence is followed: the subscriber's click came from its lead's send.
    const click = read.links.find((l) => edge(l) === `${SENT}>${CLICK}:ul1117-3`);
    expect(click).toMatchObject({ subjectService: "lead-service", subjectId: "ul1117-3", delaySeconds: 47 * 3600 });
    expect(click.fromUnit).toMatchObject({ runId: ids.send3, campaignIds: [C2] });
    expect(click.toUnit).toMatchObject({ runId: ids.click, campaignId: null, campaignIds: [C2] });

    // Lead 2's send was consumed by the judge, which made nothing for lead 2: no link.
    expect(read.links.some((l) => l.subjectId === "ul1117-2")).toBe(false);
  });

  it("one transition at a time, and a quiet build writes nothing", async () => {
    const one = await get(`/internal/stats/outcome-chains/unit-links?fromOutcome=${REPLY}&toOutcome=${BOOKED}`);
    expect(one.links.map(edge)).toEqual([`${REPLY}>${BOOKED}:ul1117-1`]);
    expect(one.caughtUp).toBe(true);

    const b = await buildOutcomeChains();
    expect(b!.unitLinksWritten).toBe(0);
    expect(b!.unitLinksRemoved).toBe(0);
    const quiet = await allLinks(cursor);
    expect(quiet.links).toEqual([]);
    cursor = quiet.cursor;
  });

  it("a Unit carries its campaign(s), or a named reason", async () => {
    const sent = await get(`/internal/stats/outcome-chains/unit-campaigns?outcomeKey=${SENT}`);
    const bySubject = (body: any) => Object.fromEntries(body.units.map((u: any) => [u.subjectId, u]));
    expect(bySubject(sent)["ul1117-1"]).toMatchObject({ runId: ids.send1, campaignId: C1, campaignIds: [C1], campaignSource: "own_run", reason: null, sourceUnits: 0 });
    // Came from a Unit, and no Unit up its chain names a campaign.
    expect(bySubject(sent)["ul1117-4"]).toMatchObject({ campaignId: null, campaignIds: [], campaignSource: null, reason: "source_units_name_no_campaign", sourceUnits: 1 });

    const booked = bySubject(await get(`/internal/stats/outcome-chains/unit-campaigns?outcomeKey=${BOOKED}`));
    expect(booked["ul1117-1"]).toMatchObject({ runId: ids.rec, at: "2026-11-05T10:00:00.000Z", campaignId: null, campaignIds: [C1], campaignSource: "source_units", reason: null, sourceUnits: 1 });
    // Declared consuming nothing, on a run naming no campaign.
    expect(booked["ul1117-9"]).toMatchObject({ campaignId: null, campaignIds: [], campaignSource: null, reason: "no_source_unit", sourceUnits: 0 });

    // Paged by Unit id: two pages of one hold the same Units.
    const p1 = await get(`/internal/stats/outcome-chains/unit-campaigns?outcomeKey=${BOOKED}&limit=1`);
    expect(p1.units).toHaveLength(1);
    expect(p1.nextCursor).toBe(p1.units[0].unitId);
    const p2 = await get(`/internal/stats/outcome-chains/unit-campaigns?outcomeKey=${BOOKED}&limit=1&cursor=${p1.nextCursor}`);
    expect([...p1.units, ...p2.units].map((u: any) => u.subjectId).sort()).toEqual(["ul1117-1", "ul1117-9"]);
    expect(p2.nextCursor).toBeNull();
  });

  it("a Unit recorded after the last build says so, then carries its campaign", async () => {
    const r = await insertTestRun({ organizationId: ORG, serviceName: "lead-service", taskName: "outcome-recording", status: "completed", startedAt: at("2026-11-06T10:00:00Z") });
    ids.recLate = r.id;
    expect((await declare("lead-service", [
      { runId: r.id, occurredAt: "2026-11-06T10:00:00.000Z", consumed: [{ outcomeKey: SENT, ...lead("2") }], produced: [{ outcomeKey: BOOKED, ...lead("2") }] },
    ])).status).toBe(201);
    const find = async () => (await get(`/internal/stats/outcome-chains/unit-campaigns?outcomeKey=${BOOKED}`)).units.find((u: any) => u.subjectId === "ul1117-2");
    expect(await find()).toMatchObject({ campaignIds: [], reason: "not_in_build" });

    const b = await buildOutcomeChains();
    expect(b!.unitLinksWritten).toBe(1);
    expect(await find()).toMatchObject({ campaignIds: [C2], campaignSource: "source_units", reason: null, sourceUnits: 1 });
    const fresh = await allLinks(cursor);
    expect(fresh.links.map(edge)).toEqual([`${SENT}>${BOOKED}:ul1117-2`]);
    expect(fresh.links[0].delaySeconds).toBe(4 * 86400);
    cursor = fresh.cursor;
  });

  it("a reversed Unit's links are served once as removed, and stand nowhere after", async () => {
    const rev = await request(app)
      .post("/v1/platform-runs/outcomes/reversals")
      .set({ ...getPlatformAuthHeaders({ serviceName: "lead-service" }), "x-org-id": ORG })
      .send({ reversedBy: "test", reversals: [{ runId: ids.rec, outcomeKey: BOOKED, ...lead("1"), reason: "not a booking" }] });
    expect(rev.status).toBe(201);
    const b = await buildOutcomeChains();
    expect(b!.unitLinksRemoved).toBe(1);
    expect(b!.unitLinksWritten).toBe(0);

    const moved = await allLinks(cursor);
    expect(moved.links.map(edge)).toEqual([`${REPLY}>${BOOKED}:ul1117-1`]);
    expect(moved.links[0].removedAt).toEqual(expect.any(String));
    cursor = moved.cursor;

    const booked = await get(`/internal/stats/outcome-chains/unit-campaigns?outcomeKey=${BOOKED}`);
    expect(booked.units.map((u: any) => u.subjectId).sort()).toEqual(["ul1117-2", "ul1117-9"]);

    // The other reads of the same build are untouched by the links: the step still counts what stands.
    const steps = (await get("/internal/stats/outcome-chains/step-rates")).steps.filter((s: any) => s.fromOutcome.startsWith("ul1117_"));
    expect(steps.map((s: any) => `${s.fromOutcome}>${s.toOutcome}:${s.ledUnits}`).sort()).toEqual([
      `${FOUND}>${SENT}:1`,
      `${SENT}>${BOOKED}:1`,
      `${SENT}>${CLICK}:1`,
      `${SENT}>${REPLY}:1`,
    ]);
  });

  it("refuses bad cursors, limits and a missing outcome", async () => {
    for (const path of [
      "/internal/stats/outcome-chains/unit-links?cursor=nope",
      "/internal/stats/outcome-chains/unit-links?limit=0",
      "/internal/stats/outcome-chains/unit-links?limit=20001",
      "/internal/stats/outcome-chains/unit-links?fromOutcome=",
      "/internal/stats/outcome-chains/unit-campaigns",
      `/internal/stats/outcome-chains/unit-campaigns?outcomeKey=${BOOKED}&cursor=nope`,
      `/internal/stats/outcome-chains/unit-campaigns?outcomeKey=${BOOKED}&limit=5001`,
    ]) {
      const res = await request(app).get(path).set(H);
      expect([path, res.status]).toEqual([path, 400]);
    }
    expect((await request(app).get("/internal/stats/outcome-chains/unit-links")).status).toBe(401);
  });
});
