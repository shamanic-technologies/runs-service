// The books of ONE brand (FACTORY-P4-PAGES, the dashboard's staff Ledger page).
//
// Two reads, both service-auth:
//   - GET /internal/brands/:brandId/ledger: the doctrine's books line over a day
//     range, and the same line per UTC day (the stored daily series behind the page's
//     charts), plus what the brand's runs produced per outcome. Read from the stored
//     days only (outcome_cost_days, the refresher's per-day rows), never the ledger:
//        standard cost charged - reuse gain + spend of runs producing none + abnormal loss = spend
//     where standard = production spread on the brand's occurrences + the standard
//     charges of its reuses, and spend = the runs ledger at brand grain. Each side is
//     summed apart in Postgres, the difference is served, `balanced` is exact (no tolerance).
//   - GET /internal/brands/:brandId/ledger/runs: the brand's production orders newest
//     first, each with its own cost (actual + refunded rows, the ledger's rule 1), the
//     outcomes it declared produced and consumed, and its support mark.
//
// A co-branded run counts under each of its brands, as every other brand read here.

import { sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { statsDb } from "../db/index.js";
import { ALLOCATION_VERSION, addDays, staleDaysIn, type Money } from "./outcome-ledger.js";
import { SUPPORT_FUNCTIONS } from "./support-marks.js";

const fx = (v: unknown) => new Decimal((v as string | null) ?? "0").toFixed(10);
const money = (r: any, p: string): Money => ({ gross: fx(r[`${p}_g`]), net: fx(r[`${p}_n`]), vendor: fx(r[`${p}_v`]), unpricedGross: fx(r[`${p}_u`]) });
const BASES: Array<keyof Money> = ["gross", "net", "vendor", "unpricedGross"];
const add = (a: Money, b: Money): Money =>
  Object.fromEntries(BASES.map((k) => [k, new Decimal(a[k]).plus(b[k]).toFixed(10)])) as unknown as Money;

/** SUM of one money column set under a kind filter, as `<p>_g/_n/_v/_u`. */
const sums = (p: string, filter: string, col = "") =>
  ["gross", "net", "vendor", "unpriced_gross"]
    .map((c, i) => `SUM(d.${col}${c}) FILTER (WHERE ${filter})::text AS ${p}_${"gnvu"[i]}`)
    .join(", ");

export interface BrandBooks {
  /** Spend spread on the occurrences the brand's runs produced (normal loss included): standardCharged - reuseGain. */
  production: Money;
  /** Production spread on the brand's occurrences + standard charges of its reuses. */
  standardCharged: Money;
  /** Standard charges of reuses: charged, never spent again. */
  reuseGain: Money;
  /** Spend of runs that declared no produced occurrence (support + undeclared). */
  producedNone: Money;
  /** Part of producedNone that is named support, the rest is undeclared. */
  support: Money;
  undeclared: Money;
  /** Spend in no unit cost (IAS 2 section 16): a line apart. */
  abnormal: Money;
  /** The runs ledger at brand grain: every actual/refunded cost row, wherever it was allocated. */
  spend: Money;
  /** standard - reuseGain + producedNone + abnormal - spend, per basis. */
  difference: Money;
  balanced: boolean;
}

export interface BrandLedgerDay extends BrandBooks {
  day: string;
  /** Occurrences the brand's runs declared produced that day. */
  occurrences: number;
}

export interface BrandLedger {
  brandId: string;
  since: string;
  until: string;
  /** Days not stored under the current allocation, or stale: out of every figure. */
  daysMissing: string[];
  complete: boolean;
  books: BrandBooks;
  days: BrandLedgerDay[];
  /** What the brand's runs produced over the range, per outcome: occurrences and their production cost. */
  outcomes: Array<{ outcomeKey: string; occurrences: number; cost: Money }>;
}

function books(r: any): BrandBooks {
  const produced = money(r, "p");
  const reuseGain = money(r, "r");
  const producedNone = money(r, "z");
  const abnormal = money(r, "a");
  const spend = money(r, "s");
  const support = money(r, "sup");
  const standardCharged = add(produced, reuseGain);
  const difference = {} as Money;
  let balanced = true;
  for (const k of BASES) {
    const d = new Decimal(standardCharged[k]).minus(reuseGain[k]).plus(producedNone[k]).plus(abnormal[k]).minus(spend[k]);
    if (!d.isZero()) balanced = false;
    difference[k] = d.toFixed(10);
  }
  const undeclared = Object.fromEntries(BASES.map((k) => [k, new Decimal(producedNone[k]).minus(support[k]).toFixed(10)])) as unknown as Money;
  return { production: produced, standardCharged, reuseGain, producedNone, support, undeclared, abnormal, spend, difference, balanced };
}

/** The money columns every books row needs, from one scan of the brand's stored days. */
const BOOKS_SELECT = sql.raw(
  [
    sums("p", "d.kind = 'produced_cost'"),
    sums("r", "d.kind = 'consumed'", "reuse_"),
    sums("z", "d.kind = 'none'"),
    sums("sup", `d.kind = 'none' AND d.support_function IN (${SUPPORT_FUNCTIONS.map((f) => `'${f}'`).join(", ")})`),
    sums("a", "d.kind = 'abnormal'"),
    // The runs ledger, summed apart: every spend kind the refresher splits a cost row into.
    sums("s", "d.kind IN ('produced_cost', 'none', 'abnormal')"),
    "(SUM(d.n) FILTER (WHERE d.kind = 'produced_count'))::text AS occ",
  ].join(",\n    "),
);

/** Stored days usable for a read: computed under the current allocation, with the state ladder, not stale. */
async function usableDays(since: string, until: string): Promise<{ usable: string[]; missing: string[] }> {
  const rows = (await statsDb.execute(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day FROM cost_ledger_computed_days
    WHERE allocation_version = ${ALLOCATION_VERSION} AND outcome_costs AND state_ladder AND state_inputs AND our_factory
      AND day BETWEEN ${since}::date AND ${until}::date
  `)) as any[];
  const stored = new Set(rows.map((r) => r.day as string));
  const stale = new Set(await staleDaysIn(since, until));
  const usable: string[] = [];
  const missing: string[] = [];
  for (let d = since; d <= until; d = addDays(d, 1)) (stored.has(d) && !stale.has(d) ? usable : missing).push(d);
  return { usable, missing };
}

export async function readBrandLedger(brandId: string, since: string, until: string): Promise<BrandLedger> {
  const { usable, missing } = await usableDays(since, until);
  const empty: BrandLedger = { brandId, since, until, daysMissing: missing, complete: missing.length === 0, books: books({}), days: [], outcomes: [] };
  if (usable.length === 0) return empty;
  // ONE scan of the brand's stored rows (~6 s for the busiest brand on the loaded box): per day, and per
  // produced outcome. The range total is the exact sum of the days (decimal.js, no float).
  // The busiest brand's scan takes 17-38 s on the loaded box (2026-10-29): past the stats pool's 30 s
  // timeout, so this one read gets 120 s in its own transaction; readBrandLedgerCached keeps callers off it.
  const rows = await statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
    return (await tx.execute(sql`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, d.outcome_key AS ok, GROUPING(d.day) AS by_outcome, ${BOOKS_SELECT}
    FROM outcome_cost_days d
    WHERE d.allocation_version = ${ALLOCATION_VERSION} AND d.day BETWEEN ${since}::date AND ${until}::date
      AND d.brand_ids @> ARRAY[${brandId}]::text[]
    GROUP BY GROUPING SETS ((d.day), (d.outcome_key))
  `)) as any[];
  });
  const keep = new Set(usable);
  const dayRows = rows.filter((r) => Number(r.by_outcome) === 0 && keep.has(r.day)).sort((a, b) => (a.day < b.day ? -1 : 1));
  if (dayRows.length !== rows.filter((r) => Number(r.by_outcome) === 0).length) {
    // An outcome row cannot be cut by day: with any unusable day holding rows, re-read outcomes on usable days only.
    const outcomes = (await statsDb.execute(sql`
      SELECT d.outcome_key AS ok, ${BOOKS_SELECT}
      FROM outcome_cost_days d
      WHERE d.allocation_version = ${ALLOCATION_VERSION} AND d.day = ANY(ARRAY[${sql.join(usable.map((d) => sql`${d}`), sql`, `)}]::date[])
        AND d.brand_ids @> ARRAY[${brandId}]::text[]
      GROUP BY d.outcome_key
    `)) as any[];
    return assemble(empty, usable, dayRows, outcomes);
  }
  return assemble(empty, usable, dayRows, rows.filter((r) => Number(r.by_outcome) === 1));
}

const SUM_COLS = ["p", "r", "z", "sup", "a", "s"].flatMap((p) => ["g", "n", "v", "u"].map((b) => `${p}_${b}`));

function assemble(empty: BrandLedger, usable: string[], dayRows: any[], outcomeRows: any[]): BrandLedger {
  const byDay = new Map(dayRows.map((r) => [r.day as string, r]));
  const total: Record<string, Decimal> = Object.fromEntries(SUM_COLS.map((c) => [c, new Decimal(0)]));
  for (const r of dayRows) for (const c of SUM_COLS) total[c] = total[c].plus(r[c] ?? 0);
  return {
    ...empty,
    books: books(Object.fromEntries(SUM_COLS.map((c) => [c, total[c].toFixed(10)]))),
    // Every usable day, a day with no row of the brand at zero: a chart reads a quiet day as 0, never skips it.
    days: usable.map((day) => {
      const r = byDay.get(day) ?? {};
      return { day, occurrences: new Decimal(r.occ ?? 0).toNumber(), ...books(r) };
    }),
    outcomes: outcomeRows
      .filter((r) => r.ok != null)
      .map((r) => ({ outcomeKey: r.ok as string, occurrences: new Decimal(r.occ ?? 0).toNumber(), cost: money(r, "p") }))
      .filter((o) => o.occurrences > 0 || !new Decimal(o.cost.gross).isZero())
      .sort((a, b) => a.outcomeKey.localeCompare(b.outcomeKey)),
  };
}

/**
 * The books behind a cache (FACTORY-P4-PAGES): the stored days move on the refresher's 15-min
 * cadence, so a reader gets the last answer up to FRESH_MS old at once, and an older one up to
 * STALE_MS old at once too while ONE recompute runs behind it (stale-while-revalidate). Only a
 * brand nobody read for an hour waits for the scan.
 */
const FRESH_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;
const CACHE_MAX = 200;
const ledgerCache = new Map<string, { at: number; value: BrandLedger | null; pending: Promise<BrandLedger> | null }>();

export async function readBrandLedgerCached(brandId: string, since: string, until: string): Promise<BrandLedger> {
  const key = `${brandId}|${since}|${until}`;
  const hit = ledgerCache.get(key);
  const age = hit?.value ? Date.now() - hit.at : Infinity;
  const refresh = () => {
    const entry = ledgerCache.get(key) ?? { at: 0, value: null, pending: null };
    if (entry.pending) return entry.pending;
    entry.pending = readBrandLedger(brandId, since, until)
      .then((value) => {
        ledgerCache.set(key, { at: Date.now(), value, pending: null });
        if (ledgerCache.size > CACHE_MAX) ledgerCache.delete(ledgerCache.keys().next().value!);
        return value;
      })
      .catch((err) => {
        entry.pending = null;
        throw err;
      });
    ledgerCache.set(key, entry);
    return entry.pending;
  };
  if (hit?.value && age < FRESH_MS) return hit.value;
  if (hit?.value && age < STALE_MS) {
    refresh().catch((err) => console.error("[Runs Service] brand ledger background refresh failed:", err));
    return hit.value;
  }
  return refresh();
}

/** Test seam. */
export function clearBrandLedgerCache(): void {
  ledgerCache.clear();
  countsCache.clear();
}

// ---------------------------------------------------------------------------
// The brand's production orders, newest first
// ---------------------------------------------------------------------------

/** One page looks back at most this far before `before`: a fleet-wide time index walk, bounded. */
export const BRAND_RUNS_WINDOW_HOURS = 24;
export const BRAND_RUNS_MAX_LIMIT = 100;

export interface BrandLedgerRun {
  id: string;
  parentRunId: string | null;
  startedAt: string;
  completedAt: string | null;
  status: string;
  serviceName: string;
  taskName: string;
  workflowSlug: string | null;
  featureSlug: string | null;
  campaignId: string | null;
  /** The run's own cost rows that happened (actual + refunded), the ledger's rule 1. */
  cost: { grossCents: string; netCents: string };
  costRows: number;
  produced: Array<{ outcomeKey: string; occurrences: number }>;
  consumed: Array<{ outcomeKey: string; occurrences: number }>;
  /** The support function the run is marked for, else null. */
  supportKind: string | null;
  /** The run this one is a step of (its caller), by service and task; null for a root run. */
  parent: { serviceName: string; taskName: string } | null;
}

/** The tabs of the production orders: a partition of the brand's runs. */
export const BRAND_RUN_KINDS = ["made", "running", "none"] as const;
export type BrandRunKind = (typeof BRAND_RUN_KINDS)[number];

export interface BrandLedgerRunsPage {
  brandId: string;
  /** The window this page read: [windowStart, before). */
  before: string;
  windowStart: string;
  runs: BrandLedgerRun[];
  /** Pass as `before` (and `beforeId`) for the next, older page: a full page continues after its oldest run, a short one before its window. */
  nextBefore: string;
  nextBeforeId: string | null;
  /** The partition asked (null = all). */
  kind: BrandRunKind | null;
  /**
   * First page only (no beforeId): the brand's runs started in the 24 h window of this page, per tab:
   * made = declared >= 1 produced outcome; running = still open and made nothing yet; none = closed and made nothing.
   */
  counts: { since: string; until: string; all: number; made: number; running: number; none: number } | null;
}

/** `before` = a timestamp as this read serves it (microseconds kept); `beforeId` = the run at that instant to continue after. */
const MADE = sql`EXISTS (SELECT 1 FROM run_outcomes o WHERE o.run_id = r.id AND o.direction = 'produced')`;
const KIND_SQL: Record<BrandRunKind, ReturnType<typeof sql>> = {
  made: MADE,
  running: sql`r.status = 'running' AND NOT ${MADE}`,
  none: sql`r.status <> 'running' AND NOT ${MADE}`,
};

export async function readBrandLedgerRuns(
  brandId: string,
  before: string,
  beforeId: string | null,
  limit: number,
  kind: BrandRunKind | null = null,
): Promise<BrandLedgerRunsPage> {
  const windowStart = (
    (await statsDb.execute(sql`SELECT (${before}::timestamptz - make_interval(hours => ${BRAND_RUNS_WINDOW_HOURS}))::text AS w`)) as any[]
  )[0].w as string;
  const cut = beforeId
    ? sql`(r.started_at, r.id) < (${before}::timestamptz, ${beforeId}::uuid)`
    : sql`r.started_at < ${before}::timestamptz`;
  // started_at range first: the planner walks idx_runs_started_status backward and filters the brand
  // (a GIN bitmap over a brand's millions of runs then a sort is the slow plan).
  const rows = (await statsDb.execute(sql`
    SELECT r.id, r.parent_run_id, r.started_at, r.started_at::text AS started_at_raw, r.completed_at, r.status, r.service_name, r.task_name,
           r.workflow_slug, r.feature_slug, r.campaign_id, m.kind AS support_kind, p.service_name AS parent_service, p.task_name AS parent_task
    FROM runs r
    LEFT JOIN run_support_marks m ON m.run_id = r.id
    LEFT JOIN LATERAL (SELECT service_name, task_name FROM runs WHERE id = r.parent_run_id OFFSET 0) p ON true
    WHERE ${cut} AND r.started_at >= ${windowStart}::timestamptz
      AND r.brand_ids @> ARRAY[${brandId}]::text[]
      ${kind ? sql`AND ${KIND_SQL[kind]}` : sql``}
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT ${limit}
  `)) as any[];
  const ids = rows.map((r) => r.id as string);
  const costs = new Map<string, { g: string; n: string; c: number }>();
  const outs = new Map<string, { produced: BrandLedgerRun["produced"]; consumed: BrandLedgerRun["consumed"] }>();
  if (ids.length > 0) {
    const idArr = sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;
    const c = (await statsDb.execute(sql`
      SELECT run_id, SUM(total_cost_in_usd_cents)::text AS g, SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents))::text AS n, COUNT(*)::int AS c
      FROM runs_costs WHERE run_id = ANY(${idArr}) AND status IN ('actual', 'refunded') GROUP BY run_id
    `)) as any[];
    for (const r of c) costs.set(r.run_id, { g: r.g, n: r.n, c: Number(r.c) });
    const o = (await statsDb.execute(sql`
      SELECT run_id, direction, outcome_key, COUNT(*)::int AS n
      FROM run_outcomes WHERE run_id = ANY(${idArr}) GROUP BY run_id, direction, outcome_key ORDER BY outcome_key
    `)) as any[];
    for (const r of o) {
      const at = outs.get(r.run_id) ?? outs.set(r.run_id, { produced: [], consumed: [] }).get(r.run_id)!;
      (r.direction === "produced" ? at.produced : at.consumed).push({ outcomeKey: r.outcome_key, occurrences: Number(r.n) });
    }
  }
  const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
  const runs: BrandLedgerRun[] = rows.map((r) => {
    const c = costs.get(r.id);
    const o = outs.get(r.id);
    return {
      id: r.id,
      parentRunId: r.parent_run_id ?? null,
      startedAt: iso(r.started_at)!,
      completedAt: iso(r.completed_at),
      status: r.status,
      serviceName: r.service_name,
      taskName: r.task_name,
      workflowSlug: r.workflow_slug ?? null,
      featureSlug: r.feature_slug ?? null,
      campaignId: r.campaign_id ?? null,
      cost: { grossCents: fx(c?.g), netCents: fx(c?.n) },
      costRows: c?.c ?? 0,
      produced: o?.produced ?? [],
      consumed: o?.consumed ?? [],
      supportKind: r.support_kind ?? null,
      parent: r.parent_service ? { serviceName: r.parent_service, taskName: r.parent_task } : null,
    };
  });
  // A full page continues just before its oldest run; a short one continues before the window.
  const full = rows.length === limit;
  const counts = beforeId ? null : await windowCounts(brandId, windowStart, before);
  return {
    kind,
    counts,
    brandId,
    before,
    windowStart,
    runs,
    nextBefore: full ? (rows[rows.length - 1].started_at_raw as string) : windowStart,
    nextBeforeId: full ? (rows[rows.length - 1].id as string) : null,
  };
}

/** Per-tab counts of one window, cached 5 min per (brand, window minute; ~10 s for the busiest brand on the loaded box): the page polls, the window barely moves. */
const countsCache = new Map<string, { at: number; value: NonNullable<BrandLedgerRunsPage["counts"]> }>();

async function windowCounts(brandId: string, since: string, until: string): Promise<NonNullable<BrandLedgerRunsPage["counts"]>> {
  const key = `${brandId}|${since.slice(0, 15)}`; // 10-min buckets: a window sliding with "now" reuses its count
  const hit = countsCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  const [c] = (await statsDb.execute(sql`
    SELECT count(*)::int AS all,
           count(*) FILTER (WHERE x.made)::int AS made,
           count(*) FILTER (WHERE NOT x.made AND r.status = 'running')::int AS running,
           count(*) FILTER (WHERE NOT x.made AND r.status <> 'running')::int AS none
    FROM runs r
    CROSS JOIN LATERAL (SELECT ${MADE} AS made) x
    WHERE r.started_at < ${until}::timestamptz AND r.started_at >= ${since}::timestamptz
      AND r.brand_ids @> ARRAY[${brandId}]::text[]
  `)) as any[];
  const value = { since, until, all: Number(c.all), made: Number(c.made), running: Number(c.running), none: Number(c.none) };
  countsCache.set(key, { at: Date.now(), value });
  if (countsCache.size > 500) countsCache.delete(countsCache.keys().next().value!);
  return value;
}
