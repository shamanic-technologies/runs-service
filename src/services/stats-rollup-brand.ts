// Brand-history cost reads served from the (campaign, UTC day) rollup, which
// migration 0041 extended to every run (campaign or not) and to exact min/max
// started_at per run group.
//
// Served (when the `campaign_day` stamp is present):
//   GET /v1/stats/costs              org-scoped; groupBy ⊆ {workflowSlug,
//                                    workflowDynastySlug, campaignId, featureSlug};
//                                    filters ⊆ {brandId, campaignId(s),
//                                    featureSlug(s), workflowSlug(s) / dynasty,
//                                    startedAfter, startedBefore}
//   GET /v1/stats/public/costs/timeseries   tz UTC, no taskName; any other filter
//                                    the rollup carries, bounds included
// features-service asks the first one for a brand's whole history (or its two
// halves, before / after a UTC midnight) several times a minute; live, each call
// scanned the brand's 500k+ runs and their cost rows.
//
// EXACTNESS. Every rollup row is one (campaign, UTC day, org, brand set, feature,
// workflow) group, so every filter above is an exact predicate on a row, and
// the run-side groupings are its columns. Time bounds cut through at most two
// UTC days (the days holding startedAfter / startedBefore). Each such day is
// served from the rollup when the part the bound excludes holds no run of the
// org (always the case for the UTC-midnight bounds features-service sends),
// otherwise it is read LIVE from the ledger with the exact bound. A day holding a
// run group whose min/max went stale (a run was removed from it) is also read
// live when the read returns min/max. Rollup days and live days are disjoint, in
// one statement (one snapshot), so every run counts once.
//
// BYTE-IDENTITY. Same rules as 0034 / 0037: each status carries its matched-row
// count beside its sums, and money renders `'0'` when no row of that status
// matched and `round(sum, 10)::text` otherwise — the text the live
// `SUM(CASE … ELSE 0 END)::text` produces, which matters because both reads
// ORDER BY it. Parity guard: tests/integration/stats-rollup-brand.test.ts.

import { sql, type SQL } from "drizzle-orm";
import { statsDb } from "../db/index.js";
import { money } from "./stats-rollup.js";

export interface BrandRollupFilters {
  orgId?: string;
  brandId?: string;
  campaignId?: string;
  campaignIds?: string[];
  featureSlugs?: string[];
  workflowSlugs?: string[];
}

/** One grouping dimension: its expression on a rollup row and on a live `runs r` row. */
export interface BrandRollupDim {
  rollup: string;
  live: string;
}

/** Org-scoped GET /v1/stats/costs groupBy keys the rollup can serve. */
export const BRAND_ROLLUP_GROUP_BY: Record<string, BrandRollupDim> = {
  workflowSlug: { rollup: "workflow_slug", live: "r.workflow_slug" },
  campaignId: { rollup: "campaign_id", live: "r.campaign_id" },
  featureSlug: { rollup: "feature_slug", live: "r.feature_slug" },
};

function inList(col: string, values: string[]): SQL {
  return sql`${sql.raw(col)} IN (${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
}

/** Filter predicates, on the rollup (`prefix` "") or on `runs r` (`prefix` "r."). */
function filterParts(f: BrandRollupFilters, prefix: string): SQL[] {
  const p = (c: string) => `${prefix}${c}`;
  const parts: SQL[] = [];
  if (f.orgId) parts.push(sql`${sql.raw(p("organization_id"))} = ${f.orgId}`);
  if (f.brandId) parts.push(sql`${f.brandId} = ANY(${sql.raw(p("brand_ids"))})`);
  if (f.campaignId) parts.push(sql`${sql.raw(p("campaign_id"))} = ${f.campaignId}`);
  if (f.campaignIds && f.campaignIds.length > 0) parts.push(inList(p("campaign_id"), f.campaignIds));
  if (f.featureSlugs && f.featureSlugs.length > 0) parts.push(inList(p("feature_slug"), f.featureSlugs));
  if (f.workflowSlugs && f.workflowSlugs.length > 0) parts.push(inList(p("workflow_slug"), f.workflowSlugs));
  return parts;
}

function and(parts: SQL[]): SQL {
  return parts.length > 0 ? sql.join(parts, sql` AND `) : sql`TRUE`;
}

const UTC_DAY_START = (day: SQL) => sql`((${day})::timestamp AT TIME ZONE 'UTC')`;

/**
 * Grouped run counts + money over the rollup (plus the live days, see the file
 * header). Returns one row per group: `d0..dn` renamed to `outNames`, the nine
 * money columns as TEXT, `run_count` and, with `minMax`, `min_started_at` /
 * `max_started_at`. Groups with no run are absent. `orderBy` is applied as given
 * (it may name the output columns).
 */
export async function readBrandRollupGroups(opts: {
  dims: BrandRollupDim[];
  outNames: string[];
  filters: BrandRollupFilters;
  startedAfter?: string;
  startedBefore?: string;
  costSource?: string;
  minMax: boolean;
  orderBy: string;
}): Promise<any[]> {
  const { dims, filters, startedAfter: sa, startedBefore: sb } = opts;
  const dayA = sa ? sql`(${sa}::timestamptz AT TIME ZONE 'UTC')::date` : null;
  const dayB = sb ? sql`(${sb}::timestamptz AT TIME ZONE 'UTC')::date` : null;

  const rollupWhere = filterParts(filters, "");
  const liveWhere = filterParts(filters, "r.");
  if (sa) liveWhere.push(sql`r.started_at >= ${sa}::timestamptz`);
  if (sb) liveWhere.push(sql`r.started_at <= ${sb}::timestamptz`);
  const dayRange: SQL[] = [];
  if (dayA) dayRange.push(sql`day >= ${dayA}`);
  if (dayB) dayRange.push(sql`day <= ${dayB}`);

  // Days read from the ledger instead of the rollup.
  const liveDaySources: SQL[] = [];
  if (dayA) {
    // The bound excludes [day start, startedAfter): live only if a run sits there.
    liveDaySources.push(sql`
      SELECT ${dayA} AS d WHERE EXISTS (
        SELECT 1 FROM runs r
        WHERE ${and(filterParts(filters, "r."))}
          AND r.started_at >= ${UTC_DAY_START(dayA)} AND r.started_at < ${sa}::timestamptz
      )`);
  }
  if (dayB) {
    // The bound excludes (startedBefore, next day start).
    liveDaySources.push(sql`
      SELECT ${dayB} AS d WHERE EXISTS (
        SELECT 1 FROM runs r
        WHERE ${and(filterParts(filters, "r."))}
          AND r.started_at > ${sb}::timestamptz AND r.started_at < ${UTC_DAY_START(sql`${dayB} + 1`)}
      )`);
  }
  if (opts.minMax) {
    liveDaySources.push(sql`
      SELECT DISTINCT day AS d FROM stats_rollup_campaign_runs
      WHERE ${and([...rollupWhere, ...dayRange, sql`minmax_stale`, sql`run_count <> 0`])}`);
  }
  const liveDays = liveDaySources.length > 0
    ? sql.join(liveDaySources, sql` UNION `)
    : sql`SELECT NULL::date AS d WHERE FALSE`;

  const rollupRows = and([...rollupWhere, ...dayRange, sql`day NOT IN (SELECT d FROM live_days)`]);
  const liveRuns = (select: SQL, join: SQL) => sql`
    FROM live_days ld CROSS JOIN LATERAL (
      SELECT ${select}
      FROM runs r ${join}
      WHERE ${and(liveWhere)}
        AND r.started_at >= ${UTC_DAY_START(sql`ld.d`)}
        AND r.started_at < ${UTC_DAY_START(sql`ld.d + 1`)}
    ) x`;

  const n = dims.length;
  const idx = [...Array(n).keys()];
  const dimNames = sql.raw(idx.map((i) => `d${i}`).join(", "));
  const groupRefs = sql.raw(idx.map((i) => `${i + 1}`).join(", "));
  const rollupDims = sql.raw(dims.map((d, i) => `${d.rollup} AS d${i}`).join(", "));
  const liveDims = sql.raw(dims.map((d, i) => `${d.live} AS d${i}`).join(", "));
  const costSourceRollup = opts.costSource ? sql` AND cost_source = ${opts.costSource}` : sql``;
  const costSourceLive = opts.costSource ? sql` AND rc.cost_source = ${opts.costSource}` : sql``;

  const minMaxRolled = opts.minMax
    ? sql`, MIN(min_started_at) FILTER (WHERE run_count > 0) AS mn, MAX(max_started_at) FILTER (WHERE run_count > 0) AS mx`
    : sql``;
  const minMaxLive = opts.minMax ? sql`, MIN(x.started_at) AS mn, MAX(x.started_at) AS mx` : sql``;
  const minMaxCounts = opts.minMax ? sql`, MIN(mn) AS min_started_at, MAX(mx) AS max_started_at` : sql``;
  const minMaxOut = opts.minMax ? sql`, c.min_started_at, c.max_started_at` : sql``;

  const statusCount = (s: string) => sql.raw(`count(*) FILTER (WHERE x.status = '${s}')`);
  const statusSum = (col: string, s: string) => sql.raw(`COALESCE(SUM(x.${col}) FILTER (WHERE x.status = '${s}'), 0)`);

  const joinOn = sql.raw(idx.map((i) => `s.d${i} IS NOT DISTINCT FROM c.d${i}`).join(" AND "));
  const outCols = sql.raw(idx.map((i) => `c.d${i} AS "${opts.outNames[i]}"`).join(", "));

  const query = sql`
    WITH live_days AS (${liveDays}),
    rolled_counts AS (
      SELECT ${rollupDims}, SUM(run_count) AS n ${minMaxRolled}
      FROM stats_rollup_campaign_runs
      WHERE ${rollupRows}
      GROUP BY ${groupRefs}
    ),
    live_counts AS (
      SELECT ${dimNames}, COUNT(*) AS n ${minMaxLive}
      ${liveRuns(sql`${liveDims}, r.started_at`, sql``)}
      GROUP BY ${groupRefs}
    ),
    counts AS (
      SELECT ${dimNames}, SUM(n) AS run_count ${minMaxCounts}
      FROM (SELECT * FROM rolled_counts UNION ALL SELECT * FROM live_counts) u
      GROUP BY ${groupRefs}
      HAVING SUM(n) > 0
    ),
    rolled_sums AS (
      SELECT ${rollupDims},
        SUM(n_actual) AS n_actual, SUM(n_provisioned) AS n_provisioned,
        SUM(n_cancelled) AS n_cancelled, SUM(n_refunded) AS n_refunded,
        SUM(gross_actual) AS gross_actual, SUM(gross_provisioned) AS gross_provisioned,
        SUM(gross_cancelled) AS gross_cancelled, SUM(gross_refunded) AS gross_refunded,
        SUM(net_actual) AS net_actual, SUM(net_provisioned) AS net_provisioned, SUM(net_refunded) AS net_refunded
      FROM stats_rollup_campaign_costs
      WHERE ${rollupRows} ${costSourceRollup}
      GROUP BY ${groupRefs}
    ),
    live_sums AS (
      SELECT ${dimNames},
        ${statusCount("actual")} AS n_actual, ${statusCount("provisioned")} AS n_provisioned,
        ${statusCount("cancelled")} AS n_cancelled, ${statusCount("refunded")} AS n_refunded,
        ${statusSum("gross", "actual")} AS gross_actual, ${statusSum("gross", "provisioned")} AS gross_provisioned,
        ${statusSum("gross", "cancelled")} AS gross_cancelled, ${statusSum("gross", "refunded")} AS gross_refunded,
        ${statusSum("net", "actual")} AS net_actual, ${statusSum("net", "provisioned")} AS net_provisioned,
        ${statusSum("net", "refunded")} AS net_refunded
      ${liveRuns(
        sql`${liveDims}, rc.status, rc.total_cost_in_usd_cents AS gross,
          COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) AS net`,
        sql`INNER JOIN runs_costs rc ON rc.run_id = r.id ${costSourceLive}`,
      )}
      GROUP BY ${groupRefs}
    ),
    sums AS (
      SELECT ${dimNames},
        ${sql.raw(money("n_actual + n_provisioned", "gross_actual + gross_provisioned"))} AS total_cost,
        ${sql.raw(money("n_actual", "gross_actual"))} AS actual_cost,
        ${sql.raw(money("n_provisioned", "gross_provisioned"))} AS provisioned_cost,
        ${sql.raw(money("n_cancelled", "gross_cancelled"))} AS cancelled_cost,
        ${sql.raw(money("n_refunded", "gross_refunded"))} AS refunded_cost,
        ${sql.raw(money("n_actual + n_provisioned", "net_actual + net_provisioned"))} AS net_total_cost,
        ${sql.raw(money("n_actual", "net_actual"))} AS net_actual_cost,
        ${sql.raw(money("n_provisioned", "net_provisioned"))} AS net_provisioned_cost,
        ${sql.raw(money("n_refunded", "net_refunded"))} AS net_refunded_cost
      FROM (SELECT * FROM rolled_sums UNION ALL SELECT * FROM live_sums) u
      GROUP BY ${groupRefs}
      HAVING SUM(n_actual + n_provisioned + n_cancelled + n_refunded) > 0
    )
    SELECT ${outCols},
      COALESCE(s.total_cost, '0')            AS total_cost,
      COALESCE(s.actual_cost, '0')           AS actual_cost,
      COALESCE(s.provisioned_cost, '0')      AS provisioned_cost,
      COALESCE(s.cancelled_cost, '0')        AS cancelled_cost,
      COALESCE(s.refunded_cost, '0')         AS refunded_cost,
      COALESCE(s.net_total_cost, '0')        AS net_total_cost,
      COALESCE(s.net_actual_cost, '0')       AS net_actual_cost,
      COALESCE(s.net_provisioned_cost, '0')  AS net_provisioned_cost,
      COALESCE(s.net_refunded_cost, '0')     AS net_refunded_cost,
      c.run_count ${minMaxOut}
    FROM counts c
    LEFT JOIN sums s ON ${joinOn}
    ORDER BY ${sql.raw(opts.orderBy)}
  `;
  return (await statsDb.execute(query)) as unknown as any[];
}
