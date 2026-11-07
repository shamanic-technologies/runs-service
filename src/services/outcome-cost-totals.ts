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
import { ledgerReadCacheEnabled, mergeGroups, orderLikePostgres, partialsByDay, type DaySection } from "./ledger-day-cache.js";

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
/** One aggregate of a section: `expr` is a SUM (with or without FILTER), served as `alias`. */
interface Agg {
  alias: string;
  expr: string;
}
const MONEY_SUMS = (p = "", col = ""): Agg[] => [
  { alias: `${p}gross`, expr: `SUM(x.${col}gross)::text` },
  { alias: `${p}net`, expr: `SUM(x.${col}net)::text` },
  { alias: `${p}vendor`, expr: `SUM(x.${col}vendor)::text` },
  { alias: `${p}unpriced`, expr: `SUM(x.${col}unpriced_gross)::text` },
];
/** The money of the rows of one kind: SUM ... FILTER (WHERE x.kind = kind). */
const KIND_MONEY = (p: string, kind: string): Agg[] =>
  [["gross", "gross"], ["net", "net"], ["vendor", "vendor"], ["unpriced", "unpriced_gross"]].map(([a, c]) => ({
    alias: `${p}${a}`,
    expr: `SUM(x.${c}) FILTER (WHERE x.kind = '${kind}')::text`,
  }));

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
/** The stored days a section reads: a range (live read) or a list (a cached read's days to refresh). */
type DaySelection = { range: [string, string] } | { days: SQL };

function baseSql(
  kinds: string[],
  groupsByBrand: boolean,
  f: OutcomeCostFilters,
  days: DaySelection,
  outcomeCol: string | null,
  sourced: boolean,
  startDays: boolean,
  consumedSection: boolean,
  groupsBySourceBrand = false,
): SQL {
  const where: SQL[] = [
    sql`d.allocation_version = ${ALLOCATION_VERSION}`,
    "range" in days ? sql`d.day BETWEEN ${days.range[0]}::date AND ${days.range[1]}::date` : sql`d.day = ANY(${days.days})`,
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
  // `@>` (same rows as `= ANY` for a non-null brand) can use the brand_ids GIN index.
  if (f.brandId && !groupsByBrand) where.push(sql`d.brand_ids @> ARRAY[${f.brandId}]::text[]`);
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
const supportSums = (): Agg[] =>
  SUPPORT_FUNCTIONS.flatMap((fn) =>
    ["gross", "net", "vendor", "unpriced_gross"].map((c) => ({
      alias: `s_${fn}_${c === "unpriced_gross" ? "unpriced" : c}`,
      expr: `SUM(x.${c}) FILTER (WHERE x.kind = 'none' AND x.support_function = '${fn}')::text`,
    })),
  );

/** One section of the read: its groups, its sums and the stored rows it reads. */
interface Section {
  name: string;
  dims: Array<{ name: string; expr: string }>;
  aggs: Agg[];
  from: (days: DaySelection) => SQL;
}

const aggSql = (aggs: Agg[]) => sql.raw(aggs.map((a) => `${a.expr} AS "${a.alias}"`).join(", "));

/** The live read of a section over [since, until] (one statement, as before 1107). */
async function groupedLive(s: Section, since: string, until: string): Promise<any[]> {
  const cols = s.dims.map((d) => sql.raw(`${d.expr} AS "${d.name}"`));
  const head = cols.length > 0 ? sql`${sql.join(cols, sql`, `)}, ` : sql``;
  const groupBy = s.dims.length > 0 ? sql.raw(`GROUP BY ${s.dims.map((_, i) => i + 1).join(", ")} ORDER BY ${s.dims.map((_, i) => `${i + 1} NULLS FIRST`).join(", ")}`) : sql``;
  const rows = (await statsDb.execute(sql`
    SELECT ${head}${aggSql(s.aggs)} FROM ${s.from({ range: [since, until] })} ${groupBy} LIMIT ${MAX_OUTCOME_COST_GROUPS + 1}
  `)) as any[];
  return capped(s, rows);
}

/** The same groups from per-day partials (ledger-day-cache: only changed days are re-read). */
async function groupedFromDays(s: Section, partials: any[][]): Promise<any[]> {
  const merged = mergeGroups(partials, s.dims.map((d) => d.name), s.aggs.map((a) => a.alias));
  if (merged.length > MAX_OUTCOME_COST_GROUPS) throw new TooManyGroupsError(s.name, MAX_OUTCOME_COST_GROUPS);
  // A grouping with no dimension aggregates to ONE row, all NULL over no row (SQL).
  const rows = s.dims.length === 0 && merged.length === 0 ? [Object.fromEntries(s.aggs.map((a) => [a.alias, null]))] : merged;
  return capped(s, await orderLikePostgres(rows, s.dims.map((d) => d.name)));
}

function capped(s: Section, rows: any[]): any[] {
  if (rows.length > MAX_OUTCOME_COST_GROUPS) throw new TooManyGroupsError(s.name, MAX_OUTCOME_COST_GROUPS);
  // A grouping with no dimension over no row still aggregates to one all-null row: no group.
  if (s.dims.length === 0 && rows.length === 1 && rows[0].n === null && rows[0].gross === null) return [];
  return rows;
}

/** A section's partial query: its sums per (stored day, its groups), for a list of days. */
const daySection = (s: Section): DaySection => ({
  partial: (days: SQL) => {
    const cols = s.dims.map((d) => sql.raw(`, ${d.expr} AS "${d.name}"`));
    return sql`
      SELECT to_char(x.day, 'YYYY-MM-DD') AS "__day"${sql.join(cols, sql``)}, ${aggSql(s.aggs)}
      FROM ${s.from({ days })}
      GROUP BY ${sql.raw(Array.from({ length: s.dims.length + 1 }, (_, i) => i + 1).join(", "))}`;
  },
});

/** Every section's groups: from cached per-day partials, or live when the cache is off. */
async function readSections(key: string, sections: Section[], since: string, until: string): Promise<any[][]> {
  if (!ledgerReadCacheEnabled()) {
    const out: any[][] = [];
    for (const s of sections) out.push(await groupedLive(s, since, until));
    return out;
  }
  const byDay = await partialsByDay(key, sections.map(daySection), since, until);
  const out: any[][] = [];
  for (let i = 0; i < sections.length; i++) {
    const rows: any[] = [];
    for (const parts of byDay.values()) for (const r of parts[i]) rows.push(r);
    out.push(await groupedFromDays(sections[i], rows));
  }
  return out;
}

/** Test hook: the pre-1107 live read, for parity checks against the cached read. */
export async function readOutcomeCostTotalsLive(groupBy: OutcomeCostDimension[], f: OutcomeCostFilters, since: string, until: string): Promise<OutcomeCostTotals> {
  const prev = process.env.LEDGER_READ_CACHE;
  process.env.LEDGER_READ_CACHE = "off";
  try {
    return await readOutcomeCostTotals(groupBy, f, since, until);
  } finally {
    if (prev === undefined) delete process.env.LEDGER_READ_CACHE;
    else process.env.LEDGER_READ_CACHE = prev;
  }
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
  /**
   * LEDGER-OTHER-FACTORY-1107: Units of a lead state another factory produced (dimensions carry `factory`:
   * 'another_factory' | 'no_proof'). None of our cost; TOTAL Units of an outcome = produced + these.
   */
  producedElsewhere: Array<{ dimensions: Record<string, string | null>; occurrences: number }>;
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

  const consumedDims = [
    { name: "consumingOutcomeKey", expr: "x.outcome_key" },
    { name: "consumedOutcomeKey", expr: "x.consumed_outcome_key" },
    ...all.filter((d) => d.name !== "outcomeKey"),
  ];
  const abnormalDims = [{ name: "abnormalReason", expr: "x.abnormal_reason" }, ...dims];
  const elsewhereDims = [{ name: "factory", expr: "x.factory" }, ...dims];
  const from = (kinds: string[], outcomeCol: string | null, consumedSection = false, bySourceBrand = false) => (days: DaySelection) =>
    baseSql(kinds, byBrand, f, days, outcomeCol, sourced, startDays, consumedSection, bySourceBrand);
  const sections: Section[] = [
    {
      name: "produced",
      dims,
      aggs: [
        { alias: "n", expr: `SUM(x.n) FILTER (WHERE x.kind = 'produced_count')::text` },
        { alias: "quantity", expr: `SUM(x.quantity) FILTER (WHERE x.kind = 'produced_count')::text` },
        ...MONEY_SUMS(),
      ],
      from: from(["produced_count", "produced_cost"], "outcome_key"),
    },
    // Consumptions are always per (consuming outcome, consumed outcome): the inputs of each outcome.
    {
      name: "consumed",
      dims: consumedDims,
      aggs: [
        { alias: "n", expr: "SUM(x.n)::text" },
        { alias: "reuses", expr: "SUM(x.reuses)::text" },
        { alias: "unknown", expr: "SUM(x.unknown_provenance)::text" },
        ...MONEY_SUMS(),
        ...MONEY_SUMS("r_", "reuse_"),
      ],
      from: from(["consumed"], "outcome_key", true, groupBy.includes("sourceBrandId")),
    },
    // The scope's money, whatever outcome it bought: what the figures above stand on.
    {
      name: "scope",
      dims: nonOutcome,
      aggs: [
        ...KIND_MONEY("p_", "produced_cost"),
        ...KIND_MONEY("z_", "none"),
        ...KIND_MONEY("a_", "abnormal"),
        ...MONEY_SUMS(),
        { alias: "n", expr: "SUM(x.n)::text" },
        ...supportSums(),
      ],
      from: from(["produced_cost", "none", "abnormal"], null),
    },
    // v5: abnormal loss per reason, and the other state family's view of the routed spend.
    { name: "abnormal", dims: abnormalDims, aggs: [{ alias: "n", expr: "SUM(x.n)::text" }, ...MONEY_SUMS()], from: from(["abnormal"], "outcome_key") },
    {
      name: "parallel",
      dims,
      aggs: [{ alias: "n", expr: "SUM(x.n)::text" }, ...KIND_MONEY("", "parallel_cost"), ...KIND_MONEY("u_", "parallel_none")],
      from: from(["parallel_cost", "parallel_none"], "outcome_key"),
    },
    { name: "producedElsewhere", dims: elsewhereDims, aggs: [{ alias: "n", expr: "SUM(x.n)::text" }], from: from(["produced_elsewhere"], "outcome_key") },
  ];
  const cacheKey = JSON.stringify(["outcome-costs", groupBy, Object.entries(f).filter(([, v]) => v !== undefined).sort()]);
  const [produced, consumed, scope, abnormal, parallel, elsewhere] = await readSections(cacheKey, sections, since, until);

  const computed = (await statsDb.execute(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, support_split FROM cost_ledger_computed_days
    WHERE allocation_version = ${ALLOCATION_VERSION} AND outcome_costs AND day BETWEEN ${since}::date AND ${until}::date
      -- a day stored before the state ladder (0078) holds the old state inputs: missing until recomputed;
      -- one stored before 0084 still counts another factory's reaches as our units (OUR-FACTORY-OUTCOMES-1027)
      AND state_ladder AND state_inputs AND our_factory
      -- one stored before 0104 lacks another factory's Units of the total (LEDGER-OTHER-FACTORY-1107)
      AND other_factories
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
    producedElsewhere: elsewhere.map((r) => ({
      dimensions: dimensionsOf(r, elsewhereDims.map((d) => d.name)),
      occurrences: new Decimal(r.n ?? 0).toNumber(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Weighted-average price per pipe (LEDGER-PIPE-WEIGHTED-AVERAGE-1027)
// ---------------------------------------------------------------------------

const PIPE_MONEY = "SUM(gross)::text AS gross, SUM(net)::text AS net, SUM(vendor)::text AS vendor, SUM(unpriced_gross)::text AS unpriced";
const pipeOwnSql = (days: SQL) => sql`
  SELECT ${sql.raw("to_char(day, 'YYYY-MM-DD') AS \"__day\",")} feature_slug, outcome_key, ${sql.raw(PIPE_MONEY)}
  FROM outcome_cost_days
  WHERE allocation_version = ${ALLOCATION_VERSION} AND kind = 'produced_cost' AND feature_slug IS NOT NULL AND ${days}
  GROUP BY 1, 2, 3`;
const pipeLossSql = (days: SQL) => sql`
  SELECT ${sql.raw("to_char(day, 'YYYY-MM-DD') AS \"__day\",")} feature_slug, pipe_target AS outcome_key, ${sql.raw(PIPE_MONEY)}
  FROM outcome_cost_days
  WHERE allocation_version = ${ALLOCATION_VERSION} AND kind = 'none' AND pipe_target IS NOT NULL AND feature_slug IS NOT NULL AND ${days}
  GROUP BY 1, 2, 3`;
const pipeUnitSql = (days: SQL) => sql`
  SELECT DISTINCT ${sql.raw("to_char(day, 'YYYY-MM-DD') AS \"__day\",")} feature_slug, target AS outcome_key, unit_id::text AS unit_id
  FROM pipe_unit_days
  WHERE allocation_version = ${ALLOCATION_VERSION} AND ${days}`;

/**
 * The pipes' stored inputs over the range: own cost and pooled loss per (channel, outcome), and the
 * DISTINCT units per (channel, outcome). From cached per-day partials (ledger-day-cache), else live.
 */
async function readPipeInputs(since: string, until: string): Promise<{ own: any[]; loss: any[]; units: Array<{ feature_slug: string; outcome_key: string; n: number }> }> {
  if (!ledgerReadCacheEnabled()) {
    const range = sql`day BETWEEN ${since}::date AND ${until}::date`;
    
    const own = ((await statsDb.execute(sql`
      SELECT feature_slug, outcome_key, ${sql.raw(PIPE_MONEY)} FROM outcome_cost_days
      WHERE allocation_version = ${ALLOCATION_VERSION} AND kind = 'produced_cost' AND feature_slug IS NOT NULL AND ${range}
      GROUP BY 1, 2`)) as any[]);
    const loss = ((await statsDb.execute(sql`
      SELECT feature_slug, pipe_target AS outcome_key, ${sql.raw(PIPE_MONEY)} FROM outcome_cost_days
      WHERE allocation_version = ${ALLOCATION_VERSION} AND kind = 'none' AND pipe_target IS NOT NULL AND feature_slug IS NOT NULL AND ${range}
      GROUP BY 1, 2`)) as any[]);
    const units = (await statsDb.execute(sql`
      SELECT feature_slug, target AS outcome_key, COUNT(DISTINCT unit_id)::int AS n FROM pipe_unit_days
      WHERE allocation_version = ${ALLOCATION_VERSION} AND ${range}
      GROUP BY 1, 2`)) as any[];
    return { own, loss, units };
  }
  const byDay = await partialsByDay(
    "pipes",
    [
      { partial: (days) => pipeOwnSql(sql`day = ANY(${days})`) },
      { partial: (days) => pipeLossSql(sql`day = ANY(${days})`) },
      { partial: (days) => pipeUnitSql(sql`day = ANY(${days})`) },
    ],
    since,
    until,
  );
  const all = (i: number) => [...byDay.values()].flatMap((parts) => parts[i]);
  const money = ["gross", "net", "vendor", "unpriced"];
  const own = mergeGroups(all(0), ["feature_slug", "outcome_key"], money);
  const loss = mergeGroups(all(1), ["feature_slug", "outcome_key"], money);
  const sets = new Map<string, { feature_slug: string; outcome_key: string; ids: Set<string> }>();
  for (const r of all(2)) {
    const k = JSON.stringify([r.feature_slug, r.outcome_key]);
    let g = sets.get(k);
    if (!g) sets.set(k, (g = { feature_slug: r.feature_slug, outcome_key: r.outcome_key, ids: new Set() }));
    g.ids.add(r.unit_id);
  }
  return { own, loss, units: [...sets.values()].map((g) => ({ feature_slug: g.feature_slug, outcome_key: g.outcome_key, n: g.ids.size })) };
}

export interface PipeCostRow {
  featureSlug: string;
  /** The outcome the pipe produces (a lead state, else its leg's step). */
  outcomeKey: string;
  /** Distinct units the pipe's spend reached in the range. */
  units: number;
  /** Spend spread on those units the day it happened (produced_cost of the pipe's channel, evidence steps mapped to their state). */
  cost: Money;
  /** The pipe's spend that reached no unit the day it happened (its campaign got no result that day, or never). */
  pooledLoss: Money;
  /** (cost + pooledLoss) / units, 10 decimals; null with no unit (the loss then has nothing to ride: stated, never hidden). */
  unitCost: Money | null;
}

/**
 * By-the-book process costing, weighted average: a pipe (channel x the outcome it produces) gathers ALL its spend
 * over the range, whatever the day or campaign, and divides it by ALL the units it produced. Read from the stored days
 * (outcome_cost_days + pipe_unit_days), units counted distinct over the range.
 */
export async function readPipeCosts(since: string, until: string, stepStates: Array<{ stepKey: string; state: string }>): Promise<PipeCostRow[]> {
  const stateOf = new Map(stepStates.map((s) => [s.stepKey, s.state]));
  const { own, loss, units } = await readPipeInputs(since, until);
  const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
  const zero = () => ({ gross: new D(0), net: new D(0), vendor: new D(0), unpricedGross: new D(0) });
  const pipes = new Map<string, { featureSlug: string; outcomeKey: string; units: number; cost: ReturnType<typeof zero>; loss: ReturnType<typeof zero> }>();
  const at = (f: string, k: string) => {
    const key = `${f}|${k}`;
    return pipes.get(key) ?? pipes.set(key, { featureSlug: f, outcomeKey: k, units: 0, cost: zero(), loss: zero() }).get(key)!;
  };
  const add = (m: ReturnType<typeof zero>, r: any) => {
    m.gross = m.gross.plus(r.gross ?? 0); m.net = m.net.plus(r.net ?? 0); m.vendor = m.vendor.plus(r.vendor ?? 0); m.unpricedGross = m.unpricedGross.plus(r.unpriced ?? 0);
  };
  for (const r of own) add(at(r.feature_slug, stateOf.get(r.outcome_key) ?? r.outcome_key).cost, r);
  for (const r of loss) add(at(r.feature_slug, r.outcome_key).loss, r);
  for (const r of units) at(r.feature_slug, r.outcome_key).units = r.n;
  const f10 = (x: Decimal) => x.toFixed(10);
  return [...pipes.values()]
    .filter((p) => p.units > 0 || !p.loss.gross.isZero() || !p.cost.gross.isZero())
    .map((p) => ({
      featureSlug: p.featureSlug,
      outcomeKey: p.outcomeKey,
      units: p.units,
      cost: { gross: f10(p.cost.gross), net: f10(p.cost.net), vendor: f10(p.cost.vendor), unpricedGross: f10(p.cost.unpricedGross) },
      pooledLoss: { gross: f10(p.loss.gross), net: f10(p.loss.net), vendor: f10(p.loss.vendor), unpricedGross: f10(p.loss.unpricedGross) },
      unitCost: p.units > 0
        ? {
            gross: f10(p.cost.gross.plus(p.loss.gross).div(p.units)),
            net: f10(p.cost.net.plus(p.loss.net).div(p.units)),
            vendor: f10(p.cost.vendor.plus(p.loss.vendor).div(p.units)),
            unpricedGross: f10(p.cost.unpricedGross.plus(p.loss.unpricedGross).div(p.units)),
          }
        : null,
    }))
    .sort((a, b) => a.featureSlug.localeCompare(b.featureSlug) || a.outcomeKey.localeCompare(b.outcomeKey));
}
