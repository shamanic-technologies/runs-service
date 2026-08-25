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
 * - refunded_cost        = SUM where status = 'refunded'                        // real spend, not charged
 *
 * Invariant: total_cost === actual_cost + provisioned_cost (always).
 *
 * ACCOUNTING vs PERFORMANCE. `refunded` money really was spent at the provider but
 * the platform decided not to charge it, so it is absent from total/actual/provisioned
 * (what the org owes) and carried in its own column instead. A consumer answering
 * "what did this workflow cost to produce an outcome" reconstructs real spend as
 * actual_cost + refunded_cost; a consumer answering "what does this customer owe"
 * uses total_cost and ignores refunded_cost. Never fold refunded back into total.
 */
export function costAggregateSelectSql(rcAlias = "rc") {
  const a = sql.raw(rcAlias);
  return sql`
    COALESCE(SUM(CASE WHEN ${a}.status IN ('actual','provisioned') THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS total_cost,
    COALESCE(SUM(CASE WHEN ${a}.status = 'actual'      THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS actual_cost,
    COALESCE(SUM(CASE WHEN ${a}.status = 'provisioned' THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS provisioned_cost,
    COALESCE(SUM(CASE WHEN ${a}.status = 'cancelled'   THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS cancelled_cost,
    COALESCE(SUM(CASE WHEN ${a}.status = 'refunded'    THEN ${a}.total_cost_in_usd_cents ELSE 0 END), 0)::text AS refunded_cost
  `;
}

/**
 * NET variant of the 4-column aggregation. Same atomic status predicates as
 * `costAggregateSelectSql`, but sums the FROZEN net amount instead of gross:
 * `COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)`. The COALESCE makes
 * historical rows (written before the discount freeze, net IS NULL) read as
 * net == gross — the correct semantic (no discount existed then).
 *
 * Output columns: net_total_cost, net_actual_cost, net_provisioned_cost, net_refunded_cost.
 * Added ONLY to the per-attribution stats reads that features-service consumes
 * so it can display gross OR net. Gross columns are unchanged, so a reader that
 * ignores the net columns sees today's numbers exactly (backward-compatible).
 */
export function costAggregateNetSelectSql(rcAlias = "rc") {
  const a = sql.raw(rcAlias);
  const net = sql`COALESCE(${a}.net_cost_in_usd_cents, ${a}.total_cost_in_usd_cents)`;
  return sql`
    COALESCE(SUM(CASE WHEN ${a}.status IN ('actual','provisioned') THEN ${net} ELSE 0 END), 0)::text AS net_total_cost,
    COALESCE(SUM(CASE WHEN ${a}.status = 'actual'      THEN ${net} ELSE 0 END), 0)::text AS net_actual_cost,
    COALESCE(SUM(CASE WHEN ${a}.status = 'provisioned' THEN ${net} ELSE 0 END), 0)::text AS net_provisioned_cost,
    COALESCE(SUM(CASE WHEN ${a}.status = 'refunded'    THEN ${net} ELSE 0 END), 0)::text AS net_refunded_cost
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
 * NET variant of `costAggregateWithSinceSql`. Same atomic status predicates and
 * same optional per-window `since` clause, but sums the FROZEN net amount
 * instead of gross: `COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)`.
 * The COALESCE makes historical rows (written before the discount freeze, net
 * IS NULL) read as net == gross — the correct semantic (no discount existed
 * then), so older windows never under-count.
 *
 * Output columns: w{i}_net_total, w{i}_net_actual, w{i}_net_provisioned.
 * Added to /v1/stats/budget ALONGSIDE the gross window columns so a consumer can
 * pace / display budgets on what the org ACTUALLY PAYS (post-usage-discount).
 * The gross window columns are unchanged — a reader that ignores the net columns
 * sees today's numbers exactly (backward-compatible).
 */
export function costAggregateNetWithSinceSql(
  rcAlias: string,
  windowIndex: number,
  sinceClause: ReturnType<typeof sql>
) {
  const a = sql.raw(rcAlias);
  const net = sql`COALESCE(${a}.net_cost_in_usd_cents, ${a}.total_cost_in_usd_cents)`;
  const wt = sql.raw(`w${windowIndex}_net_total`);
  const wa = sql.raw(`w${windowIndex}_net_actual`);
  const wp = sql.raw(`w${windowIndex}_net_provisioned`);
  return sql`
    COALESCE(SUM(CASE WHEN ${a}.status IN ('actual','provisioned') ${sinceClause} THEN ${net} ELSE 0 END), 0)::text AS ${wt},
    COALESCE(SUM(CASE WHEN ${a}.status = 'actual'      ${sinceClause} THEN ${net} ELSE 0 END), 0)::text AS ${wa},
    COALESCE(SUM(CASE WHEN ${a}.status = 'provisioned' ${sinceClause} THEN ${net} ELSE 0 END), 0)::text AS ${wp}
  `;
}

/**
 * Platform-only displayed total (`cost_source='platform' AND status IN
 * ('actual','provisioned')`) for a read whose WHERE clause already carries the
 * canonical `is_platform_projected` generated column — which is what lets the
 * partial index drive the scan. Moving the predicate from a SELECT-side CASE into
 * the WHERE is what turns the dated spend series into an index-only scan of
 * `idx_runs_costs_projected_started` instead of a full-ledger scan joined to `runs`.
 *
 * The caller MUST filter `WHERE <alias>.is_platform_projected`; the generated
 * column is the single source for that predicate (never the inline literal).
 */
export function platformProjectedSumSql(rcAlias = "rc") {
  const a = sql.raw(rcAlias);
  return sql`COALESCE(SUM(${a}.total_cost_in_usd_cents), 0)`;
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
