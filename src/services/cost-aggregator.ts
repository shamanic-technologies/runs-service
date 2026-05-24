// Cost-aggregation SQL builders. Centralizes the cost-predicate doctrine.
//
// Every existing cost field name is preserved. What changes is the underlying
// SQL: predicates are atomic status literals (`status = 'actual'`,
// `status = 'provisioned'`, `status = 'cancelled'`) or the two canonical
// generated columns (`is_platform_projected`, `is_platform_committed`) — NEVER
// the negation `status != 'cancelled'`.
//
// Under today's enum {actual, provisioned, cancelled}, the negation form is
// numerically identical to `status IN ('actual','provisioned')`. The literal
// form is drift-proof: if a 4th status is ever added, atomic literals ignore
// it (NOT count toward total) instead of silently mis-bucketing.
//
// See runs-service CLAUDE.md "Cost predicate doctrine" for the rule.

import { sql } from "drizzle-orm";

/**
 * Build the canonical 4-column cost aggregation for a `runs_costs` join alias.
 * Output columns: total_cost, actual_cost, provisioned_cost, cancelled_cost.
 *
 * Definitions:
 * - total_cost           = SUM where status IN ('actual','provisioned')        // displayed total
 * - actual_cost          = SUM where status = 'actual'
 * - provisioned_cost     = SUM where status = 'provisioned'
 * - cancelled_cost       = SUM where status = 'cancelled'                       // audit only
 *
 * Invariant: total_cost === actual_cost + provisioned_cost (always).
 */
export function costAggregateSelectSql(rcAlias = "rc") {
  const a = sql.raw(rcAlias);
  return sql`
    COALESCE(SUM(CASE WHEN ${a}.status IN ('actual','provisioned') THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS total_cost,
    COALESCE(SUM(CASE WHEN ${a}.status = 'actual'      THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS actual_cost,
    COALESCE(SUM(CASE WHEN ${a}.status = 'provisioned' THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS provisioned_cost,
    COALESCE(SUM(CASE WHEN ${a}.status = 'cancelled'   THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS cancelled_cost
  `;
}

/**
 * Same as `costAggregateSelectSql` but with optional per-window predicate
 * embedded into every SUM CASE. Used by /v1/stats/budget.
 */
export function costAggregateWithSinceSql(
  rcAlias: string,
  windowIndex: number,
  sinceClause: ReturnType<typeof sql>
) {
  const a = sql.raw(rcAlias);
  const wt = sql.raw(`w${windowIndex}_total`);
  const wa = sql.raw(`w${windowIndex}_actual`);
  const wp = sql.raw(`w${windowIndex}_provisioned`);
  return sql`
    COALESCE(SUM(CASE WHEN ${a}.status IN ('actual','provisioned') ${sinceClause} THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS ${wt},
    COALESCE(SUM(CASE WHEN ${a}.status = 'actual'      ${sinceClause} THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS ${wa},
    COALESCE(SUM(CASE WHEN ${a}.status = 'provisioned' ${sinceClause} THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS ${wp}
  `;
}

/**
 * Platform-only displayed total. Equivalent to `is_platform_projected` sum.
 * Spelled out as literal `cost_source='platform' AND status IN (...)` so the
 * doctrine stays atomic even when not using the generated column directly.
 */
export function platformTotalSelectSql(rcAlias = "rc") {
  const a = sql.raw(rcAlias);
  return sql`COALESCE(SUM(CASE WHEN ${a}.cost_source = 'platform' AND ${a}.status IN ('actual','provisioned') THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)`;
}

/**
 * Own-row variants of the same 4 columns. Used by GET /v1/runs/:id and
 * POST /v1/runs/batch when computing the depth=0 aggregates separately.
 */
export function costAggregateOwnSelectSql(rcAlias = "rc") {
  const a = sql.raw(rcAlias);
  return sql`
    COALESCE(SUM(CASE WHEN ${a}.status IN ('actual','provisioned') THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_total,
    COALESCE(SUM(CASE WHEN ${a}.status = 'actual'      THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_actual,
    COALESCE(SUM(CASE WHEN ${a}.status = 'provisioned' THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_provisioned
  `;
}

/**
 * Own-row platform-split fields used by POST /v1/runs/costs/batch (billing-service consumer).
 * Predicate is atomic — `cost_source='platform' AND status=<literal>`. No generated col
 * usage so the doctrine reads identical to the other own-row aggregations.
 */
export function costAggregateOwnPlatformSelectSql(rcAlias = "rc", dAlias = "d") {
  const a = sql.raw(rcAlias);
  const d = sql.raw(dAlias);
  return sql`
    COALESCE(SUM(CASE WHEN ${d}.id = ${d}.root_run_id AND ${a}.status = 'actual'      AND ${a}.cost_source = 'platform' THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_actual_platform_cost,
    COALESCE(SUM(CASE WHEN ${d}.id = ${d}.root_run_id AND ${a}.status = 'provisioned' AND ${a}.cost_source = 'platform' THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_provisioned_platform_cost
  `;
}
