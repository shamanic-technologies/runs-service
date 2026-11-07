// LEDGER-LOAD-1107-RUNS: the general ledger's reads keep the per-day partial
// aggregates they already read, keyed on the stored day's VERSION.
//
// Why: every figure features-service serves is read from the stored ledger days
// (outcome_cost_days, pipe_unit_days), mostly since inception, re-asked every 60 s
// per brand / campaign while a dashboard is open. Between two reads only TODAY and
// the days the refresher recomputed move. On the loaded box one brand's lifetime
// read took 27-33 s (heap pages of the 284 MB table evicted, re-read from disk).
//
// How (exact by construction):
//   - a stored day changes ONLY through storeLedgerDay, which rewrites its rows and
//     its cost_ledger_computed_days.computed_at in ONE transaction. computed_at (+ the
//     flags a read filters on) is the day's version: same version = same rows.
//   - a read lists the versions of its range (one ~1 kB indexed read), re-reads only
//     the days whose version differs from the cached one, in ONE repeatable-read
//     transaction that also reads those days' versions (rows and version agree).
//   - a day with no stored version (never computed) is never cached: read every time.
//   - partial sums merge EXACTLY (decimal, no precision limit that a ledger sum can
//     reach), a NULL sum stays NULL when every partial is NULL (SUM semantics), and
//     the group ORDER comes from Postgres (same collation as the live ORDER BY).
// Nothing is ever served from a version the ledger no longer holds: the cache can
// only skip re-reading rows that are byte-identical to what it holds.

import { sql, type SQL } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { statsDb } from "../db/index.js";
import { ALLOCATION_VERSION } from "./outcome-ledger.js";

/** Exact for any ledger sum (a lifetime total fits far below 200 significant digits). */
export const ExactDecimal = Decimal.clone({ precision: 200, rounding: Decimal.ROUND_HALF_UP });

/** Rows kept across every cached read; least recently used reads are dropped past it. */
const MAX_CACHED_ROWS = Number(process.env.LEDGER_READ_CACHE_MAX_ROWS ?? 600_000);

/** Kill switch: `LEDGER_READ_CACHE=off` reads every day live (the pre-1107 path). */
export const ledgerReadCacheEnabled = () => process.env.LEDGER_READ_CACHE !== "off";

/** One section of a read: rows grouped by day (`__day`) x the section's dimensions. */
export interface DaySection {
  /** Builds the section's partial query for the given days (rows carry `__day`). */
  partial(daysParam: SQL): SQL;
}

interface DayPartial {
  version: string;
  sections: any[][];
}

interface Entry {
  days: Map<string, DayPartial>;
  rows: number;
  pending: Promise<void>;
}

const entries = new Map<string, Entry>();
let totalRows = 0;

/** Test hook: forget every cached day. */
export function clearLedgerDayCache(): void {
  entries.clear();
  totalRows = 0;
}

/** Days re-read from the database since boot (test / log visibility). */
export const ledgerDayCacheStats = { daysRead: 0, daysServedFromCache: 0 };

export const daysOf = (since: string, until: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${since}T00:00:00Z`); t <= Date.parse(`${until}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};

const versionSql = (where: SQL) => sql`
  SELECT to_char(day, 'YYYY-MM-DD') AS day,
         computed_at::text || '|' || consumed_sources::text || '|' || start_days::text AS version
  FROM cost_ledger_computed_days
  WHERE allocation_version = ${ALLOCATION_VERSION} AND ${where}`;

const dateArray = (days: string[]) => sql`${`{${days.join(",")}}`}::date[]`;

/**
 * Per-day partial rows of every section for the days in [since, until]: cached days
 * whose stored version is unchanged, the others read now. `key` names the read
 * (grouping + filters): the same key always builds the same sections.
 */
export async function partialsByDay(key: string, sections: DaySection[], since: string, until: string): Promise<Map<string, any[][]>> {
  const days = daysOf(since, until);
  let entry = entries.get(key);
  if (!entry) {
    entry = { days: new Map(), rows: 0, pending: Promise.resolve() };
    entries.set(key, entry);
  }
  // One refill per read key at a time: a second identical read waits, then finds the days cached.
  const prev = entry.pending;
  let release!: () => void;
  entry.pending = new Promise<void>((r) => (release = r));
  await prev;
  try {
    // LRU: most recently used last.
    entries.delete(key);
    entries.set(key, entry);

    const versions = new Map(
      ((await statsDb.execute(versionSql(sql`day BETWEEN ${since}::date AND ${until}::date`))) as any[]).map((r) => [r.day as string, r.version as string]),
    );
    const out = new Map<string, any[][]>();
    const toRead: string[] = [];
    for (const d of days) {
      const v = versions.get(d);
      const hit = v !== undefined ? entry.days.get(d) : undefined;
      if (hit && hit.version === v) {
        out.set(d, hit.sections);
        ledgerDayCacheStats.daysServedFromCache++;
      } else toRead.push(d);
    }
    if (toRead.length > 0) {
      const read = await readDays(sections, toRead);
      ledgerDayCacheStats.daysRead += toRead.length;
      for (const d of toRead) {
        const got = read.byDay.get(d) ?? sections.map(() => []);
        out.set(d, got);
        const old = entry.days.get(d);
        if (old) {
          entry.days.delete(d);
          const n = old.sections.reduce((s, rows) => s + rows.length, 0);
          entry.rows -= n;
          totalRows -= n;
        }
        const v = read.versions.get(d);
        if (v !== undefined) {
          entry.days.set(d, { version: v, sections: got });
          const n = got.reduce((s, rows) => s + rows.length, 0);
          entry.rows += n;
          totalRows += n;
        }
      }
      evict(key);
    }
    return out;
  } finally {
    release();
  }
}

function evict(keep: string): void {
  for (const [k, e] of entries) {
    if (totalRows <= MAX_CACHED_ROWS) return;
    if (k === keep) continue;
    totalRows -= e.rows;
    entries.delete(k);
  }
}

/** The days' rows of every section and the days' versions, in ONE snapshot. */
async function readDays(sections: DaySection[], days: string[]): Promise<{ byDay: Map<string, any[][]>; versions: Map<string, string> }> {
  return statsDb.transaction(
    async (tx) => {
      // A cold read (since inception, fleet-wide) runs past the 30 s stats timeout on the loaded box.
      await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
      const versions = new Map(((await tx.execute(versionSql(sql`day = ANY(${dateArray(days)})`))) as any[]).map((r) => [r.day as string, r.version as string]));
      const byDay = new Map<string, any[][]>();
      for (let i = 0; i < sections.length; i++) {
        const rows = (await tx.execute(sections[i].partial(dateArray(days)))) as any[];
        for (const r of rows) {
          const d = r.__day as string;
          let at = byDay.get(d);
          if (!at) byDay.set(d, (at = sections.map(() => [])));
          at[i].push(r);
        }
      }
      return { byDay, versions };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * Sums partial rows into groups keyed on `dimNames`: every `sumAliases` field is an
 * exact decimal sum, NULL when no partial carried a value (SQL SUM). Values come
 * back as exact decimal strings (the readers parse them with Decimal, like the
 * `SUM(...)::text` they replace).
 */
export function mergeGroups(rows: Iterable<any>, dimNames: string[], sumAliases: string[]): any[] {
  const groups = new Map<string, { dims: any[]; sums: (Decimal | null)[] }>();
  for (const r of rows) {
    const dims = dimNames.map((n) => r[n] ?? null);
    const k = JSON.stringify(dims);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { dims, sums: sumAliases.map(() => null) }));
    for (let i = 0; i < sumAliases.length; i++) {
      const v = r[sumAliases[i]];
      if (v === null || v === undefined) continue;
      g.sums[i] = g.sums[i] === null ? new ExactDecimal(v) : g.sums[i]!.plus(v);
    }
  }
  return [...groups.values()].map((g) => {
    const o: any = {};
    dimNames.forEach((n, i) => (o[n] = g.dims[i]));
    sumAliases.forEach((a, i) => (o[a] = g.sums[i] === null ? null : g.sums[i]!.toFixed()));
    return o;
  });
}

/**
 * Orders grouped rows as `ORDER BY <dims> NULLS FIRST` would on their text values:
 * Postgres sorts the dimension tuples (the database collation, never a JS
 * comparator), the rows are rearranged to match.
 */
export async function orderLikePostgres(rows: any[], dimNames: string[]): Promise<any[]> {
  if (rows.length < 2 || dimNames.length === 0) return rows;
  const tuples = JSON.stringify(rows.map((r) => dimNames.map((n) => (r[n] === null || r[n] === undefined ? null : String(r[n])))));
  const order = sql.raw(dimNames.map((_, i) => `(e.v->>${i}) NULLS FIRST`).join(", "));
  const idx = (await statsDb.execute(sql`
    SELECT (e.ord - 1)::int AS i FROM jsonb_array_elements(${tuples}::jsonb) WITH ORDINALITY AS e(v, ord) ORDER BY ${order}
  `)) as any[];
  return idx.map((r) => rows[Number(r.i)]);
}
