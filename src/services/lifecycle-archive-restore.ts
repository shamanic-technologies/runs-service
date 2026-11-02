import { sql as defaultSql } from "../db/index.js";
import type { ArchiveStore } from "./archive-store.js";
import { ARCHIVE_KEY_PREFIX, decodeRows, sha256, tableSpec, type ArchivedRow, type ArchivedTable } from "./lifecycle-archive.js";

type Sql = typeof defaultSql;

/**
 * Restore archived lifecycle events (BOX-DISK-1101) from R2 back into Postgres.
 *
 * DEFAULT TARGET IS A STAGING TABLE `<table>_restored` (same columns, same primary
 * key, NO trigger), never the live bronze table. Why: the live tables carry AFTER
 * INSERT triggers that project to silver. Re-inserting old events there replays
 * them OUT OF ORDER against today's silver: a restored `cost.materialized` sets a
 * since-refunded cost back to `actual`, a `run.created` re-creates a run an org
 * deletion removed, `run.completed` rewrites completed_at. The staging table lets
 * you read / join / audit the history with silver untouched. Inserting into the
 * live table needs `allowLive` (and then the next archive tick re-archives those
 * rows as a new part, since they are older than the boundary).
 *
 * Every row is inserted from its archived Postgres text cast back to the column
 * type, `ON CONFLICT (id) DO NOTHING`, so a restore is idempotent and byte-equal.
 */

export interface RestoreOptions {
  /** A key, or a prefix such as `runs-archive/run_lifecycle_events/2026/05/`. */
  keyOrPrefix: string;
  /** Destination table; default `<table>_restored`. */
  target?: string;
  /** Required to write into the live bronze table (triggers re-project to silver). */
  allowLive?: boolean;
  batchRows?: number;
}

export interface RestoreResult {
  target: string;
  objects: number;
  rows: number;
  inserted: number;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

async function insertRows(sql: Sql, t: ArchivedTable, target: string, rows: ArchivedRow[]): Promise<number> {
  const cols = t.columns.map((c) => c.name).join(", ");
  const casts = t.columns.map((c) => `x.${c.name}::${c.type}`).join(", ");
  const decl = t.columns.map((c) => `${c.name} text`).join(", ");
  const res = await sql.unsafe(
    `INSERT INTO ${target} (${cols})
     SELECT ${casts} FROM jsonb_to_recordset($1::jsonb) AS x(${decl})
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(rows)],
  );
  return res.count;
}

export async function restoreLifecycleArchive(
  store: ArchiveStore,
  tableName: string,
  opts: RestoreOptions,
  sql: Sql = defaultSql,
): Promise<RestoreResult> {
  const t = tableSpec(tableName);
  const target = opts.target ?? `${t.name}_restored`;
  if (!IDENT.test(target)) throw new Error(`invalid target table name: ${target}`);
  if (target === t.name && !opts.allowLive) {
    throw new Error(`refusing to restore into live ${t.name} without allowLive (its triggers re-project to silver)`);
  }
  const tablePrefix = `${ARCHIVE_KEY_PREFIX}/${t.name}/`;
  if (!opts.keyOrPrefix.startsWith(tablePrefix)) {
    throw new Error(`${opts.keyOrPrefix} is not under ${tablePrefix}`);
  }
  if (target !== t.name) {
    // LIKE copies columns, defaults, NOT NULLs and indexes (so the PK for ON CONFLICT), never triggers.
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${target} (LIKE ${t.name} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
  }

  const keys = opts.keyOrPrefix.endsWith(".ndjson.gz") ? [opts.keyOrPrefix] : await store.list(opts.keyOrPrefix);
  const batch = opts.batchRows ?? 2_000;
  const out: RestoreResult = { target, objects: 0, rows: 0, inserted: 0 };
  for (const key of keys) {
    const { body, metadata } = await store.get(key);
    // The sha256 recorded at archive time: our own table first, the object's metadata otherwise.
    const recorded = await sql.unsafe<{ sha256: string }[]>(
      `SELECT sha256 FROM lifecycle_archive_objects WHERE object_key = $1`,
      [key],
    );
    const expected = recorded[0]?.sha256 ?? metadata.sha256;
    if (!expected) throw new Error(`${key}: no recorded sha256 to verify against`);
    const got = sha256(body);
    if (got !== expected) throw new Error(`${key}: sha256 ${got} != recorded ${expected}`);
    const rows = await decodeRows(body);
    if (metadata.rows && Number(metadata.rows) !== rows.length) {
      throw new Error(`${key}: ${rows.length} rows != metadata rows=${metadata.rows}`);
    }
    for (let i = 0; i < rows.length; i += batch) {
      out.inserted += await insertRows(sql, t, target, rows.slice(i, i + batch));
    }
    out.objects += 1;
    out.rows += rows.length;
    console.log(`restored ${t.name} ${key} rows=${rows.length} into ${target}`);
  }
  return out;
}
