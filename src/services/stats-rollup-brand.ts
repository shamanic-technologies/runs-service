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
//
// AUDIENCE (migration 0052, `rollup: "audience"`). Same reads with audienceId
// grouped on, from the (… , audience) twin tables: features-service's per-audience
// x workflow spend. The audience is the cost row's (COALESCE run's), so a run
// counts once per distinct audience of its cost rows; live days count DISTINCT
// runs over the LEFT JOIN like the live query. Parity guard:
// tests/integration/stats-rollup-audience.test.ts.
//
// COST NAME (migration 0053, `rollup: "costName"`). Same reads with costName
// grouped on, from one (… , cost name) table carrying run count, min/max and
// money: features-service's brand spend breakdown. A run counts once per distinct
// cost name of its cost rows and not at all without one (the live INNER JOIN);
// `quantity` adds the live totalQuantity. Parity guard:
// tests/integration/stats-rollup-cost-name.test.ts.

import { sql, type SQL } from "drizzle-orm";
import type postgres from "postgres";
import { statsDb } from "../db/index.js";
import { money, rebuildRollup } from "./stats-rollup.js";

export interface BrandRollupFilters {
  orgId?: string;
  brandId?: string;
  campaignId?: string;
  campaignIds?: string[];
  featureSlugs?: string[];
  workflowSlugs?: string[];
  /** true = runs carrying a campaign only, false = runs with none (migration 0045's rule). */
  hasCampaign?: boolean;
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

export const AUDIENCE_DAY_ROLLUP_NAME = "audience_day";

/**
 * Org-scoped GET /v1/stats/costs groupBy keys the AUDIENCE rollup (migration 0052)
 * serves; `audienceId` must be one of them. The audience is a cost-row dimension
 * (COALESCE(rc.audience_id, r.audience_id)): one run can sit in several groups, so
 * the live days count DISTINCT runs over the LEFT JOIN, exactly as the live query.
 */
export const AUDIENCE_ROLLUP_GROUP_BY: Record<string, BrandRollupDim> = {
  ...BRAND_ROLLUP_GROUP_BY,
  audienceId: { rollup: "audience_id", live: "COALESCE(rc.audience_id, r.audience_id)" },
};

export const COST_NAME_DAY_ROLLUP_NAME = "cost_name_day";

/**
 * Org-scoped GET /v1/stats/costs groupBy keys the COST NAME rollup (migration 0053)
 * serves; `costName` must be one of them. A cost-row dimension: one run sits in one
 * group per distinct cost name of its rows, none without a row (the live INNER JOIN).
 */
export const COST_NAME_ROLLUP_GROUP_BY: Record<string, BrandRollupDim> = {
  ...BRAND_ROLLUP_GROUP_BY,
  costName: { rollup: "cost_name", live: "rc.cost_name" },
};

// The cost-name rollup is ONE table: each row carries the run count + min/max AND the money.
const ROLLUP_TABLES = {
  campaign: { runs: "stats_rollup_campaign_runs", costs: "stats_rollup_campaign_costs" },
  audience: { runs: "stats_rollup_audience_runs", costs: "stats_rollup_audience_costs" },
  costName: { runs: "stats_rollup_cost_name_day", costs: "stats_rollup_cost_name_day" },
} as const;

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
  if (f.hasCampaign !== undefined) parts.push(sql.raw(`${p("campaign_id")} IS ${f.hasCampaign ? "NOT NULL" : "NULL"}`));
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
  /**
   * "audience" = the 0052 tables, with the audience dimension; "costName" = the 0053
   * table, with the cost name dimension and `total_quantity` (default "campaign").
   */
  rollup?: keyof typeof ROLLUP_TABLES;
}): Promise<any[]> {
  const { dims, filters, startedAfter: sa, startedBefore: sb } = opts;
  const audience = opts.rollup === "audience";
  const costName = opts.rollup === "costName";
  const tables = ROLLUP_TABLES[opts.rollup ?? "campaign"];
  if ((audience || costName) && opts.costSource) throw new Error(`the ${opts.rollup} rollup carries no cost_source`);
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
      SELECT DISTINCT day AS d FROM ${sql.raw(tables.runs)}
      WHERE ${and([...rollupWhere, ...dayRange, sql`minmax_stale`, sql`run_count <> 0`])}`);
  }
  const liveDays = liveDaySources.length > 0
    ? sql.join(liveDaySources, sql` UNION `)
    : sql`SELECT NULL::date AS d WHERE FALSE`;

  const rollupRows = and([...rollupWhere, ...dayRange, sql`day NOT IN (SELECT d FROM live_days)`]);
  // `OFFSET 0` keeps the LATERAL a per-day subquery (an optimisation fence). Without
  // it Postgres pulls the subquery up, turns the day bounds into a join filter, and
  // builds the brand's WHOLE bounded history joined to runs_costs before looking at
  // live_days, which is almost always EMPTY: 17.6 s for brand f4d73dab with 25
  // feature slugs and startedBefore (statement timeouts, 2026-10-21). Fenced, each
  // live day is an index range scan on started_at, and no live day = no scan.
  const liveRuns = (select: SQL, join: SQL) => sql`
    FROM live_days ld CROSS JOIN LATERAL (
      SELECT ${select}
      FROM runs r ${join}
      WHERE ${and(liveWhere)}
        AND r.started_at >= ${UTC_DAY_START(sql`ld.d`)}
        AND r.started_at < ${UTC_DAY_START(sql`ld.d + 1`)}
      OFFSET 0
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
  // Live run count: a run sits in one campaign-rollup group, but in one audience
  // group per distinct effective audience of its cost rows (the live query's
  // LEFT JOIN + COUNT(DISTINCT r.id)); in one cost-name group per distinct cost
  // name of its rows, none without a row (INNER JOIN).
  const liveCount = audience || costName ? sql`COUNT(DISTINCT x.run_id)` : sql`COUNT(*)`;
  const liveCountJoin = audience
    ? sql`LEFT JOIN runs_costs rc ON rc.run_id = r.id`
    : costName ? sql`INNER JOIN runs_costs rc ON rc.run_id = r.id` : sql``;
  const quantityRolled = costName ? sql`, SUM(quantity) AS quantity` : sql``;
  const quantityLive = costName ? sql`, COALESCE(SUM(x.quantity), 0) AS quantity` : sql``;
  const quantitySum = costName ? sql`, SUM(quantity) AS total_quantity` : sql``;
  const quantityOut = costName ? sql`, COALESCE(s.total_quantity, 0) AS total_quantity` : sql``;
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
      FROM ${sql.raw(tables.runs)}
      WHERE ${rollupRows}
      GROUP BY ${groupRefs}
    ),
    live_counts AS (
      SELECT ${dimNames}, ${liveCount} AS n ${minMaxLive}
      ${liveRuns(sql`${liveDims}, r.id AS run_id, r.started_at`, liveCountJoin)}
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
        ${quantityRolled}
      FROM ${sql.raw(tables.costs)}
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
        ${quantityLive}
      ${liveRuns(
        sql`${liveDims}, rc.status, rc.total_cost_in_usd_cents AS gross,
          COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) AS net, rc.quantity::numeric AS quantity`,
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
        ${quantitySum}
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
      c.run_count ${minMaxOut} ${quantityOut}
    FROM counts c
    LEFT JOIN sums s ON ${joinOn}
    ORDER BY ${sql.raw(opts.orderBy)}
  `;
  return (await statsDb.execute(query)) as unknown as any[];
}

const AUDIENCE_KEY = "campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, audience_id";

/**
 * Rebuild the audience_day rollup (migration 0052) from the ledger and stamp it
 * ready (see rebuildRollup for the lock / snapshot protocol). A run counts once
 * per distinct effective audience of its cost rows (its own audience when it has
 * none), with exact min/max. A group a trigger marked stale meanwhile stays stale.
 */
export async function rebuildAudienceDayRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: AUDIENCE_DAY_ROLLUP_NAME,
    tables: [ROLLUP_TABLES.audience.runs, ROLLUP_TABLES.audience.costs],
    aggregate: async (b: postgres.Sql) => {
      await b`
        CREATE TEMP TABLE rebuild_audience_runs ON COMMIT PRESERVE ROWS AS
        SELECT campaign_id, (started_at AT TIME ZONE 'UTC')::date AS day, organization_id, brand_ids,
          feature_slug, workflow_slug, audience_id, count(*) AS run_count,
          min(started_at) AS min_started_at, max(started_at) AS max_started_at
        FROM (
          SELECT r.campaign_id, r.started_at, r.organization_id, r.brand_ids, r.feature_slug, r.workflow_slug,
            COALESCE(rc.audience_id, r.audience_id) AS audience_id
          FROM runs r
          LEFT JOIN runs_costs rc ON rc.run_id = r.id
          GROUP BY r.id, COALESCE(rc.audience_id, r.audience_id)
        ) m
        GROUP BY 1, 2, 3, 4, 5, 6, 7
      `;
      await b`
        CREATE TEMP TABLE rebuild_audience_costs ON COMMIT PRESERVE ROWS AS
        SELECT r.campaign_id, (r.started_at AT TIME ZONE 'UTC')::date AS day, r.organization_id, r.brand_ids,
          r.feature_slug, r.workflow_slug, COALESCE(rc.audience_id, r.audience_id) AS audience_id,
          count(*) FILTER (WHERE rc.status = 'actual')      AS n_actual,
          count(*) FILTER (WHERE rc.status = 'provisioned') AS n_provisioned,
          count(*) FILTER (WHERE rc.status = 'cancelled')   AS n_cancelled,
          count(*) FILTER (WHERE rc.status = 'refunded')    AS n_refunded,
          COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'actual'), 0)      AS gross_actual,
          COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'provisioned'), 0) AS gross_provisioned,
          COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'cancelled'), 0)   AS gross_cancelled,
          COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'refunded'), 0)    AS gross_refunded,
          COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'actual'), 0)      AS net_actual,
          COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'provisioned'), 0) AS net_provisioned,
          COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'refunded'), 0)    AS net_refunded
        FROM runs_costs rc
        JOIN runs r ON r.id = rc.run_id
        WHERE rc.status IN ('actual', 'provisioned', 'cancelled', 'refunded')
        GROUP BY 1, 2, 3, 4, 5, 6, 7
      `;
    },
    merge: async (tx: postgres.Sql) => {
      const runGroups = await tx.unsafe(`
        INSERT INTO stats_rollup_audience_runs (${AUDIENCE_KEY}, run_count, min_started_at, max_started_at, minmax_stale)
        SELECT ${AUDIENCE_KEY}, run_count, min_started_at, max_started_at, false FROM rebuild_audience_runs
        ON CONFLICT ON CONSTRAINT stats_rollup_audience_runs_key DO UPDATE SET
          run_count      = stats_rollup_audience_runs.run_count + EXCLUDED.run_count,
          min_started_at = LEAST(stats_rollup_audience_runs.min_started_at, EXCLUDED.min_started_at),
          max_started_at = GREATEST(stats_rollup_audience_runs.max_started_at, EXCLUDED.max_started_at)
      `);
      const costGroups = await tx.unsafe(`
        INSERT INTO stats_rollup_audience_costs (
          ${AUDIENCE_KEY},
          n_actual, n_provisioned, n_cancelled, n_refunded,
          gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
          net_actual, net_provisioned, net_refunded
        )
        SELECT ${AUDIENCE_KEY},
          n_actual, n_provisioned, n_cancelled, n_refunded,
          gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
          net_actual, net_provisioned, net_refunded
        FROM rebuild_audience_costs
        ON CONFLICT ON CONSTRAINT stats_rollup_audience_costs_key DO UPDATE SET
          n_actual          = stats_rollup_audience_costs.n_actual          + EXCLUDED.n_actual,
          n_provisioned     = stats_rollup_audience_costs.n_provisioned     + EXCLUDED.n_provisioned,
          n_cancelled       = stats_rollup_audience_costs.n_cancelled       + EXCLUDED.n_cancelled,
          n_refunded        = stats_rollup_audience_costs.n_refunded        + EXCLUDED.n_refunded,
          gross_actual      = stats_rollup_audience_costs.gross_actual      + EXCLUDED.gross_actual,
          gross_provisioned = stats_rollup_audience_costs.gross_provisioned + EXCLUDED.gross_provisioned,
          gross_cancelled   = stats_rollup_audience_costs.gross_cancelled   + EXCLUDED.gross_cancelled,
          gross_refunded    = stats_rollup_audience_costs.gross_refunded    + EXCLUDED.gross_refunded,
          net_actual        = stats_rollup_audience_costs.net_actual        + EXCLUDED.net_actual,
          net_provisioned   = stats_rollup_audience_costs.net_provisioned   + EXCLUDED.net_provisioned,
          net_refunded      = stats_rollup_audience_costs.net_refunded      + EXCLUDED.net_refunded
      `);
      await tx`DROP TABLE rebuild_audience_runs, rebuild_audience_costs`;
      return { runGroups: runGroups.count, costGroups: costGroups.count };
    },
  });
}

const COST_NAME_KEY = "campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, cost_name";

/**
 * Rebuild the cost_name_day rollup (migration 0053) from the ledger and stamp it
 * ready (see rebuildRollup for the lock / snapshot protocol). A run counts once
 * per distinct cost name of its cost rows, with exact min/max. A group a trigger
 * marked stale meanwhile stays stale.
 */
export async function rebuildCostNameDayRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: COST_NAME_DAY_ROLLUP_NAME,
    tables: [ROLLUP_TABLES.costName.runs],
    aggregate: async (b: postgres.Sql) => {
      await b`
        CREATE TEMP TABLE rebuild_cost_name_day ON COMMIT PRESERVE ROWS AS
        SELECT r.campaign_id, (r.started_at AT TIME ZONE 'UTC')::date AS day, r.organization_id, r.brand_ids,
          r.feature_slug, r.workflow_slug, rc.cost_name,
          count(DISTINCT r.id) AS run_count, min(r.started_at) AS min_started_at, max(r.started_at) AS max_started_at,
          count(*) FILTER (WHERE rc.status = 'actual')      AS n_actual,
          count(*) FILTER (WHERE rc.status = 'provisioned') AS n_provisioned,
          count(*) FILTER (WHERE rc.status = 'cancelled')   AS n_cancelled,
          count(*) FILTER (WHERE rc.status = 'refunded')    AS n_refunded,
          COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'actual'), 0)      AS gross_actual,
          COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'provisioned'), 0) AS gross_provisioned,
          COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'cancelled'), 0)   AS gross_cancelled,
          COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'refunded'), 0)    AS gross_refunded,
          COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'actual'), 0)      AS net_actual,
          COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'provisioned'), 0) AS net_provisioned,
          COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'refunded'), 0)    AS net_refunded,
          SUM(rc.quantity) AS quantity
        FROM runs_costs rc
        JOIN runs r ON r.id = rc.run_id
        GROUP BY 1, 2, 3, 4, 5, 6, 7
      `;
    },
    merge: async (tx: postgres.Sql) => {
      const groups = await tx.unsafe(`
        INSERT INTO stats_rollup_cost_name_day (
          ${COST_NAME_KEY}, run_count, min_started_at, max_started_at, minmax_stale,
          n_actual, n_provisioned, n_cancelled, n_refunded,
          gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
          net_actual, net_provisioned, net_refunded, quantity
        )
        SELECT ${COST_NAME_KEY}, run_count, min_started_at, max_started_at, false,
          n_actual, n_provisioned, n_cancelled, n_refunded,
          gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
          net_actual, net_provisioned, net_refunded, quantity
        FROM rebuild_cost_name_day
        ON CONFLICT ON CONSTRAINT stats_rollup_cost_name_day_key DO UPDATE SET
          run_count         = stats_rollup_cost_name_day.run_count         + EXCLUDED.run_count,
          min_started_at    = LEAST(stats_rollup_cost_name_day.min_started_at, EXCLUDED.min_started_at),
          max_started_at    = GREATEST(stats_rollup_cost_name_day.max_started_at, EXCLUDED.max_started_at),
          n_actual          = stats_rollup_cost_name_day.n_actual          + EXCLUDED.n_actual,
          n_provisioned     = stats_rollup_cost_name_day.n_provisioned     + EXCLUDED.n_provisioned,
          n_cancelled       = stats_rollup_cost_name_day.n_cancelled       + EXCLUDED.n_cancelled,
          n_refunded        = stats_rollup_cost_name_day.n_refunded        + EXCLUDED.n_refunded,
          gross_actual      = stats_rollup_cost_name_day.gross_actual      + EXCLUDED.gross_actual,
          gross_provisioned = stats_rollup_cost_name_day.gross_provisioned + EXCLUDED.gross_provisioned,
          gross_cancelled   = stats_rollup_cost_name_day.gross_cancelled   + EXCLUDED.gross_cancelled,
          gross_refunded    = stats_rollup_cost_name_day.gross_refunded    + EXCLUDED.gross_refunded,
          net_actual        = stats_rollup_cost_name_day.net_actual        + EXCLUDED.net_actual,
          net_provisioned   = stats_rollup_cost_name_day.net_provisioned   + EXCLUDED.net_provisioned,
          net_refunded      = stats_rollup_cost_name_day.net_refunded      + EXCLUDED.net_refunded,
          quantity          = stats_rollup_cost_name_day.quantity          + EXCLUDED.quantity
      `);
      await tx`DROP TABLE rebuild_cost_name_day`;
      return { runGroups: groups.count, costGroups: groups.count };
    },
  });
}
