// The outcome ledger read as TOTALS (COST-ACCOUNTING-1023-P2):
// GET /internal/stats/outcome-costs. features-service rolls up what each outcome
// costs to produce (unit cost = own cost per occurrence + Σ inputs per occurrence
// x the input's unit cost) every 15 min; paging every occurrence is not viable,
// so this reads the per-day rows the ledger refresher stores (outcome_cost_days,
// migration 0058), never the ledger itself. Every figure equals the sum of the
// matching /internal/outcome-occurrences rows (cost slices, consumption parts).

import { sql, type SQL } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { statsDb } from "../db/index.js";
import { ALLOCATION_VERSION, addDays, firstLedgerDay, staleDaysIn, supportTotal, utcDay, type Money, type SupportByFunction } from "./outcome-ledger.js";

/** Longest since..until range of the totals read (= the route's parseRange cap). */
export const MAX_RANGE_DAYS = 400;
import { SUPPORT_FUNCTIONS } from "./support-marks.js";

export const OUTCOME_COST_DIMENSIONS = [
  "outcomeKey",
  "day",
  "orgId",
  "costOrgId",
  "brandId",
  "campaignId",
  "workflowSlug",
  "featureSlug",
  // The run's audience (the one its lead was served under) and its service: the
  // declaring run (produced), the consuming run (consumed), the spending run (none).
  "audienceId",
  "serviceName",
  // UTC day the row's run STARTED: the declaring run (produced), the consuming run
  // (consumed), the spending run (scope's produced-none part).
  "runStartDay",
  // The run that PRODUCED the consumed occurrence (consumed section only): a reply
  // declared on an untagged reply-judging run is grouped by the send's workflow,
  // campaign, brand. Null = no run declared producing it (unknownProvenance) or an
  // untagged producing run.
  "sourceOrgId",
  "sourceBrandId",
  "sourceCampaignId",
  "sourceWorkflowSlug",
  "sourceFeatureSlug",
  "sourceAudienceId",
  // WHEN the consumed occurrence was produced: its declaration's UTC day, and the
  // UTC day its producing run started (a reply grouped by the day of the send it answers).
  "sourceDay",
  "sourceRunStartDay",
] as const;
export type OutcomeCostDimension = (typeof OUTCOME_COST_DIMENSIONS)[number];

const isSource = (d: OutcomeCostDimension) => d.startsWith("source");
/** Dimensions stored from migration 0067 on: a day stored before is missing for a read using them. */
const START_DAY_DIMENSIONS: readonly OutcomeCostDimension[] = ["runStartDay", "sourceDay", "sourceRunStartDay"];

/** Groups per section above which the read refuses (422) instead of truncating. */
export const MAX_OUTCOME_COST_GROUPS = 5000;

export class TooManyGroupsError extends Error {
  constructor(public readonly section: string, public readonly cap: number) {
    super(`too_many_groups: the ${section} section has more than ${cap} groups; narrow groupBy, the filters or the day range`);
  }
}

export interface OutcomeCostFilters {
  orgId?: string;
  costOrgId?: string;
  brandId?: string;
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
  audienceId?: string;
  serviceName?: string;
  outcomeKey?: string;
  /** Inclusive UTC day: only rows whose run started on or before it (every section). */
  runStartUntil?: string;
  /** Inclusive UTC days, consumed section only: the consumed occurrence declared / its producing run started on or before. */
  sourceDayUntil?: string;
  sourceRunStartUntil?: string;
}

/** The read needs rows carrying their run-start / source days (0067). */
const needsStartDays = (groupBy: OutcomeCostDimension[], f: OutcomeCostFilters) =>
  groupBy.some((d) => START_DAY_DIMENSIONS.includes(d)) || !!(f.runStartUntil || f.sourceDayUntil || f.sourceRunStartUntil);

const COLUMN: Record<Exclude<OutcomeCostDimension, "brandId" | "sourceBrandId">, string> = {
  outcomeKey: "outcome_key",
  day: "day",
  orgId: "organization_id",
  costOrgId: "cost_organization_id",
  campaignId: "campaign_id",
  workflowSlug: "workflow_slug",
  featureSlug: "feature_slug",
  audienceId: "audience_id",
  serviceName: "service_name",
  sourceAudienceId: "source_audience_id",
  sourceOrgId: "source_organization_id",
  sourceCampaignId: "source_campaign_id",
  sourceWorkflowSlug: "source_workflow_slug",
  sourceFeatureSlug: "source_feature_slug",
  runStartDay: "run_start_day",
  sourceDay: "source_day",
  sourceRunStartDay: "source_run_start_day",
};

const dimExpr = (d: OutcomeCostDimension): string =>
  d === "brandId"
    ? "x.brand_id"
    : d === "sourceBrandId"
      ? "x.source_brand_id"
      : d === "day" || d === "runStartDay" || d === "sourceDay" || d === "sourceRunStartDay"
        ? `to_char(x.${COLUMN[d]}, 'YYYY-MM-DD')`
        : `x.${COLUMN[d]}::text`;

const fx = (v: unknown) => new Decimal((v as string | null) ?? "0").toFixed(10);
const moneyOf = (r: any, p = ""): Money => ({
  gross: fx(r[`${p}gross`]),
  net: fx(r[`${p}net`]),
  vendor: fx(r[`${p}vendor`]),
  unpricedGross: fx(r[`${p}unpriced`]),
});
const MONEY_SUMS = (p = "", col = "") =>
  sql.raw(`SUM(x.${col}gross)::text AS ${p}gross, SUM(x.${col}net)::text AS ${p}net, SUM(x.${col}vendor)::text AS ${p}vendor, SUM(x.${col}unpriced_gross)::text AS ${p}unpriced`);

/**
 * Rows of outcome_cost_days in range, with filters applied. A co-branded run is
 * unnested to one row per brand only when the read groups by brand (then counted
 * under EACH brand, as every other brand read here); a brand filter alone keeps
 * one row per stored row. Same for the producing run's brands (sourceBrandId).
 * `sourced`: only days whose consumed rows carry their source (0063); `startDays`:
 * only days whose rows carry their run-start / source days (0067); the others
 * are reported in daysMissing. The source-day filters apply to the consumed
 * section only (`consumedSection`).
 */
function baseSql(
  kinds: string[],
  groupsByBrand: boolean,
  f: OutcomeCostFilters,
  since: string,
  until: string,
  outcomeCol: string | null,
  sourced: boolean,
  startDays: boolean,
  consumedSection: boolean,
  groupsBySourceBrand = false,
): SQL {
  const where: SQL[] = [
    sql`d.allocation_version = ${ALLOCATION_VERSION}`,
    sql`d.day BETWEEN ${since}::date AND ${until}::date`,
    sql`d.kind IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})`,
  ];
  if (f.orgId) where.push(sql`d.organization_id = ${f.orgId}::uuid`);
  if (f.costOrgId) where.push(sql`d.cost_organization_id = ${f.costOrgId}::uuid`);
  if (f.campaignId) where.push(sql`d.campaign_id = ${f.campaignId}`);
  if (f.workflowSlug) where.push(sql`d.workflow_slug = ${f.workflowSlug}`);
  if (f.featureSlug) where.push(sql`d.feature_slug = ${f.featureSlug}`);
  if (f.audienceId) where.push(sql`d.audience_id = ${f.audienceId}`);
  if (f.serviceName) where.push(sql`d.service_name = ${f.serviceName}`);
  if (f.outcomeKey && outcomeCol) where.push(sql`${sql.raw(`d.${outcomeCol}`)} = ${f.outcomeKey}`);
  if (f.brandId && !groupsByBrand) where.push(sql`${f.brandId} = ANY(d.brand_ids)`);
  if (f.runStartUntil) where.push(sql`d.run_start_day <= ${f.runStartUntil}::date`);
  if (consumedSection && f.sourceDayUntil) where.push(sql`d.source_day <= ${f.sourceDayUntil}::date`);
  if (consumedSection && f.sourceRunStartUntil) where.push(sql`d.source_run_start_day <= ${f.sourceRunStartUntil}::date`);
  if (sourced) {
    where.push(sql`EXISTS (SELECT 1 FROM cost_ledger_computed_days c
      WHERE c.day = d.day AND c.allocation_version = d.allocation_version AND c.consumed_sources)`);
  }
  if (startDays) {
    where.push(sql`EXISTS (SELECT 1 FROM cost_ledger_computed_days c
      WHERE c.day = d.day AND c.allocation_version = d.allocation_version AND c.start_days)`);
  }
  const brand = groupsByBrand
    ? sql`CROSS JOIN LATERAL unnest(CASE WHEN cardinality(d.brand_ids) > 0 THEN d.brand_ids ELSE ARRAY[NULL]::text[] END) AS b(brand_id)`
    : sql`CROSS JOIN LATERAL (SELECT NULL::text AS brand_id) b`;
  const sourceBrand = groupsBySourceBrand
    ? sql`CROSS JOIN LATERAL unnest(CASE WHEN cardinality(d.source_brand_ids) > 0 THEN d.source_brand_ids ELSE ARRAY[NULL]::text[] END) AS sb(source_brand_id)`
    : sql`CROSS JOIN LATERAL (SELECT NULL::text AS source_brand_id) sb`;
  const brandWhere = f.brandId && groupsByBrand ? sql` AND b.brand_id = ${f.brandId}` : sql``;
  return sql`(SELECT d.*, b.brand_id, sb.source_brand_id FROM outcome_cost_days d ${brand} ${sourceBrand} WHERE ${sql.join(where, sql` AND `)}${brandWhere}) x`;
}

/** Per support function: the 'none' rows' money carrying it (NULL when the group has none). */
const supportSums = () =>
  sql.raw(
    SUPPORT_FUNCTIONS.map((fn) =>
      ["gross", "net", "vendor", "unpriced_gross"]
        .map((c) => `SUM(x.${c}) FILTER (WHERE x.kind = 'none' AND x.support_function = '${fn}')::text AS s_${fn}_${c === "unpriced_gross" ? "unpriced" : c}`)
        .join(", "),
    ).join(",\n        "),
  );

async function grouped(section: string, dims: Array<{ name: string; expr: string }>, select: SQL, from: SQL): Promise<any[]> {
  const cols = dims.map((d) => sql.raw(`${d.expr} AS "${d.name}"`));
  const head = cols.length > 0 ? sql`${sql.join(cols, sql`, `)}, ` : sql``;
  const groupBy = dims.length > 0 ? sql.raw(`GROUP BY ${dims.map((_, i) => i + 1).join(", ")} ORDER BY ${dims.map((_, i) => `${i + 1} NULLS FIRST`).join(", ")}`) : sql``;
  const rows = (await statsDb.execute(sql`
    SELECT ${head}${select} FROM ${from} ${groupBy} LIMIT ${MAX_OUTCOME_COST_GROUPS + 1}
  `)) as any[];
  if (rows.length > MAX_OUTCOME_COST_GROUPS) throw new TooManyGroupsError(section, MAX_OUTCOME_COST_GROUPS);
  // A grouping with no dimension over no row still aggregates to one all-null row: no group.
  if (dims.length === 0 && rows.length === 1 && rows[0].n === null && rows[0].gross === null) return [];
  return rows;
}

const dimensionsOf = (r: any, names: string[]) => Object.fromEntries(names.map((n) => [n, r[n] ?? null]));

const share = (part: string, whole: string) => {
  const w = new Decimal(whole);
  return w.isZero() ? null : new Decimal(part).div(w).toDecimalPlaces(10, Decimal.ROUND_HALF_UP).toFixed(10);
};

export interface OutcomeCostTotals {
  since: string;
  until: string;
  /** Days not stored, or stored but STALE (listed apart in daysStale). */
  daysMissing: string[];
  daysStale: string[];
  produced: Array<{ dimensions: Record<string, string | null>; occurrences: number; quantity: string; cost: Money }>;
  consumed: Array<{
    dimensions: Record<string, string | null>;
    consumptions: string;
    reuses: string;
    unknownProvenance: string;
    standardCost: Money;
    reuseGain: Money;
  }>;
  scope: Array<{
    dimensions: Record<string, string | null>;
    spend: Money;
    producedCost: Money;
    producedNone: Money;
    /** Part of producedNone that is support (migration 0064), total and per function; the rest is undeclared. */
    support: Money;
    supportByFunction: SupportByFunction;
    undeclared: Money;
    /** Abnormal loss (v5) under the paying run's tags: spend = producedCost + producedNone + abnormal. */
    abnormal: Money;
    coverageShare: { gross: string | null; net: string | null };
    /** producedCost / (spend - support): coverage on outcome spend only. */
    outcomeSpendCoverageShare: { gross: string | null; net: string | null };
  }>;
  /** Days stored before the support split (support reads 0 there until recomputed). */
  supportDaysMissing: string[];
  /** v5: spend in no unit cost, per reason (dimensions carry abnormalReason). */
  abnormal: Array<{ dimensions: Record<string, string | null>; runs: string; cost: Money }>;
  /** v5: the routed spend priced in the OTHER state family (never summed with produced across keys). */
  parallel: Array<{ dimensions: Record<string, string | null>; cost: Money; unpooled: Money }>;
}

/**
 * Default `since` of the totals read ("since inception"): the first day of SPEND
 * in the ledger (firstLedgerDay), never the first day stored under the current
 * allocation version. Keyed on stored days, a version bump made the read start at
 * the first day v2 had recomputed and answer complete on 16 days of 265 ($2.4k of
 * $23k, Research served $7.41 per positive reply instead of $148, 2026-10-24).
 * Days the refresher has not stored yet now read as daysMissing. Capped to the
 * read's 400-day range.
 */
export async function firstOutcomeCostDay(): Promise<string> {
  const today = utcDay(new Date());
  const first = await firstLedgerDay(today);
  const floor = addDays(today, -(MAX_RANGE_DAYS - 1));
  return first < floor ? floor : first;
}

export async function readOutcomeCostTotals(groupBy: OutcomeCostDimension[], f: OutcomeCostFilters, since: string, until: string): Promise<OutcomeCostTotals> {
  const byBrand = groupBy.includes("brandId");
  // Source dimensions group the consumed section only (produced and scope have no consumed occurrence).
  const sourced = groupBy.some(isSource);
  const startDays = needsStartDays(groupBy, f);
  const all = groupBy.map((name) => ({ name, expr: dimExpr(name) }));
  const dims = all.filter((d) => !isSource(d.name as OutcomeCostDimension));
  const nonOutcome = dims.filter((d) => d.name !== "outcomeKey");

  const produced = await grouped(
    "produced",
    dims,
    sql`SUM(x.n) FILTER (WHERE x.kind = 'produced_count')::text AS n,
        SUM(x.quantity) FILTER (WHERE x.kind = 'produced_count')::text AS quantity, ${MONEY_SUMS()}`,
    baseSql(["produced_count", "produced_cost"], byBrand, f, since, until, "outcome_key", sourced, startDays, false),
  );

  // Consumptions are always per (consuming outcome, consumed outcome): the inputs of each outcome.
  const consumedDims = [
    { name: "consumingOutcomeKey", expr: "x.outcome_key" },
    { name: "consumedOutcomeKey", expr: "x.consumed_outcome_key" },
    ...all.filter((d) => d.name !== "outcomeKey"),
  ];
  const consumed = await grouped(
    "consumed",
    consumedDims,
    sql`SUM(x.n)::text AS n, SUM(x.reuses)::text AS reuses, SUM(x.unknown_provenance)::text AS unknown,
        ${MONEY_SUMS()}, ${MONEY_SUMS("r_", "reuse_")}`,
    baseSql(["consumed"], byBrand, f, since, until, "outcome_key", sourced, startDays, true, groupBy.includes("sourceBrandId")),
  );

  // The scope's money, whatever outcome it bought: what the figures above stand on.
  const scope = await grouped(
    "scope",
    nonOutcome,
    sql`SUM(x.gross) FILTER (WHERE x.kind = 'produced_cost')::text AS p_gross, SUM(x.net) FILTER (WHERE x.kind = 'produced_cost')::text AS p_net,
        SUM(x.vendor) FILTER (WHERE x.kind = 'produced_cost')::text AS p_vendor, SUM(x.unpriced_gross) FILTER (WHERE x.kind = 'produced_cost')::text AS p_unpriced,
        SUM(x.gross) FILTER (WHERE x.kind = 'none')::text AS z_gross, SUM(x.net) FILTER (WHERE x.kind = 'none')::text AS z_net,
        SUM(x.vendor) FILTER (WHERE x.kind = 'none')::text AS z_vendor, SUM(x.unpriced_gross) FILTER (WHERE x.kind = 'none')::text AS z_unpriced,
        SUM(x.gross) FILTER (WHERE x.kind = 'abnormal')::text AS a_gross, SUM(x.net) FILTER (WHERE x.kind = 'abnormal')::text AS a_net,
        SUM(x.vendor) FILTER (WHERE x.kind = 'abnormal')::text AS a_vendor, SUM(x.unpriced_gross) FILTER (WHERE x.kind = 'abnormal')::text AS a_unpriced,
        ${MONEY_SUMS()}, SUM(x.n)::text AS n,
        ${supportSums()}`,
    baseSql(["produced_cost", "none", "abnormal"], byBrand, f, since, until, null, sourced, startDays, false),
  );

  // v5: abnormal loss per reason, and the other state family's view of the routed spend.
  const abnormalDims = [{ name: "abnormalReason", expr: "x.abnormal_reason" }, ...dims];
  const abnormal = await grouped(
    "abnormal",
    abnormalDims,
    sql`SUM(x.n)::text AS n, ${MONEY_SUMS()}`,
    baseSql(["abnormal"], byBrand, f, since, until, "outcome_key", sourced, startDays, false),
  );
  const parallel = await grouped(
    "parallel",
    dims,
    sql`SUM(x.n)::text AS n,
        SUM(x.gross) FILTER (WHERE x.kind = 'parallel_cost')::text AS gross, SUM(x.net) FILTER (WHERE x.kind = 'parallel_cost')::text AS net,
        SUM(x.vendor) FILTER (WHERE x.kind = 'parallel_cost')::text AS vendor, SUM(x.unpriced_gross) FILTER (WHERE x.kind = 'parallel_cost')::text AS unpriced,
        SUM(x.gross) FILTER (WHERE x.kind = 'parallel_none')::text AS u_gross, SUM(x.net) FILTER (WHERE x.kind = 'parallel_none')::text AS u_net,
        SUM(x.vendor) FILTER (WHERE x.kind = 'parallel_none')::text AS u_vendor, SUM(x.unpriced_gross) FILTER (WHERE x.kind = 'parallel_none')::text AS u_unpriced`,
    baseSql(["parallel_cost", "parallel_none"], byBrand, f, since, until, "outcome_key", sourced, startDays, false),
  );

  const computed = (await statsDb.execute(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, support_split FROM cost_ledger_computed_days
    WHERE allocation_version = ${ALLOCATION_VERSION} AND outcome_costs AND day BETWEEN ${since}::date AND ${until}::date
      -- a day stored before the state ladder (0078) holds the old state inputs: missing until recomputed
      AND state_ladder
      AND (consumed_sources OR NOT ${sourced})
      AND (start_days OR NOT ${startDays})
  `)) as any[];
  const split = new Map(computed.map((r) => [r.day as string, r.support_split === true]));
  const daysStale = await staleDaysIn(since, until);
  const stale = new Set(daysStale);
  const daysMissing: string[] = [];
  const supportDaysMissing: string[] = [];
  for (let d = since; d <= until; d = addDays(d, 1)) {
    if (!split.has(d) || stale.has(d)) daysMissing.push(d);
    if (!split.get(d)) supportDaysMissing.push(d);
  }

  const names = dims.map((d) => d.name);
  return {
    since,
    until,
    daysMissing,
    daysStale,
    supportDaysMissing,
    produced: produced.map((r) => ({
      dimensions: dimensionsOf(r, names),
      occurrences: new Decimal(r.n ?? 0).toNumber(),
      quantity: new Decimal(r.quantity ?? 0).toFixed(6),
      cost: moneyOf(r),
    })),
    consumed: consumed.map((r) => ({
      dimensions: dimensionsOf(r, consumedDims.map((d) => d.name)),
      consumptions: fx(r.n),
      reuses: fx(r.reuses),
      unknownProvenance: fx(r.unknown),
      standardCost: moneyOf(r),
      reuseGain: moneyOf(r, "r_"),
    })),
    scope: scope.map((r) => {
      const producedCost = moneyOf(r, "p_");
      const producedNone = moneyOf(r, "z_");
      const spend = moneyOf(r);
      const supportByFunction: SupportByFunction = {};
      for (const fn of SUPPORT_FUNCTIONS) if (r[`s_${fn}_gross`] !== null) supportByFunction[fn] = moneyOf(r, `s_${fn}_`);
      const support = supportTotal(supportByFunction);
      const sub = (a: string, b: string) => new Decimal(a).minus(b).toFixed(10);
      const undeclared = {
        gross: sub(producedNone.gross, support.gross),
        net: sub(producedNone.net, support.net),
        vendor: sub(producedNone.vendor, support.vendor),
        unpricedGross: sub(producedNone.unpricedGross, support.unpricedGross),
      };
      return {
        dimensions: dimensionsOf(r, nonOutcome.map((d) => d.name)),
        spend,
        producedCost,
        producedNone,
        support,
        supportByFunction,
        undeclared,
        abnormal: moneyOf(r, "a_"),
        coverageShare: { gross: share(producedCost.gross, spend.gross), net: share(producedCost.net, spend.net) },
        outcomeSpendCoverageShare: {
          gross: share(producedCost.gross, sub(spend.gross, support.gross)),
          net: share(producedCost.net, sub(spend.net, support.net)),
        },
      };
    }),
    abnormal: abnormal.map((r) => ({ dimensions: dimensionsOf(r, abnormalDims.map((d) => d.name)), runs: fx(r.n), cost: moneyOf(r) })),
    parallel: parallel.map((r) => ({ dimensions: dimensionsOf(r, names), cost: moneyOf(r), unpooled: moneyOf(r, "u_") })),
  };
}
