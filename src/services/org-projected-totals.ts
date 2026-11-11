// An org's lifetime PLATFORM-PROJECTED spend (gross + frozen net), the figure behind
// GET /internal/org-usage-total and the usage hint sent to billing-service after each
// cost write (LEDGER-LOAD-1107-SPEND, migration 0105).
//
// Stamped (`org_projected`): one PK lookup on org_projected_totals, kept in the cost
// write's own transaction by trigger, so it is never stale. Unstamped: the live SUM over
// idx_runs_costs_org_projected, unchanged. Stamp + row are read in ONE statement, so a
// rebuild cannot un-stamp between them. Both paths return the same numeric value; the
// callers render it with Decimal(...).toFixed(10), so the served text is byte-identical.

import { sql } from "drizzle-orm";
import { rebuildRollup } from "./stats-rollup.js";

export const ORG_PROJECTED_ROLLUP_NAME = "org_projected";

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

export interface OrgProjectedTotal {
  /** numeric text, unrounded (scale as stored) */
  spentCents: string;
  netSpentCents: string;
  source: "rollup" | "live";
}

export async function readOrgProjectedTotal(executor: Executor, orgId: string): Promise<OrgProjectedTotal> {
  // Row + the org's calls still queued by deferring cost writes (cost_rollup_deltas, migration 0110,
  // SEND-RUN-LATENCY-1111-COST), in ONE statement: the drain moves a call from the queue to the row in
  // one transaction, so a committed cost is counted exactly once at any instant.
  const stamped = (await executor.execute(sql`
    SELECT (COALESCE(t.total_cost_in_usd_cents, 0) + COALESCE(q.gross, 0))::text AS spent_cents,
           (COALESCE(t.net_cost_in_usd_cents, 0)   + COALESCE(q.net, 0))::text   AS net_spent_cents
      FROM stats_rollups s
      LEFT JOIN org_projected_totals t ON t.organization_id = ${orgId}
      LEFT JOIN LATERAL (
        SELECT SUM((d.a->>2)::numeric) AS gross, SUM((d.a->>3)::numeric) AS net
          FROM cost_rollup_deltas d
         WHERE d.org = ${orgId} AND d.fn = 'org_projected_totals_add'
      ) q ON true
     WHERE s.name = ${ORG_PROJECTED_ROLLUP_NAME}
  `)) as Array<{ spent_cents: string | null; net_spent_cents: string | null }>;
  if (stamped.length > 0) {
    return {
      spentCents: stamped[0].spent_cents ?? "0",
      netSpentCents: stamped[0].net_spent_cents ?? "0",
      source: "rollup",
    };
  }
  const live = (await executor.execute(sql`
    SELECT COALESCE(SUM(rc.total_cost_in_usd_cents), 0)::text AS spent_cents,
           COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)), 0)::text AS net_spent_cents
      FROM runs_costs rc
     WHERE rc.organization_id = ${orgId}
       AND rc.is_platform_projected
  `)) as Array<{ spent_cents: string; net_spent_cents: string }>;
  return { spentCents: live[0].spent_cents, netSpentCents: live[0].net_spent_cents, source: "live" };
}

export async function rebuildOrgProjectedRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: ORG_PROJECTED_ROLLUP_NAME,
    tables: ["org_projected_totals"],
    aggregate: async (b) => {
      await b`
        CREATE TEMP TABLE rebuild_org_projected ON COMMIT PRESERVE ROWS AS
        SELECT organization_id, count(*) AS n_rows,
          COALESCE(SUM(total_cost_in_usd_cents), 0) AS gross,
          COALESCE(SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)), 0) AS net
        FROM runs_costs
        WHERE is_platform_projected AND organization_id IS NOT NULL
        GROUP BY 1
      `;
    },
    merge: async (tx) => {
      const costGroups = await tx`
        INSERT INTO org_projected_totals (organization_id, n_rows, total_cost_in_usd_cents, net_cost_in_usd_cents)
        SELECT organization_id, n_rows, gross, net FROM rebuild_org_projected
        ON CONFLICT (organization_id) DO UPDATE SET
          n_rows                  = org_projected_totals.n_rows                  + EXCLUDED.n_rows,
          total_cost_in_usd_cents = org_projected_totals.total_cost_in_usd_cents + EXCLUDED.total_cost_in_usd_cents,
          net_cost_in_usd_cents   = org_projected_totals.net_cost_in_usd_cents   + EXCLUDED.net_cost_in_usd_cents
      `;
      await tx`DROP TABLE rebuild_org_projected`;
      return { runGroups: 0, costGroups: costGroups.count };
    },
  });
}
