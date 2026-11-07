// WHO performed each outcome occurrence (OUTCOME-PERFORMER-1106, owner 2026-11-06:
// "la provenance est clé pour les stats, mais doit être stockée de façon
// généralisée, par outcome"). runs-service is the one store of occurrences; a
// declaring service states the performer per produced occurrence (migration 0097,
// run_outcomes.performer_*). Reads serve the EFFECTIVE performer:
//   - stated  = what the declaring service stated (always wins);
//   - run_workflow = nothing stated, the declaring run carries a workflow: one of
//     OUR scripts made it (every other outcome already has its script through its
//     run's workflow), kind `script`, workflowSlug = the run's;
//   - null = nothing stated and no workflow on the run (unknown, never guessed).
// So `workflowSlug` groups a script's output whether its run declared it or another
// service stated it on its own run (a meeting lead-service records, performed by
// script X). Cost allocation never reads any of this.

import { sql, type SQL } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { statsDb } from "../db/index.js";

export const PERFORMER_BASES = ["stated", "run_workflow"] as const;
export type PerformerBasis = (typeof PERFORMER_BASES)[number];

export interface EffectivePerformer {
  kind: string;
  workflowSlug: string | null;
  name: string | null;
  basis: PerformerBasis;
}

/**
 * SQL columns of the effective performer for `run_outcomes o JOIN runs r`:
 * performer_eff_kind, performer_eff_workflow_slug, performer_eff_name, performer_eff_basis.
 */
export const EFFECTIVE_PERFORMER_COLUMNS = sql.raw(`
  CASE WHEN o.performer_kind IS NOT NULL THEN o.performer_kind
       WHEN o.direction = 'produced' AND r.workflow_slug IS NOT NULL THEN 'script' END AS performer_eff_kind,
  CASE WHEN o.performer_kind IS NOT NULL THEN o.performer_workflow_slug
       WHEN o.direction = 'produced' THEN r.workflow_slug END AS performer_eff_workflow_slug,
  CASE WHEN o.performer_kind IS NOT NULL THEN o.performer_name END AS performer_eff_name,
  CASE WHEN o.performer_kind IS NOT NULL THEN 'stated'
       WHEN o.direction = 'produced' AND r.workflow_slug IS NOT NULL THEN 'run_workflow' END AS performer_eff_basis`);

/** The effective-performer SQL expression of a kind (for a WHERE on the same join). */
export const EFFECTIVE_PERFORMER_KIND_SQL = sql.raw(
  `(CASE WHEN o.performer_kind IS NOT NULL THEN o.performer_kind WHEN o.direction = 'produced' AND r.workflow_slug IS NOT NULL THEN 'script' END)`,
);

export function effectivePerformerOf(row: Record<string, any>): EffectivePerformer | null {
  if (!row.performer_eff_kind) return null;
  return {
    kind: row.performer_eff_kind,
    workflowSlug: row.performer_eff_workflow_slug ?? null,
    name: row.performer_eff_name ?? null,
    basis: row.performer_eff_basis,
  };
}

// ---------------------------------------------------------------------------
// Grouped read: GET /internal/stats/outcome-performers
// ---------------------------------------------------------------------------

export const PERFORMER_STAT_DIMENSIONS = [
  "outcomeKey",
  "day",
  "orgId",
  "brandId",
  "campaignId",
  "featureSlug",
  "serviceName",
  "taskName",
  "performerKind",
  "performerBasis",
  "workflowSlug",
  "performerName",
] as const;
export type PerformerStatDimension = (typeof PERFORMER_STAT_DIMENSIONS)[number];
export const DEFAULT_PERFORMER_GROUP_BY: PerformerStatDimension[] = ["outcomeKey", "performerKind", "workflowSlug"];

/** Groups above which the read refuses (422) instead of truncating. */
export const MAX_PERFORMER_GROUPS = 5000;

export class TooManyPerformerGroupsError extends Error {
  constructor(public readonly cap: number) {
    super(`too_many_groups: more than ${cap} groups; narrow groupBy, the filters or the day range`);
  }
}

const COLUMN: Record<PerformerStatDimension, string> = {
  outcomeKey: "outcome_key",
  day: "day",
  orgId: "org_id",
  brandId: "brand_id",
  campaignId: "campaign_id",
  featureSlug: "feature_slug",
  serviceName: "service_name",
  taskName: "task_name",
  performerKind: "performer_eff_kind",
  performerBasis: "performer_eff_basis",
  workflowSlug: "performer_eff_workflow_slug",
  performerName: "performer_eff_name",
};

export interface PerformerStatFilters {
  outcomeKey?: string;
  orgId?: string;
  brandId?: string;
  campaignId?: string;
  /** Effective kind; `none` = no performer known. */
  performerKind?: string;
  /** Effective script (stated workflowSlug, else the run's workflow). */
  workflowSlug?: string;
}

export interface PerformerStatGroup {
  [dimension: string]: string | null | number;
  count: number;
  quantity: string;
}

/**
 * PRODUCED occurrences whose effective declaration time falls in [since, until]
 * (UTC days, inclusive), counted per the asked dimensions, MINUS the reversals
 * (LEDGER-REVERSAL-1107) dated in the window: a reversed Unit counts -1 on its
 * reversal day (`day` = that day), so a window covering both reads zero. A co-branded run's
 * occurrence counts under EACH brand only when grouping by brandId (as every
 * brand read here); a brand filter alone counts it once.
 */
export async function readPerformerStats(
  groupBy: PerformerStatDimension[],
  f: PerformerStatFilters,
  since: string,
  until: string,
): Promise<{ groups: PerformerStatGroup[]; totals: { count: number; quantity: string } }> {
  // LEDGER-REVERSAL-1107: the window is applied INSIDE each entry arm (the occurrence on its
  // declaration time, its reversal on the reversal time), so `o.declared_at` below is the ENTRY's
  // time: +1 on the declaration day, -1 on the reversal day.
  const where: SQL[] = [];
  if (f.outcomeKey) where.push(sql`o.outcome_key = ${f.outcomeKey}`);
  if (f.orgId) where.push(sql`r.organization_id = ${f.orgId}::uuid`);
  if (f.campaignId) where.push(sql`r.campaign_id::text = ${f.campaignId}`);
  if (f.brandId) where.push(sql`${f.brandId} = ANY(r.brand_ids)`);
  if (f.performerKind === "none") where.push(sql`${EFFECTIVE_PERFORMER_KIND_SQL} IS NULL`);
  else if (f.performerKind) where.push(sql`${EFFECTIVE_PERFORMER_KIND_SQL} = ${f.performerKind}`);
  if (f.workflowSlug) {
    where.push(sql`(CASE WHEN o.performer_kind IS NOT NULL THEN o.performer_workflow_slug ELSE r.workflow_slug END) = ${f.workflowSlug}`);
  }
  const byBrand = groupBy.includes("brandId");
  const brandJoin = byBrand
    ? sql`CROSS JOIN LATERAL unnest(CASE WHEN cardinality(r.brand_ids) > 0 THEN r.brand_ids ELSE ARRAY[NULL]::text[] END) AS b(brand_id)`
    : sql``;
  const dims = groupBy.map((d) => sql.raw(`x.${COLUMN[d]} AS "${d}"`));
  const groupSql = groupBy.length > 0 ? sql`GROUP BY ${sql.join(groupBy.map((d) => sql.raw(`x.${COLUMN[d]}`)), sql`, `)}` : sql``;
  // A group whose entries net to nothing (every Unit of it reversed in the window) is not listed.
  const havingSql = sql`HAVING SUM(x.sign) <> 0 OR SUM(x.sign * x.quantity) <> 0`;
  const whereSql = where.length > 0 ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``;
  const window = (col: string) =>
    sql`${sql.raw(col)} >= (${since}::date)::timestamp AT TIME ZONE 'UTC' AND ${sql.raw(col)} < (${until}::date + 1)::timestamp AT TIME ZONE 'UTC'`;
  const entries = sql`(
      SELECT o.run_id, o.direction, o.outcome_key, o.quantity, o.performer_kind, o.performer_workflow_slug, o.performer_name,
             o.declared_at, 1 AS sign
      FROM run_outcomes o WHERE o.direction = 'produced' AND ${window("o.declared_at")}
      UNION ALL
      SELECT o.run_id, o.direction, o.outcome_key, o.quantity, o.performer_kind, o.performer_workflow_slug, o.performer_name,
             v.reversed_at AS declared_at, -1 AS sign
      FROM run_outcome_reversals v JOIN run_outcomes o ON o.id = v.occurrence_id
      WHERE o.direction = 'produced' AND ${window("v.reversed_at")}
    )`;
  const orderSql = groupBy.length > 0 ? sql`ORDER BY ${sql.join(groupBy.map((d) => sql.raw(`x.${COLUMN[d]} NULLS LAST`)), sql`, `)}` : sql``;
  const rows = (await statsDb.execute(sql`
    SELECT ${sql.join([...dims, sql`SUM(x.sign)::text AS n`, sql`SUM(x.sign * x.quantity)::text AS q`], sql`, `)}
    FROM (
      SELECT o.outcome_key, to_char((o.declared_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             r.organization_id::text AS org_id, ${byBrand ? sql`b.brand_id` : sql`NULL::text`} AS brand_id,
             r.campaign_id::text AS campaign_id, r.feature_slug, r.service_name, r.task_name, o.quantity, o.sign,
             ${EFFECTIVE_PERFORMER_COLUMNS}
      FROM ${entries} o JOIN runs r ON r.id = o.run_id
      ${brandJoin}
      ${whereSql}
    ) x
    ${groupSql}
    ${havingSql}
    ${orderSql}
    LIMIT ${MAX_PERFORMER_GROUPS + 1}
  `)) as any[];
  if (rows.length > MAX_PERFORMER_GROUPS) throw new TooManyPerformerGroupsError(MAX_PERFORMER_GROUPS);
  const groups = rows.map((r) => {
    const g: PerformerStatGroup = { count: Number(r.n), quantity: fx6(r.q) };
    for (const d of groupBy) g[d] = r[d] ?? null;
    return g;
  });
  // Totals count each occurrence once (a co-branded occurrence is under each brand in groups).
  const [t] = (await statsDb.execute(sql`
    SELECT COALESCE(SUM(o.sign), 0)::text AS n, COALESCE(SUM(o.sign * o.quantity), 0)::text AS q
    FROM ${entries} o JOIN runs r ON r.id = o.run_id
    ${whereSql}
  `)) as any[];
  return { groups, totals: { count: Number(t.n), quantity: fx6(t.q) } };
}

const fx6 = (v: string | null) => new Decimal(v ?? "0").toFixed(6);
