import { sql as defaultSql } from "../db/index.js";

/**
 * Repair of STALE min/max in the run-grain rollups (migrations 0041, 0042, 0043, 0052, 0053).
 *
 * A removed run (a delete, or a key move: transfer-brand, feature-slug correction, a
 * workflow re-tag) cannot shrink a group's min/max without a scan, so its trigger marks
 * the row `minmax_stale`, and every read that returns min/max then takes the WHOLE UTC
 * day (or hour) holding that row from the live ledger instead of the rollup. Only a
 * full rebuild ever cleared the flag, so stale rows piled up (prod 2026-10-14: 849 on
 * the campaign-day rollup, 167 distinct days), and one brand-history read
 * (`GET /v1/stats/costs`, org + brand) turned into a live scan of the org's whole
 * history: 25 stale days for brand f4d73dab made the read run past the 30 s statement
 * timeout, several times per half hour, on exactly the read the rollup exists for.
 *
 * This recomputes each stale row's min/max from the ledger ONE GROUP AT A TIME, under
 * the row's lock, and clears the flag:
 *   1. `SELECT … FOR UPDATE` the stale row. Every trigger that adds or removes a run of
 *      this group updates the same row, so it now waits for us (or we for it).
 *   2. A NEW statement (read committed = a new snapshot, taken after the lock) counts
 *      the group's runs and reads their min/max.
 *   3. Only when that count equals the row's `run_count` (the rollup and the ledger
 *      agree on WHO is in the group) are min/max written and the flag cleared. A
 *      disagreement leaves the row stale (the reads stay live, i.e. correct) and is
 *      reported, never papered over.
 * A removal committing after our lock re-marks the row stale once we release it; an
 * addition only ever widens min/max through LEAST/GREATEST. So a cleared row is exact.
 *
 * Bounded: at most `limit` rows per pass, a short lock timeout (a group a writer holds
 * is skipped and retried next pass) and a statement timeout on the count.
 */

interface RollupSpec {
  table: string;
  /**
   * Rollup key columns, compared with IS NOT DISTINCT FROM (the unique keys are NULLS NOT DISTINCT).
   * Each is also the `runs` column of the same name.
   */
  keys: string[];
  /** The bucket column and its bounds as SQL over `{b}` (the bucket value). */
  bucket: { column: "day" | "hour"; lower: string; upper: string };
  /**
   * Keys that are NOT a plain `runs` column: run membership as SQL over `{k}` (the key
   * value). The audience (0052) is the cost rows' effective audience.
   */
  memberMatch?: Record<string, string>;
}

const SPECS: RollupSpec[] = [
  {
    table: "stats_rollup_campaign_runs",
    keys: ["campaign_id", "organization_id", "brand_ids", "feature_slug", "workflow_slug"],
    bucket: {
      column: "day",
      lower: `({b}::timestamp AT TIME ZONE 'UTC')`,
      upper: `(({b} + 1)::timestamp AT TIME ZONE 'UTC')`,
    },
  },
  {
    table: "stats_rollup_org_task",
    keys: ["organization_id", "service_name", "task_name", "campaign_id"],
    bucket: {
      column: "day",
      lower: `({b}::timestamp AT TIME ZONE 'UTC')`,
      upper: `(({b} + 1)::timestamp AT TIME ZONE 'UTC')`,
    },
  },
  {
    table: "stats_rollup_org_hour",
    keys: ["organization_id", "brand_ids", "campaign_id"],
    bucket: { column: "hour", lower: `{b}`, upper: `({b} + interval '1 hour')` },
  },
  {
    table: "stats_rollup_audience_runs",
    keys: ["campaign_id", "organization_id", "brand_ids", "feature_slug", "workflow_slug", "audience_id"],
    bucket: {
      column: "day",
      lower: `({b}::timestamp AT TIME ZONE 'UTC')`,
      upper: `(({b} + 1)::timestamp AT TIME ZONE 'UTC')`,
    },
    // A run is in the audience group when one of its cost rows carries that
    // effective audience, or when it has no cost row and is itself of it.
    memberMatch: {
      audience_id: `(EXISTS (SELECT 1 FROM runs_costs rc WHERE rc.run_id = r.id AND COALESCE(rc.audience_id, r.audience_id) IS NOT DISTINCT FROM {k})
        OR (r.audience_id IS NOT DISTINCT FROM {k} AND NOT EXISTS (SELECT 1 FROM runs_costs rc WHERE rc.run_id = r.id)))`,
    },
  },
  {
    table: "stats_rollup_cost_name_day",
    keys: ["campaign_id", "organization_id", "brand_ids", "feature_slug", "workflow_slug", "cost_name"],
    bucket: {
      column: "day",
      lower: `({b}::timestamp AT TIME ZONE 'UTC')`,
      upper: `(({b} + 1)::timestamp AT TIME ZONE 'UTC')`,
    },
    // A run is in the cost-name group when one of its cost rows carries that name.
    memberMatch: {
      cost_name: `EXISTS (SELECT 1 FROM runs_costs rc WHERE rc.run_id = r.id AND rc.cost_name = {k})`,
    },
  },
];

const COLUMN_TYPES: Record<string, string> = {
  organization_id: "uuid",
  brand_ids: "text[]",
  day: "date",
  hour: "timestamptz",
};

export interface MinMaxRepairResult {
  table: string;
  repaired: number;
  /** Rows whose ledger count disagrees with run_count: left stale (reads stay live). */
  mismatched: number;
  /** Rows a writer held past the lock timeout: retried next pass. */
  skippedLocked: number;
  /** Rows whose recount ran past the statement timeout: retried next pass. */
  skippedTimeout: number;
}

type Sql = typeof defaultSql;

async function repairTable(sql: Sql, spec: RollupSpec, limit: number): Promise<MinMaxRepairResult> {
  const result: MinMaxRepairResult = { table: spec.table, repaired: 0, mismatched: 0, skippedLocked: 0, skippedTimeout: 0 };
  const cols = [...spec.keys, spec.bucket.column];
  // Every key travels as TEXT and is cast back explicitly: a date read into a JS Date
  // would shift with the process timezone, and an untyped array parameter is ambiguous.
  const castOf = (c: string) => COLUMN_TYPES[c] ?? "text";
  const param = (c: string, i: number) => `$${i + 1}::${castOf(c)}`;
  const selectList = cols.map((c) => (castOf(c) === "text[]" ? c : `${c}::text AS ${c}`)).join(", ");
  // Most recent buckets first: those are the days a "past" or "today" read cuts through.
  const stale = await sql.unsafe(
    `SELECT ${selectList} FROM ${spec.table} WHERE minmax_stale ORDER BY ${spec.bucket.column} DESC LIMIT ${Math.trunc(limit)}`,
  );
  for (const row of stale) {
    const params = cols.map((c) => row[c]);
    const rowMatch = cols.map((c, i) => `${c} IS NOT DISTINCT FROM ${param(c, i)}`).join(" AND ");
    const b = param(spec.bucket.column, cols.length - 1);
    const lower = spec.bucket.lower.replaceAll("{b}", b);
    const upper = spec.bucket.upper.replaceAll("{b}", b);
    const runMatch = spec.keys
      .map((c, i) => spec.memberMatch?.[c]?.replaceAll("{k}", param(c, i)) ?? `r.${c} IS NOT DISTINCT FROM ${param(c, i)}`)
      .join(" AND ");
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = '2s'`);
        await tx.unsafe(`SET LOCAL statement_timeout = '20s'`);
        const [locked] = await tx.unsafe(
          `SELECT run_count FROM ${spec.table} WHERE ${rowMatch} AND minmax_stale FOR UPDATE`,
          params,
        );
        if (!locked) return; // repaired by a rebuild or another pass in between
        // The org predicate first (when there is one) lets the planner walk
        // idx_runs_org_started over the one bucket.
        const [ledger] = await tx.unsafe(
          `SELECT count(*)::bigint AS n, min(r.started_at) AS mn, max(r.started_at) AS mx
             FROM runs r
            WHERE r.started_at >= ${lower} AND r.started_at < ${upper} AND ${runMatch}`,
          params,
        );
        if (BigInt(ledger.n) !== BigInt(locked.run_count)) {
          result.mismatched += 1;
          return;
        }
        await tx.unsafe(
          `UPDATE ${spec.table} SET min_started_at = $${cols.length + 1}::timestamptz, max_started_at = $${cols.length + 2}::timestamptz, minmax_stale = false
            WHERE ${rowMatch}`,
          [...params, ledger.mn, ledger.mx],
        );
        result.repaired += 1;
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "55P03") {
        result.skippedLocked += 1; // lock_not_available: a writer holds the group, next pass
        continue;
      }
      if (code === "57014") {
        // statement_timeout on one group's recount (a busy box): skip it, never abort the pass, or one
        // slow group would stop every row ordered after it forever (prod 2026-10-14, first passes).
        result.skippedTimeout += 1;
        continue;
      }
      throw err;
    }
  }
  return result;
}

/** One repair pass over the rollups. Throws on an unexpected database error. */
export async function repairStaleMinMax(sql: Sql = defaultSql, limitPerTable = 200): Promise<MinMaxRepairResult[]> {
  const out: MinMaxRepairResult[] = [];
  for (const spec of SPECS) out.push(await repairTable(sql, spec, limitPerTable));
  return out;
}

const REPAIR_INTERVAL_MS = 5 * 60_000;
const FIRST_PASS_DELAY_MS = 60_000;
let running = false;

/**
 * Run a pass ~60 s after boot and every 5 minutes after. Called AFTER `app.listen()`
 * (it touches the database). In-process mutex: a pass never overlaps the previous one.
 */
export function startStaleMinMaxRepair(): void {
  if (process.env.STATS_ROLLUP_MINMAX_REPAIR_ENABLED === "false") return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const results = await repairStaleMinMax();
      const touched = results.filter((r) => r.repaired + r.mismatched + r.skippedLocked + r.skippedTimeout > 0);
      if (touched.length > 0) {
        console.log(
          `[Runs Service] rollup min/max repair: ${touched
            .map((r) => `${r.table} repaired=${r.repaired} mismatched=${r.mismatched} locked=${r.skippedLocked} timedOut=${r.skippedTimeout}`)
            .join("; ")}`,
        );
      }
    } catch (err) {
      console.error("[Runs Service] rollup min/max repair failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), FIRST_PASS_DELAY_MS).unref();
  setInterval(() => void tick(), REPAIR_INTERVAL_MS).unref();
}
