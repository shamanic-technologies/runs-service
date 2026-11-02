import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "../../src/db/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { createTestApp } from "../helpers/test-app.js";
import { MemoryArchiveStore } from "../../src/services/archive-store.js";
import {
  archiveTable,
  encodeRows,
  sha256,
  tableSpec,
  type ArchivedRow,
} from "../../src/services/lifecycle-archive.js";
import { restoreLifecycleArchive } from "../../src/services/lifecycle-archive-restore.js";

// BOX-DISK-1101. Rows dated 2001 so the walk (min(occurred_at) -> boundary) only
// ever sees this file's rows: every other test writes recent events.
const ORG_ID = "6b1f2e7a-4c3d-4e8f-9a0b-1c2d3e4f5a6b";
const BOUNDARY = new Date("2001-02-01T00:00:00Z");
const RLE = tableSpec("run_lifecycle_events");
const CLE = tableSpec("cost_lifecycle_events");

async function wipe() {
  await sql`DELETE FROM run_lifecycle_events WHERE occurred_at < '2001-12-31'`;
  await sql`DELETE FROM cost_lifecycle_events WHERE occurred_at < '2001-12-31'`;
  await sql`DELETE FROM lifecycle_archive_objects WHERE day < '2001-12-31'`;
  await sql`DELETE FROM lifecycle_archived_run_origins WHERE occurred_at < '2001-12-31'`;
  await sql`DROP TABLE IF EXISTS run_lifecycle_events_restored`;
  await sql`DROP TABLE IF EXISTS cost_lifecycle_events_restored`;
  await cleanTestData([ORG_ID]);
}

/** Every column as Postgres text, ordered by id: what "byte-equal" means here. */
async function snapshot(table: string, ids: string[]): Promise<ArchivedRow[]> {
  const cols = tableSpec(table.replace(/_restored$/, "")).columns.map((c) => `${c.name}::text AS ${c.name}`).join(", ");
  return sql.unsafe(`SELECT ${cols} FROM ${table} WHERE id = ANY($1::uuid[]) ORDER BY id`, [`{${ids.join(",")}}`]) as any;
}

async function seedRunEvents(): Promise<{ ids: string[]; runId: string }> {
  const runId = randomUUID();
  const rows = [
    // run.created projects a silver run (trigger): run_origin_org must survive the archive.
    { type: "run.created", payload: { organizationId: ORG_ID, serviceName: "archive-test", taskName: "t" }, at: "2001-01-10 08:00:00.123456+00", identity: null },
    { type: "run.completed", payload: { note: "é ü \"quoted\" \\ back\nslash" }, at: "2001-01-10 23:59:59.999999+00", identity: { orgId: ORG_ID } },
    { type: "archive.test", payload: { n: 1 }, at: "2001-01-10 12:00:00.000001+00", identity: null },
    { type: "archive.test", payload: { n: 2 }, at: "2001-01-10 12:00:00+00", identity: null },
    { type: "archive.test", payload: { n: 3 }, at: "2001-01-11 00:00:00+00", identity: null },
  ];
  const ids: string[] = [];
  for (const r of rows) {
    const [row] = await sql`
      INSERT INTO run_lifecycle_events (run_id, event_type, payload, source_service, identity, idempotency_key, correlation_id, occurred_at)
      VALUES (${runId}::uuid, ${r.type}, ${JSON.stringify(r.payload)}::jsonb, 'archive-test',
              ${r.identity ? JSON.stringify(r.identity) : null}::jsonb, ${r.type === "run.created" ? "idem-1" : null}, 'corr', ${r.at}::timestamptz)
      RETURNING id::text`;
    ids.push(row.id);
  }
  return { ids, runId };
}

async function seedCostEvents(runId: string): Promise<string[]> {
  const ids: string[] = [];
  // Unknown event types / NULL cost_id: the projection trigger is a no-op, only bronze is under test.
  for (const [costId, at] of [
    [null, "2001-01-20 10:00:00.5+00"],
    [randomUUID(), "2001-01-20 10:00:01+00"],
  ] as const) {
    const [row] = await sql`
      INSERT INTO cost_lifecycle_events (cost_id, run_id, event_type, payload, occurred_at)
      VALUES (${costId}::uuid, ${runId}::uuid, 'archive.test', ${JSON.stringify({ total: "1.2500000000" })}::jsonb, ${at}::timestamptz)
      RETURNING id::text`;
    ids.push(row.id);
  }
  return ids;
}

describe("lifecycle archive (BOX-DISK-1101)", () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await closeDb();
  });

  it("archives per UTC day in id-ordered parts, verifies, deletes, then restores byte-equal", async () => {
    const { ids, runId } = await seedRunEvents();
    const costIds = await seedCostEvents(runId);
    // A recent event of the same run stays: it is newer than the boundary.
    await sql`INSERT INTO run_lifecycle_events (run_id, event_type, payload, occurred_at) VALUES (${runId}::uuid, 'archive.test', '{}'::jsonb, '2001-03-01')`;
    const before = await snapshot("run_lifecycle_events", ids);
    const costBefore = await snapshot("cost_lifecycle_events", costIds);
    expect(before).toHaveLength(5);
    const [origin] = await sql`SELECT run_origin_org(${runId}::uuid)::text AS org`;
    expect(origin.org).toBe(ORG_ID);

    const store = new MemoryArchiveStore();
    const r = await archiveTable(store, RLE, { boundary: BOUNDARY, partMaxRows: 3, deletePauseMs: 0 });
    const c = await archiveTable(store, CLE, { boundary: BOUNDARY, partMaxRows: 3, deletePauseMs: 0 });

    // 2001-01-10 holds 4 rows -> two parts (3 + 1); 2001-01-11 one; costs one.
    expect([...store.objects.keys()].sort()).toEqual([
      "runs-archive/cost_lifecycle_events/2001/01/20.ndjson.gz",
      "runs-archive/run_lifecycle_events/2001/01/10-part1.ndjson.gz",
      "runs-archive/run_lifecycle_events/2001/01/10.ndjson.gz",
      "runs-archive/run_lifecycle_events/2001/01/11.ndjson.gz",
    ]);
    expect(r).toMatchObject({ objects: 3, rows: 5, deleted: 5 });
    expect(c).toMatchObject({ objects: 1, rows: 2, deleted: 2 });
    const part0 = store.objects.get("runs-archive/run_lifecycle_events/2001/01/10.ndjson.gz")!;
    expect(part0.metadata.rows).toBe("3");
    expect(part0.metadata.sha256).toBe(sha256(part0.body));

    // Gone from Postgres; the newer event and silver are untouched.
    expect(await snapshot("run_lifecycle_events", ids)).toHaveLength(0);
    expect(await snapshot("cost_lifecycle_events", costIds)).toHaveLength(0);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM run_lifecycle_events WHERE run_id = ${runId}::uuid`;
    expect(n).toBe(1);
    const [silver] = await sql`SELECT status FROM runs WHERE id = ${runId}::uuid`;
    expect(silver.status).toBe("completed");
    // run_origin_org still answers from the archived origin.
    const [after] = await sql`SELECT run_origin_org(${runId}::uuid)::text AS org`;
    expect(after.org).toBe(ORG_ID);

    // Size is served as a SUM over the objects table.
    const objs = await sql`SELECT rows, bytes, deleted_at FROM lifecycle_archive_objects WHERE day < '2001-12-31'`;
    expect(objs.every((o: any) => o.deleted_at !== null)).toBe(true);
    const app = createTestApp();
    const stats = await request(app).get("/internal/lifecycle-archive/stats").set("x-api-key", "test-api-key");
    expect(stats.status).toBe(200);
    const bytes = [...store.objects.values()].reduce((s, o) => s + o.body.length, 0);
    expect(stats.body).toEqual({ objects: 4, rows: 7, bytes });
    expect((await request(app).get("/internal/lifecycle-archive/stats")).status).toBe(401);

    // A second tick finds nothing older than the boundary.
    expect(await archiveTable(store, RLE, { boundary: BOUNDARY, deletePauseMs: 0 })).toMatchObject({ objects: 0, deleted: 0 });

    // Restore: refuses the live table by default, then lands byte-equal in the staging copy.
    await expect(
      restoreLifecycleArchive(store, "run_lifecycle_events", { keyOrPrefix: "runs-archive/run_lifecycle_events/2001/", target: "run_lifecycle_events" }),
    ).rejects.toThrow(/allowLive/);
    const restored = await restoreLifecycleArchive(store, "run_lifecycle_events", { keyOrPrefix: "runs-archive/run_lifecycle_events/2001/" });
    expect(restored).toMatchObject({ target: "run_lifecycle_events_restored", objects: 3, rows: 5, inserted: 5 });
    expect(await snapshot("run_lifecycle_events_restored", ids)).toEqual(before);
    const again = await restoreLifecycleArchive(store, "run_lifecycle_events", { keyOrPrefix: "runs-archive/run_lifecycle_events/2001/" });
    expect(again.inserted).toBe(0);
    await restoreLifecycleArchive(store, "cost_lifecycle_events", { keyOrPrefix: "runs-archive/cost_lifecycle_events/2001/01/20.ndjson.gz" });
    expect(await snapshot("cost_lifecycle_events_restored", costIds)).toEqual(costBefore);
    // No trigger on the staging copy: silver kept its state.
    const [silver2] = await sql`SELECT status FROM runs WHERE id = ${runId}::uuid`;
    expect(silver2.status).toBe("completed");
  });

  it("never deletes a chunk whose read-back fails", async () => {
    const { ids } = await seedRunEvents();
    const store = new MemoryArchiveStore();
    const corrupt = Object.assign(Object.create(store), {
      put: store.put.bind(store),
      list: store.list.bind(store),
      get: async (key: string) => {
        const o = await store.get(key);
        return { ...o, body: Buffer.concat([o.body, Buffer.from("x")]) };
      },
    });
    await expect(archiveTable(corrupt, RLE, { boundary: BOUNDARY, deletePauseMs: 0 })).rejects.toThrow(/sha256/);
    expect(await snapshot("run_lifecycle_events", ids)).toHaveLength(5);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM lifecycle_archive_objects WHERE day < '2001-12-31'`;
    expect(n).toBe(0);
  });

  it("finishes a delete a deploy interrupted, from the object in R2", async () => {
    const { ids } = await seedRunEvents();
    const store = new MemoryArchiveStore();
    // State a kill leaves: object uploaded + recorded, rows still in bronze.
    const rows = await sql.unsafe(
      `SELECT ${RLE.columns.map((c) => `${c.name}::text AS ${c.name}`).join(", ")} FROM run_lifecycle_events
        WHERE occurred_at >= '2001-01-10' AND occurred_at < '2001-01-11' ORDER BY id LIMIT 3`,
    ) as unknown as ArchivedRow[];
    const plain = rows.map((r) => Object.fromEntries(RLE.columns.map((c) => [c.name, r[c.name]])));
    const body = await encodeRows(plain);
    const key = "runs-archive/run_lifecycle_events/2001/01/10.ndjson.gz";
    await store.put(key, body, { rows: "3", sha256: sha256(body) });
    await sql`INSERT INTO lifecycle_archive_objects (source_table, object_key, day, part, rows, bytes, sha256)
              VALUES ('run_lifecycle_events', ${key}, '2001-01-10', 0, 3, ${body.length}, ${sha256(body)})`;

    const r = await archiveTable(store, RLE, { boundary: BOUNDARY, partMaxRows: 3, deletePauseMs: 0 });
    // The 3 pending rows deleted from the object's ids; the rest archived as part1 + 2001-01-11.
    expect(r).toMatchObject({ objects: 2, rows: 2, deleted: 5 });
    expect(store.objects.has("runs-archive/run_lifecycle_events/2001/01/10-part1.ndjson.gz")).toBe(true);
    expect(await snapshot("run_lifecycle_events", ids)).toHaveLength(0);
    const pending = await sql`SELECT count(*)::int AS n FROM lifecycle_archive_objects WHERE day < '2001-12-31' AND deleted_at IS NULL`;
    expect(pending[0].n).toBe(0);
  });
});
