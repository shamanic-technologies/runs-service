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
import { ALLOCATION_VERSION, addDays, supportTotal, type Money, type SupportByFunction } from "./outcome-ledger.js";
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
  // The run that PRODUCED the consumed occurrence (consumed section only): a reply
  // declared on an untagged reply-judging run is grouped by the send's workflow,
  // campaign, brand. Null = no run declared producing it (unknownProvenance) or an
  // untagged producing run.
  "sourceOrgId",
  "sourceBrandId",
  "sourceCampaignId",
  "sourceWorkflowSlug",
  "sourceFeatureSlug",
] as const;
export type OutcomeCostDimension = (typeof OUTCOME_COST_DIMENSIONS)[number];

const isSource = (d: OutcomeCostDimension) => d.startsWith("source");

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
  outcomeKey?: string;
}

const COLUMN: Record<Exclude<OutcomeCostDimension, "brandId" | "sourceBrandId">, string> = {
  outcomeKey: "outcome_key",
  day: "day",
  orgId: "organization_id",
  costOrgId: "cost_organization_id",
  campaignId: "campaign_id",
  workflowSlug: "workflow_slug",
  featureSlug: "feature_slug",
  sourceOrgId: "source_organization_id",
  sourceCampaignId: "source_campaign_id",
  sourceWorkflowSlug: "source_workflow_slug",
  sourceFeatureSlug: "source_feature_slug",
};

const dimExpr = (d: OutcomeCostDimension): string =>
  d === "brandId"
    ? "x.brand_id"
    : d === "sourceBrandId"
      ? "x.source_brand_id"
      : d === "day"
        ? "to_char(x.day, 'YYYY-MM-DD')"
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
 * `sourced`: only days whose consumed rows carry their source (0063); the
 * others are reported in daysMissing.
 */
function baseSql(
  kinds: string[],
  groupsByBrand: boolean,
  f: OutcomeCostFilters,
  since: string,
  until: string,
  outcomeCol: string | null,
  sourced: boolean,
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
  if (f.outcomeKey && outcomeCol) where.push(sql`${sql.raw(`d.${outcomeCol}`)} = ${f.outcomeKey}`);
  if (f.brandId && !groupsByBrand) where.push(sql`${f.brandId} = ANY(d.brand_ids)`);
  if (sourced) {
    where.push(sql`EXISTS (SELECT 1 FROM cost_ledger_computed_days c
      WHERE c.day = d.day AND c.allocation_version = d.allocation_version AND c.consumed_sources)`);
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
  daysMissing: string[];
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
    coverageShare: { gross: string | null; net: string | null };
    /** producedCost / (spend - support): coverage on outcome spend only. */
    outcomeSpendCoverageShare: { gross: string | null; net: string | null };
  }>;
  /** Days stored before the support split (support reads 0 there until recomputed). */
  supportDaysMissing: string[];
}

/** First UTC day the refresher stored outcome totals for (null when none yet). */
export async function firstOutcomeCostDay(): Promise<string | null> {
  const [r] = (await statsDb.execute(sql`
    SELECT to_char(MIN(day), 'YYYY-MM-DD') AS day FROM cost_ledger_computed_days
    WHERE allocation_version = ${ALLOCATION_VERSION} AND outcome_costs
  `)) as any[];
  return r?.day ?? null;
}

export async function readOutcomeCostTotals(groupBy: OutcomeCostDimension[], f: OutcomeCostFilters, since: string, until: string): Promise<OutcomeCostTotals> {
  const byBrand = groupBy.includes("brandId");
  // Source dimensions group the consumed section only (produced and scope have no consumed occurrence).
  const sourced = groupBy.some(isSource);
  const all = groupBy.map((name) => ({ name, expr: dimExpr(name) }));
  const dims = all.filter((d) => !isSource(d.name as OutcomeCostDimension));
  const nonOutcome = dims.filter((d) => d.name !== "outcomeKey");

  const produced = await grouped(
    "produced",
    dims,
    sql`SUM(x.n) FILTER (WHERE x.kind = 'produced_count')::text AS n,
        SUM(x.quantity) FILTER (WHERE x.kind = 'produced_count')::text AS quantity, ${MONEY_SUMS()}`,
    baseSql(["produced_count", "produced_cost"], byBrand, f, since, until, "outcome_key", sourced),
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
    baseSql(["consumed"], byBrand, f, since, until, "outcome_key", sourced, groupBy.includes("sourceBrandId")),
  );

  // The scope's money, whatever outcome it bought: what the figures above stand on.
  const scope = await grouped(
    "scope",
    nonOutcome,
    sql`SUM(x.gross) FILTER (WHERE x.kind = 'produced_cost')::text AS p_gross, SUM(x.net) FILTER (WHERE x.kind = 'produced_cost')::text AS p_net,
        SUM(x.vendor) FILTER (WHERE x.kind = 'produced_cost')::text AS p_vendor, SUM(x.unpriced_gross) FILTER (WHERE x.kind = 'produced_cost')::text AS p_unpriced,
        SUM(x.gross) FILTER (WHERE x.kind = 'none')::text AS z_gross, SUM(x.net) FILTER (WHERE x.kind = 'none')::text AS z_net,
        SUM(x.vendor) FILTER (WHERE x.kind = 'none')::text AS z_vendor, SUM(x.unpriced_gross) FILTER (WHERE x.kind = 'none')::text AS z_unpriced,
        ${MONEY_SUMS()}, SUM(x.n)::text AS n,
        ${supportSums()}`,
    baseSql(["produced_cost", "none"], byBrand, f, since, until, null, sourced),
  );

  const computed = (await statsDb.execute(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, support_split FROM cost_ledger_computed_days
    WHERE allocation_version = ${ALLOCATION_VERSION} AND outcome_costs AND day BETWEEN ${since}::date AND ${until}::date
      AND (consumed_sources OR NOT ${sourced})
  `)) as any[];
  const split = new Map(computed.map((r) => [r.day as string, r.support_split === true]));
  const daysMissing: string[] = [];
  const supportDaysMissing: string[] = [];
  for (let d = since; d <= until; d = addDays(d, 1)) {
    if (!split.has(d)) daysMissing.push(d);
    if (!split.get(d)) supportDaysMissing.push(d);
  }

  const names = dims.map((d) => d.name);
  return {
    since,
    until,
    daysMissing,
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
        coverageShare: { gross: share(producedCost.gross, spend.gross), net: share(producedCost.net, spend.net) },
        outcomeSpendCoverageShare: {
          gross: share(producedCost.gross, sub(spend.gross, support.gross)),
          net: share(producedCost.net, sub(spend.net, support.net)),
        },
      };
    }),
  };
}
