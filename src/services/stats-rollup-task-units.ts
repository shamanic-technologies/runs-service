// Read + rebuild side of the (run-start UTC day, org, service, task, asking
// service, cost name, cost source) rollup of CHARGED cost rows kept by the
// triggers of migration 0049, for GET /internal/stats/costs/task-units.
//
// EXACTNESS. Every filter is an exact predicate on a rollup row and every
// grouping is one of its columns (month = the day's UTC month). A run sits under
// one (day, org, service, task, asking service), so runCount is exact per cost
// name; summed across cost names a run counts once per name it was charged
// under. orgCount is a DISTINCT count over the rollup rows, never a sum.
// Parity guard: tests/integration/stats-rollup-task-units.test.ts.

import { sql, type SQL } from "drizzle-orm";
import type postgres from "postgres";
import { statsDb } from "../db/index.js";
import { rebuildRollup } from "./stats-rollup.js";

export const TASK_UNITS_ROLLUP_NAME = "task_units";

/** groupBy keys, in canonical order, mapped to their SQL over the rollup. */
export const TASK_UNITS_GROUP_BY = {
  month: "to_char(day, 'YYYY-MM')",
  taskName: "task_name",
  parentServiceName: "parent_service_name",
  costName: "cost_name",
  costSource: "cost_source",
} as const;
export type TaskUnitsGroupKey = keyof typeof TASK_UNITS_GROUP_BY;

export interface TaskUnitsFilters {
  serviceName: string;
  taskNames?: string[];
  costNames?: string[];
  costNamePrefix?: string;
  costSource?: "platform" | "org";
  /** YYYY-MM-DD: runs started on or after this UTC day. */
  since?: string;
}

export interface TaskUnitsRow {
  keys: Partial<Record<TaskUnitsGroupKey, string | null>>;
  isTotal: boolean;
  run_count: string;
  org_count: string;
  n_actual: string;
  quantity: string;
  gross: string;
  net: string;
}

export async function readTaskUnits(f: TaskUnitsFilters, groupBy: TaskUnitsGroupKey[]): Promise<TaskUnitsRow[]> {
  const where: SQL[] = [sql`service_name = ${f.serviceName}`, sql`n_actual > 0`];
  if (f.taskNames) where.push(sql`task_name IN (SELECT jsonb_array_elements_text(${JSON.stringify(f.taskNames)}::jsonb))`);
  if (f.costNames) where.push(sql`cost_name IN (SELECT jsonb_array_elements_text(${JSON.stringify(f.costNames)}::jsonb))`);
  if (f.costNamePrefix) where.push(sql`cost_name LIKE ${f.costNamePrefix.replace(/([%_\\])/g, "\\$1") + "%"}`);
  if (f.costSource) where.push(sql`cost_source = ${f.costSource}`);
  if (f.since) where.push(sql`day >= ${f.since}::date`);

  const cols = groupBy.map((k) => sql.raw(`${TASK_UNITS_GROUP_BY[k]} AS "${k}"`));
  const exprs = groupBy.map((k) => sql.raw(TASK_UNITS_GROUP_BY[k]));
  // GROUPING SETS: one row per group plus the whole-scope row (orgs DISTINCT over
  // the whole scope, not summed over groups).
  const grouping = groupBy.length > 0 ? sql`GROUP BY GROUPING SETS ((${sql.join(exprs, sql`, `)}), ())` : sql``;
  const isTotal = groupBy.length > 0 ? sql`GROUPING(${sql.join(exprs, sql`, `)}) <> 0` : sql`true`;

  const rows = (await statsDb.execute(sql`
    SELECT
      ${groupBy.length > 0 ? sql`${sql.join(cols, sql`, `)},` : sql``}
      ${isTotal} AS is_total,
      COALESCE(SUM(run_count), 0)::text AS run_count,
      count(DISTINCT organization_id)::text AS org_count,
      COALESCE(SUM(n_actual), 0)::text AS n_actual,
      COALESCE(SUM(quantity), 0)::text AS quantity,
      COALESCE(SUM(gross_actual), 0)::text AS gross,
      COALESCE(SUM(net_actual), 0)::text AS net
    FROM stats_rollup_task_units
    WHERE ${sql.join(where, sql` AND `)}
    ${grouping}
  `)) as any[];

  return rows.map((r) => ({
    keys: Object.fromEntries(groupBy.map((k) => [k, (r[k] as string | null) ?? null])),
    isTotal: r.is_total === true,
    run_count: r.run_count,
    org_count: r.org_count,
    n_actual: r.n_actual,
    quantity: r.quantity,
    gross: r.gross,
    net: r.net,
  }));
}

export async function rebuildTaskUnitsRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: TASK_UNITS_ROLLUP_NAME,
    tables: ["stats_rollup_task_units"],
    aggregate: async (b: postgres.Sql) => {
      await b`
        CREATE TEMP TABLE rebuild_task_units ON COMMIT PRESERVE ROWS AS
        WITH per_run AS (
          SELECT run_id, cost_name, cost_source, count(*) AS n, SUM(quantity) AS quantity,
            SUM(total_cost_in_usd_cents) AS gross,
            SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) AS net
          FROM runs_costs WHERE status = 'actual'
          GROUP BY 1, 2, 3
        )
        SELECT (r.started_at AT TIME ZONE 'UTC')::date AS day, r.organization_id, r.service_name, r.task_name,
          p.service_name AS parent_service_name, pr.cost_name, pr.cost_source,
          count(*) AS run_count, SUM(pr.n) AS n_actual, SUM(pr.quantity) AS quantity,
          SUM(pr.gross) AS gross_actual, SUM(pr.net) AS net_actual
        FROM per_run pr
        JOIN runs r ON r.id = pr.run_id
        LEFT JOIN runs p ON p.id = r.parent_run_id
        GROUP BY 1, 2, 3, 4, 5, 6, 7
      `;
    },
    merge: async (tx: postgres.Sql) => {
      const res = await tx`
        INSERT INTO stats_rollup_task_units (
          day, organization_id, service_name, task_name, parent_service_name, cost_name, cost_source,
          run_count, n_actual, quantity, gross_actual, net_actual
        )
        SELECT day, organization_id, service_name, task_name, parent_service_name, cost_name, cost_source,
          run_count, n_actual, quantity, gross_actual, net_actual
        FROM rebuild_task_units
        ON CONFLICT ON CONSTRAINT stats_rollup_task_units_key DO UPDATE SET
          run_count    = stats_rollup_task_units.run_count    + EXCLUDED.run_count,
          n_actual     = stats_rollup_task_units.n_actual     + EXCLUDED.n_actual,
          quantity     = stats_rollup_task_units.quantity     + EXCLUDED.quantity,
          gross_actual = stats_rollup_task_units.gross_actual + EXCLUDED.gross_actual,
          net_actual   = stats_rollup_task_units.net_actual   + EXCLUDED.net_actual
      `;
      await tx`DROP TABLE rebuild_task_units`;
      return { runGroups: res.count, costGroups: res.count };
    },
  });
}
