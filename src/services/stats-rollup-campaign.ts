// Read + rebuild side of the (campaign, UTC day) rollup maintained by the
// triggers in migration 0037.
//
// It serves the campaign-FAMILY reads features-service makes on every campaign
// Overview refresh — the dated spend and the totals of a set of stored campaign
// rows, combined or per row:
//   GET /v1/stats/public/costs/timeseries  (interval day|week|month, tz UTC,
//                                           optional groupBy=campaignId)
//   GET /v1/stats/public/costs              (groupBy campaignId | workflowSlug |
//                                           workflowDynastySlug | featureSlug)
// when the request carries a campaign filter (`campaignId` and/or
// `campaignIds`) and otherwise only filters the rollup carries exactly: orgId,
// brandId, featureSlug(s), workflowSlugs (incl. a resolved dynasty), costSource.
// A taskName, a startedAfter / startedBefore bound or a non-UTC tz keeps the
// live query — the rollup has no task and no finer time than a UTC day, and
// serving them from it would answer a different question.
//
// Same byte-identity rules as the 0034 rollup: money renders `'0'` when no row of
// that status matched and `round(sum, 10)::text` otherwise, so an ORDER BY on the
// text matches the live query's.

import { sql, type SQL } from "drizzle-orm";
import type postgres from "postgres";
import { db } from "../db/index.js";
import { money, rebuildRollup } from "./stats-rollup.js";

export const CAMPAIGN_DAY_ROLLUP_NAME = "campaign_day";

/** Public-costs groupBy keys this rollup can serve, mapped to its column. */
export const CAMPAIGN_ROLLUP_GROUP_BY_COLUMNS: Record<string, string> = {
  campaignId: "campaign_id",
  workflowSlug: "workflow_slug",
  featureSlug: "feature_slug",
};

export interface CampaignRollupFilters {
  orgId?: string;
  brandId?: string;
  campaignId?: string;
  campaignIds?: string[];
  featureSlugs?: string[];
  workflowSlugs?: string[];
}

function whereParts(f: CampaignRollupFilters): SQL[] {
  const parts: SQL[] = [];
  if (f.orgId) parts.push(sql`organization_id = ${f.orgId}`);
  if (f.brandId) parts.push(sql`${f.brandId} = ANY(brand_ids)`);
  if (f.campaignId) parts.push(sql`campaign_id = ${f.campaignId}`);
  if (f.campaignIds && f.campaignIds.length > 0) {
    parts.push(sql`campaign_id IN (${sql.join(f.campaignIds.map((c) => sql`${c}`), sql`, `)})`);
  }
  if (f.featureSlugs && f.featureSlugs.length > 0) {
    parts.push(sql`feature_slug IN (${sql.join(f.featureSlugs.map((s) => sql`${s}`), sql`, `)})`);
  }
  if (f.workflowSlugs && f.workflowSlugs.length > 0) {
    parts.push(sql`workflow_slug IN (${sql.join(f.workflowSlugs.map((s) => sql`${s}`), sql`, `)})`);
  }
  return parts;
}

function whereSql(parts: SQL[]): SQL {
  return parts.length > 0 ? sql`WHERE ${sql.join(parts, sql` AND `)}` : sql``;
}

const MONEY_COLUMNS = sql.raw(`
  ${money("n_actual + n_provisioned", "gross_actual + gross_provisioned")} AS total_cost,
  ${money("n_actual", "gross_actual")} AS actual_cost,
  ${money("n_provisioned", "gross_provisioned")} AS provisioned_cost,
  ${money("n_cancelled", "gross_cancelled")} AS cancelled_cost,
  ${money("n_refunded", "gross_refunded")} AS refunded_cost,
  ${money("n_actual + n_provisioned", "net_actual + net_provisioned")} AS net_total_cost,
  ${money("n_actual", "net_actual")} AS net_actual_cost,
  ${money("n_provisioned", "net_provisioned")} AS net_provisioned_cost,
  ${money("n_refunded", "net_refunded")} AS net_refunded_cost
`);

const MONEY_OUT = sql.raw(`
  COALESCE(s.total_cost, '0')            AS total_cost,
  COALESCE(s.actual_cost, '0')           AS actual_cost,
  COALESCE(s.provisioned_cost, '0')      AS provisioned_cost,
  COALESCE(s.cancelled_cost, '0')        AS cancelled_cost,
  COALESCE(s.refunded_cost, '0')         AS refunded_cost,
  COALESCE(s.net_total_cost, '0')        AS net_total_cost,
  COALESCE(s.net_actual_cost, '0')       AS net_actual_cost,
  COALESCE(s.net_provisioned_cost, '0')  AS net_provisioned_cost,
  COALESCE(s.net_refunded_cost, '0')     AS net_refunded_cost
`);

const ANY_COST_ROW = sql.raw(`HAVING SUM(n_actual + n_provisioned + n_cancelled + n_refunded) > 0`);

/**
 * Dated buckets, same row shape as the live timeseries query: `period`
 * (YYYY-MM-DD, UTC), optionally `campaign_id`, the nine money columns as TEXT
 * and `run_count`, ordered by period (then campaign) ascending.
 */
export async function readCampaignTimeseriesFromRollup(opts: {
  interval: string;
  groupByCampaign: boolean;
  filters: CampaignRollupFilters;
  costSource?: string;
}): Promise<any[]> {
  const parts = whereParts(opts.filters);
  const costParts = [...parts];
  if (opts.costSource) costParts.push(sql`cost_source = ${opts.costSource}`);
  const period = sql`to_char(date_trunc(${opts.interval}, day::timestamp), 'YYYY-MM-DD')`;
  const dims = opts.groupByCampaign ? sql`${period} AS period, campaign_id` : sql`${period} AS period`;
  const groupCols = opts.groupByCampaign ? sql`1, 2` : sql`1`;
  const campaignOut = opts.groupByCampaign ? sql`, c.campaign_id` : sql``;
  const campaignJoin = opts.groupByCampaign ? sql` AND s.campaign_id = c.campaign_id` : sql``;

  const result = await db.execute(sql`
    WITH counts AS (
      SELECT ${dims}, SUM(run_count)::bigint AS run_count
      FROM stats_rollup_campaign_runs
      ${whereSql(parts)}
      GROUP BY ${groupCols}
      HAVING SUM(run_count) > 0
    ),
    sums AS (
      SELECT ${dims}, ${MONEY_COLUMNS}
      FROM stats_rollup_campaign_costs
      ${whereSql(costParts)}
      GROUP BY ${groupCols}
      ${ANY_COST_ROW}
    )
    SELECT c.period ${campaignOut}, ${MONEY_OUT}, c.run_count
    FROM counts c
    LEFT JOIN sums s ON s.period = c.period ${campaignJoin}
    ORDER BY ${groupCols}
  `);
  return result as unknown as any[];
}

/**
 * Untimed groups, same row shape as the live public-costs query: the dimension
 * under `resultCol`, the nine money columns as TEXT and `run_count`, ordered by
 * `total_cost` (text) DESC.
 */
export async function readCampaignCostsFromRollup(opts: {
  groupBy: string;
  resultCol: string;
  filters: CampaignRollupFilters;
  costSource?: string;
}): Promise<any[]> {
  const col = sql.raw(CAMPAIGN_ROLLUP_GROUP_BY_COLUMNS[opts.groupBy]);
  const parts = whereParts(opts.filters);
  const costParts = [...parts];
  if (opts.costSource) costParts.push(sql`cost_source = ${opts.costSource}`);

  const result = await db.execute(sql`
    WITH counts AS (
      SELECT ${col} AS dim, SUM(run_count)::int AS run_count
      FROM stats_rollup_campaign_runs
      ${whereSql(parts)}
      GROUP BY 1
      HAVING SUM(run_count) > 0
    ),
    sums AS (
      SELECT ${col} AS dim, ${MONEY_COLUMNS}
      FROM stats_rollup_campaign_costs
      ${whereSql(costParts)}
      GROUP BY 1
      ${ANY_COST_ROW}
    )
    SELECT c.dim AS ${sql.raw(opts.resultCol)}, ${MONEY_OUT}, c.run_count
    FROM counts c
    LEFT JOIN sums s ON s.dim IS NOT DISTINCT FROM c.dim
    ORDER BY total_cost DESC
  `);
  return result as unknown as any[];
}

const KEY = "campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug";

/**
 * Rebuild the campaign_day rollup from the ledger and stamp it ready (see
 * rebuildRollup for the lock / snapshot protocol). Only runs with a campaign.
 */
export async function rebuildCampaignDayRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: CAMPAIGN_DAY_ROLLUP_NAME,
    tables: ["stats_rollup_campaign_runs", "stats_rollup_campaign_costs"],
    aggregate: async (b: postgres.Sql) => {
      await b`
        CREATE TEMP TABLE rebuild_campaign_runs ON COMMIT PRESERVE ROWS AS
        SELECT campaign_id, (started_at AT TIME ZONE 'UTC')::date AS day, organization_id, brand_ids,
          feature_slug, workflow_slug, count(*) AS run_count
        FROM runs
        WHERE campaign_id IS NOT NULL
        GROUP BY 1, 2, 3, 4, 5, 6
      `;
      await b`
        CREATE TEMP TABLE rebuild_campaign_costs ON COMMIT PRESERVE ROWS AS
        SELECT r.campaign_id, (r.started_at AT TIME ZONE 'UTC')::date AS day, r.organization_id, r.brand_ids,
          r.feature_slug, r.workflow_slug, rc.cost_source,
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
        WHERE r.campaign_id IS NOT NULL
          AND rc.status IN ('actual', 'provisioned', 'cancelled', 'refunded')
        GROUP BY 1, 2, 3, 4, 5, 6, 7
      `;
    },
    merge: async (tx: postgres.Sql) => {
      const runGroups = await tx.unsafe(`
        INSERT INTO stats_rollup_campaign_runs (${KEY}, run_count)
        SELECT ${KEY}, run_count FROM rebuild_campaign_runs
        ON CONFLICT ON CONSTRAINT stats_rollup_campaign_runs_key
        DO UPDATE SET run_count = stats_rollup_campaign_runs.run_count + EXCLUDED.run_count
      `);
      const costGroups = await tx.unsafe(`
        INSERT INTO stats_rollup_campaign_costs (
          ${KEY}, cost_source,
          n_actual, n_provisioned, n_cancelled, n_refunded,
          gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
          net_actual, net_provisioned, net_refunded
        )
        SELECT ${KEY}, cost_source,
          n_actual, n_provisioned, n_cancelled, n_refunded,
          gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
          net_actual, net_provisioned, net_refunded
        FROM rebuild_campaign_costs
        ON CONFLICT ON CONSTRAINT stats_rollup_campaign_costs_key DO UPDATE SET
          n_actual          = stats_rollup_campaign_costs.n_actual          + EXCLUDED.n_actual,
          n_provisioned     = stats_rollup_campaign_costs.n_provisioned     + EXCLUDED.n_provisioned,
          n_cancelled       = stats_rollup_campaign_costs.n_cancelled       + EXCLUDED.n_cancelled,
          n_refunded        = stats_rollup_campaign_costs.n_refunded        + EXCLUDED.n_refunded,
          gross_actual      = stats_rollup_campaign_costs.gross_actual      + EXCLUDED.gross_actual,
          gross_provisioned = stats_rollup_campaign_costs.gross_provisioned + EXCLUDED.gross_provisioned,
          gross_cancelled   = stats_rollup_campaign_costs.gross_cancelled   + EXCLUDED.gross_cancelled,
          gross_refunded    = stats_rollup_campaign_costs.gross_refunded    + EXCLUDED.gross_refunded,
          net_actual        = stats_rollup_campaign_costs.net_actual        + EXCLUDED.net_actual,
          net_provisioned   = stats_rollup_campaign_costs.net_provisioned   + EXCLUDED.net_provisioned,
          net_refunded      = stats_rollup_campaign_costs.net_refunded      + EXCLUDED.net_refunded
      `);
      await tx`DROP TABLE rebuild_campaign_runs, rebuild_campaign_costs`;
      return { runGroups: runGroups.count, costGroups: costGroups.count };
    },
  });
}
