import { createHash } from "node:crypto";
import { gzip as gzipCb, gunzip as gunzipCb } from "node:zlib";
import { promisify } from "node:util";
import { sql as defaultSql } from "../db/index.js";
import {
  type ArchiveStore,
  R2ArchiveStore,
  R2NotConfiguredError,
  loadR2CredentialsFromKeyService,
} from "./archive-store.js";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

type Sql = typeof defaultSql;

/**
 * Lifecycle archive (BOX-DISK-1101, owner decision 2026-11-02).
 *
 * The bronze lifecycle logs (`run_lifecycle_events`, `cost_lifecycle_events`) are
 * append-only and were 15 GB together. Every event older than the archive
 * boundary moves to Cloudflare R2 as gzip NDJSON, is read back and verified, and
 * only THEN is deleted from Postgres. Nothing is lost: history lives in R2
 * (`runs-archive/<table>/<yyyy>/<mm>/<dd>[-partN].ndjson.gz`) and comes back with
 * scripts/restore-lifecycle-archive.ts.
 *
 * Boundary = UTC midnight of (first day of the current UTC month - 90 days): it
 * moves once a month, so the job archives one month of history per month; every
 * other tick finds nothing older than the boundary (one index probe) and returns.
 *
 * Per chunk (one UTC day, at most PART_MAX_ROWS rows, ordered by id):
 *   SELECT every column as Postgres text -> NDJSON -> gzip -> PUT (metadata rows +
 *   sha256) -> GET -> sha256 of the bytes read == sha256 written -> gunzip ->
 *   row count AND the ordered id list == the chunk's -> record the object ->
 *   DELETE exactly those ids (5,000 per statement, a pause between).
 * Any failure before the record leaves the rows in place (fail loud, retried next
 * tick). A deploy killing the job between the record and the end of the delete
 * leaves `deleted_at` NULL: the next tick re-reads that object from R2, re-verifies
 * its sha256 and finishes the delete from the object's own ids.
 *
 * Silver is untouched: no DELETE trigger, no FK, no cascade on these tables.
 * The one SQL reader of old bronze, run_origin_org(), reads the archived origin
 * kept in lifecycle_archived_run_origins (migration 0095).
 */

export const ARCHIVE_RETENTION_DAYS = 90;
export const ARCHIVE_KEY_PREFIX = "runs-archive";
export const PART_MAX_ROWS = 50_000;
const DELETE_CHUNK = 5_000;
const DELETE_PAUSE_MS = 200;
const FIRST_TICK_MS = 60_000;
const TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const KILL_SWITCH_ENV = "LIFECYCLE_ARCHIVE_DISABLED";

export interface ArchivedColumn {
  name: string;
  /** Postgres type the text is cast back to on restore. */
  type: string;
}

export interface ArchivedTable {
  name: "run_lifecycle_events" | "cost_lifecycle_events";
  /** Every column, in table order. The job refuses to run if the live table has another set. */
  columns: ArchivedColumn[];
  /** btree on occurred_at the job creates CONCURRENTLY before its first chunk. */
  occurredAtIndex: string;
}

export const ARCHIVED_TABLES: ArchivedTable[] = [
  {
    name: "run_lifecycle_events",
    columns: [
      { name: "id", type: "uuid" },
      { name: "run_id", type: "uuid" },
      { name: "event_type", type: "text" },
      { name: "payload", type: "jsonb" },
      { name: "source_service", type: "text" },
      { name: "identity", type: "jsonb" },
      { name: "idempotency_key", type: "text" },
      { name: "correlation_id", type: "text" },
      { name: "occurred_at", type: "timestamptz" },
    ],
    occurredAtIndex: "idx_rle_occurred_at",
  },
  {
    name: "cost_lifecycle_events",
    columns: [
      { name: "id", type: "uuid" },
      { name: "cost_id", type: "uuid" },
      { name: "run_id", type: "uuid" },
      { name: "event_type", type: "text" },
      { name: "payload", type: "jsonb" },
      { name: "identity", type: "jsonb" },
      { name: "idempotency_key", type: "text" },
      { name: "correlation_id", type: "text" },
      { name: "occurred_at", type: "timestamptz" },
    ],
    occurredAtIndex: "idx_cle_occurred_at",
  },
];

export function tableSpec(name: string): ArchivedTable {
  const t = ARCHIVED_TABLES.find((x) => x.name === name);
  if (!t) throw new Error(`not an archived table: ${name}`);
  return t;
}

export type ArchivedRow = Record<string, string | null>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC midnight of (first day of `now`'s UTC month - 90 days). */
export function archiveBoundary(now: Date = new Date()): Date {
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return new Date(monthStart - ARCHIVE_RETENTION_DAYS * DAY_MS);
}

export function objectKey(table: string, day: string, part: number): string {
  const [y, m, d] = day.split("-");
  return `${ARCHIVE_KEY_PREFIX}/${table}/${y}/${m}/${d}${part === 0 ? "" : `-part${part}`}.ndjson.gz`;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function toNdjson(rows: ArchivedRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

export async function encodeRows(rows: ArchivedRow[]): Promise<Buffer> {
  return gzip(Buffer.from(toNdjson(rows), "utf8"), { level: 6 });
}

export async function decodeRows(body: Buffer): Promise<ArchivedRow[]> {
  const text = (await gunzip(body)).toString("utf8");
  return text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as ArchivedRow);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `{a,b}` literal for a `::uuid[]` cast (ids are uuids read back from our own column). */
function uuidArrayLiteral(ids: string[]): string {
  return `{${ids.join(",")}}`;
}

async function assertColumns(sql: Sql, t: ArchivedTable): Promise<void> {
  const rows = await sql.unsafe<{ attname: string }[]>(
    `SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    [t.name],
  );
  const live = rows.map((r) => r.attname).join(",");
  const spec = t.columns.map((c) => c.name).join(",");
  if (live !== spec) {
    throw new Error(`${t.name} columns changed (live ${live} vs archived ${spec}): update ARCHIVED_TABLES first`);
  }
}

/**
 * The day walk needs a range scan on occurred_at; run_lifecycle_events had none
 * (0094 dropped idx_rle_event_type). Built CONCURRENTLY here, never in a boot
 * migration (it would block every run write for minutes). An INVALID leftover
 * from a killed build is dropped and rebuilt.
 */
export async function ensureOccurredAtIndex(sql: Sql, t: ArchivedTable): Promise<void> {
  const rows = await sql.unsafe<{ valid: boolean }[]>(
    `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`,
    [t.occurredAtIndex],
  );
  if (rows.length === 1 && rows[0].valid) return;
  if (rows.length === 1) {
    console.warn(`[Runs Service] lifecycle archive: dropping invalid index ${t.occurredAtIndex}`);
    await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${t.occurredAtIndex}`);
  }
  const t0 = Date.now();
  await sql.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${t.occurredAtIndex} ON ${t.name} (occurred_at)`);
  console.log(`[Runs Service] lifecycle archive: built ${t.occurredAtIndex} in ${Date.now() - t0}ms`);
}

async function selectChunk(sql: Sql, t: ArchivedTable, day: string, limit: number): Promise<ArchivedRow[]> {
  const cols = t.columns.map((c) => `${c.name}::text AS ${c.name}`).join(", ");
  const rows = await sql.unsafe<ArchivedRow[]>(
    `SELECT ${cols} FROM ${t.name}
      WHERE occurred_at >= $1::date::timestamp AT TIME ZONE 'UTC'
        AND occurred_at < ($1::date + 1)::timestamp AT TIME ZONE 'UTC'
      ORDER BY id
      LIMIT ${Number(limit)}`,
    [day],
  );
  // postgres.js rows carry extra properties; keep exactly the archived columns, in order.
  return rows.map((r) => {
    const o: ArchivedRow = {};
    for (const c of t.columns) o[c.name] = (r as ArchivedRow)[c.name] ?? null;
    return o;
  });
}

/** Read back what R2 holds and prove it is the chunk: sha256, count, ordered ids. */
async function verifyObject(
  store: ArchiveStore,
  key: string,
  expectSha: string,
  expectIds: string[] | null,
): Promise<ArchivedRow[]> {
  const { body } = await store.get(key);
  const got = sha256(body);
  if (got !== expectSha) throw new Error(`${key}: sha256 read back ${got} != written ${expectSha}`);
  const rows = await decodeRows(body);
  if (expectIds) {
    if (rows.length !== expectIds.length) {
      throw new Error(`${key}: ${rows.length} rows read back != ${expectIds.length} selected`);
    }
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].id !== expectIds[i]) throw new Error(`${key}: id #${i} read back ${rows[i].id} != ${expectIds[i]}`);
    }
  }
  return rows;
}

/**
 * Keep what run_origin_org() reads (the run's earliest run.created organizationId)
 * before the event leaves bronze. Earliest wins across parts and days.
 */
async function keepRunOrigins(sql: Sql, t: ArchivedTable, rows: ArchivedRow[]): Promise<void> {
  if (t.name !== "run_lifecycle_events") return;
  const origins = rows
    .filter((r) => r.event_type === "run.created")
    .map((r) => {
      const payload = JSON.parse(r.payload as string) as { organizationId?: unknown };
      const org = typeof payload.organizationId === "string" && payload.organizationId !== "" ? payload.organizationId : null;
      return { r: r.run_id, o: org, t: r.occurred_at };
    });
  if (origins.length === 0) return;
  await sql.unsafe(
    `INSERT INTO lifecycle_archived_run_origins (run_id, organization_id, occurred_at)
     SELECT DISTINCT ON (x.r::uuid) x.r::uuid, x.o::uuid, x.t::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS x(r text, o text, t text)
      ORDER BY x.r::uuid, x.t::timestamptz
     ON CONFLICT (run_id) DO UPDATE
        SET organization_id = EXCLUDED.organization_id, occurred_at = EXCLUDED.occurred_at
      WHERE EXCLUDED.occurred_at < lifecycle_archived_run_origins.occurred_at`,
    [JSON.stringify(origins)],
  );
}

async function deleteIds(sql: Sql, t: ArchivedTable, ids: string[], boundary: Date, pauseMs: number): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const slice = ids.slice(i, i + DELETE_CHUNK);
    // occurred_at guard: an id is only ever deleted if it is older than the boundary.
    const res = await sql.unsafe(
      `DELETE FROM ${t.name} WHERE id = ANY($1::uuid[]) AND occurred_at < $2::timestamptz`,
      [uuidArrayLiteral(slice), boundary.toISOString()],
    );
    deleted += res.count;
    if (i + DELETE_CHUNK < ids.length && pauseMs > 0) await pause(pauseMs);
  }
  return deleted;
}

async function finalizeObject(
  sql: Sql,
  t: ArchivedTable,
  objectId: string,
  key: string,
  rows: ArchivedRow[],
  boundary: Date,
  pauseMs: number,
): Promise<number> {
  await keepRunOrigins(sql, t, rows);
  const deleted = await deleteIds(sql, t, rows.map((r) => r.id as string), boundary, pauseMs);
  await sql.unsafe(`UPDATE lifecycle_archive_objects SET deleted_at = now() WHERE id = $1::uuid`, [objectId]);
  console.log(`[Runs Service] archived ${t.name} ${key} rows=${rows.length} deleted=${deleted}`);
  return deleted;
}

export interface ArchiveTableResult {
  table: string;
  objects: number;
  rows: number;
  deleted: number;
}

export interface ArchiveOptions {
  boundary?: Date;
  partMaxRows?: number;
  deletePauseMs?: number;
  /** Re-checked before every chunk so a long run stops as soon as asked. */
  shouldStop?: () => boolean;
}

export async function archiveTable(
  store: ArchiveStore,
  t: ArchivedTable,
  opts: ArchiveOptions = {},
  sql: Sql = defaultSql,
): Promise<ArchiveTableResult> {
  const boundary = opts.boundary ?? archiveBoundary();
  const partMax = opts.partMaxRows ?? PART_MAX_ROWS;
  const pauseMs = opts.deletePauseMs ?? DELETE_PAUSE_MS;
  const result: ArchiveTableResult = { table: t.name, objects: 0, rows: 0, deleted: 0 };

  await assertColumns(sql, t);
  await ensureOccurredAtIndex(sql, t);

  // 1. Objects recorded but not fully deleted (a deploy killed the delete): finish from R2.
  const pending = await sql.unsafe<{ id: string; object_key: string; sha256: string; rows: number }[]>(
    `SELECT id::text, object_key, sha256, rows FROM lifecycle_archive_objects
      WHERE source_table = $1 AND deleted_at IS NULL ORDER BY day, part`,
    [t.name],
  );
  for (const p of pending) {
    if (opts.shouldStop?.()) return result;
    const rows = await verifyObject(store, p.object_key, p.sha256, null);
    if (rows.length !== p.rows) throw new Error(`${p.object_key}: ${rows.length} rows in R2 != ${p.rows} recorded`);
    result.deleted += await finalizeObject(sql, t, p.id, p.object_key, rows, boundary, pauseMs);
  }

  // 2. Walk the days older than the boundary, oldest first.
  const [{ min }] = await sql.unsafe<{ min: string | null }[]>(
    `SELECT to_char(min(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS min FROM ${t.name}`,
  );
  if (!min) return result;
  const lastDay = new Date(boundary.getTime() - DAY_MS).toISOString().slice(0, 10);
  for (let day = min; day <= lastDay; day = new Date(Date.parse(day) + DAY_MS).toISOString().slice(0, 10)) {
    for (;;) {
      if (opts.shouldStop?.()) return result;
      const rows = await selectChunk(sql, t, day, partMax);
      if (rows.length === 0) break;
      const [{ part }] = await sql.unsafe<{ part: number }[]>(
        `SELECT COALESCE(max(part) + 1, 0)::int AS part FROM lifecycle_archive_objects WHERE source_table = $1 AND day = $2::date`,
        [t.name, day],
      );
      const key = objectKey(t.name, day, part);
      const body = await encodeRows(rows);
      const digest = sha256(body);
      const ids = rows.map((r) => r.id as string);
      // Rewriting the same key after a kill before the record below is safe: no row
      // of this part was deleted, so the re-selected chunk is the same one.
      await store.put(key, body, { rows: String(rows.length), sha256: digest, table: t.name, day });
      await verifyObject(store, key, digest, ids);
      const [obj] = await sql.unsafe<{ id: string }[]>(
        `INSERT INTO lifecycle_archive_objects (source_table, object_key, day, part, rows, bytes, sha256)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7) RETURNING id::text`,
        [t.name, key, day, part, rows.length, body.length, digest],
      );
      result.objects += 1;
      result.rows += rows.length;
      result.deleted += await finalizeObject(sql, t, obj.id, key, rows, boundary, pauseMs);
      if (rows.length < partMax) break;
    }
  }
  return result;
}

export interface ArchiveStats {
  objects: number;
  rows: number;
  bytes: number;
}

export async function lifecycleArchiveStats(sql: Sql = defaultSql): Promise<ArchiveStats> {
  const [r] = await sql.unsafe<{ objects: string; rows: string; bytes: string }[]>(
    `SELECT count(*)::text AS objects, COALESCE(sum(rows), 0)::text AS rows, COALESCE(sum(bytes), 0)::text AS bytes
       FROM lifecycle_archive_objects`,
  );
  return { objects: Number(r.objects), rows: Number(r.rows), bytes: Number(r.bytes) };
}

let running = false;
let loggedDisabled = false;
let loggedNotConfigured = false;

export function archiveDisabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env[KILL_SWITCH_ENV] ?? "");
}

/** One tick: both tables, one at a time, never two ticks at once. */
export async function runLifecycleArchiveTick(storeFactory?: () => Promise<ArchiveStore>): Promise<ArchiveTableResult[] | null> {
  if (running) return null;
  if (archiveDisabled()) {
    if (!loggedDisabled) console.log(`[Runs Service] lifecycle archive disabled (${KILL_SWITCH_ENV})`);
    loggedDisabled = true;
    return null;
  }
  running = true;
  try {
    let store: ArchiveStore;
    try {
      store = storeFactory
        ? await storeFactory()
        : new R2ArchiveStore(await loadR2CredentialsFromKeyService("/jobs/lifecycle-archive"));
    } catch (err) {
      if (err instanceof R2NotConfiguredError) {
        if (!loggedNotConfigured) console.warn(`[Runs Service] lifecycle archive is a no-op until R2 is configured: ${err.message}`);
        loggedNotConfigured = true;
        return null;
      }
      throw err;
    }
    const out: ArchiveTableResult[] = [];
    for (const t of ARCHIVED_TABLES) {
      const r = await archiveTable(store, t, { shouldStop: archiveDisabled });
      if (r.objects > 0 || r.deleted > 0) {
        console.log(`[Runs Service] lifecycle archive ${t.name}: objects=${r.objects} rows=${r.rows} deleted=${r.deleted}`);
      }
      out.push(r);
    }
    return out;
  } finally {
    running = false;
  }
}

/** Started after app.listen(): first tick ~60 s after boot, then every 6 h. */
export function startLifecycleArchive(): NodeJS.Timeout {
  const tick = async () => {
    try {
      await runLifecycleArchiveTick();
    } catch (err) {
      // Nothing was deleted for the failing chunk (delete only follows a verified read-back).
      console.error("[Runs Service] lifecycle archive tick failed (retried next tick):", err);
    }
  };
  setTimeout(() => void tick(), FIRST_TICK_MS).unref();
  const timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
  timer.unref();
  return timer;
}
