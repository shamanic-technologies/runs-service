import { Router } from "express";
import { sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db, statsDb } from "../db/index.js";
import { requireInternalAuth } from "../middleware/auth.js";
import { NoCampaignMonthlyQuerySchema, OrgNoCampaignTotalQuerySchema } from "../schemas.js";
import { isStatsRollupReady } from "../services/stats-rollup.js";
import { NO_CAMPAIGN_DAY_ROLLUP_NAME, NO_CAMPAIGN_ORIGIN_STAMP } from "../services/stats-rollup-no-campaign-day.js";

// Campaign spend vs no-campaign spend (owner 2026-10-13: a customer is charged
// only what its campaigns spend; Copilot chat, onboarding reads, card fees and any
// other spend outside a campaign stay recorded here, and the platform absorbs them).
//
// THE RULE: a cost row is campaign spend iff its RUN carries a campaign_id. A run's
// campaign is set once at creation and never changes; a child run created without
// one inherits its parent's (POST /v1/runs), so every service call inside a
// campaign's workflow is campaign spend, a sourcing serve filed under its source
// campaign included. A platform run (POST /v1/platform-runs, no parent) is campaign
// spend only when its writer states the campaign. The fact is frozen on the cost
// row at insert (runs_costs.run_has_campaign, migration 0045).

const router = Router();

/**
 * GET /internal/org-no-campaign-total — the part of each of the two org totals
 * billing-service reads that belongs to NO campaign, for cost rows written at or
 * after `since` (billing's cutover). Same predicates as the totals, so
 * total − this = campaign part, field for field:
 *   spent_cents / net_spent_cents             ⊂ GET /internal/org-usage-total
 *     (platform actual + provisioned rows of the org)
 *   total_expected_cents / net_total_expected_cents ⊂ GET /internal/org-actual-total
 *     (platform actual rows of the org's completed/failed runs)
 * O(days since the cutover): whole UTC days from org_no_campaign_days (0046), the
 * cutover's own partial day live. A row whose campaign is not
 * known yet (pre-backfill) in the window is a 500: folding it either way would
 * move a balance.
 */
router.get("/internal/org-no-campaign-total", requireInternalAuth, async (req, res) => {
  const parsed = OrgNoCampaignTotalQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }
  const { org_id, since } = parsed.data;

  // Whole UTC days after the cutover come from org_no_campaign_days (migration
  // 0046, maintained on write); the rest of the cutover's own UTC day is read live.
  // A cutover at a UTC midnight has no partial day, so no live slice is planned
  // (in SQL the slice was planned and run anyway: ~100 ms for the owner org).
  const sinceAt = new Date(since);
  const dayStart = new Date(Date.UTC(sinceAt.getUTCFullYear(), sinceAt.getUTCMonth(), sinceAt.getUTCDate()));
  const atMidnight = dayStart.getTime() === sinceAt.getTime();
  const nextDay = new Date(dayStart.getTime() + 86_400_000);
  const firstFullDay = (atMidnight ? dayStart : nextDay).toISOString().slice(0, 10);
  const slice = atMidnight
    ? sql``
    : sql`
      UNION ALL
      SELECT rc.total_cost_in_usd_cents,
             COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents),
             CASE WHEN rc.is_platform_committed AND r.status IN ('completed','failed') THEN rc.total_cost_in_usd_cents ELSE 0 END,
             CASE WHEN rc.is_platform_committed AND r.status IN ('completed','failed') THEN COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) ELSE 0 END
        FROM runs_costs rc
        JOIN runs r ON r.id = rc.run_id
       WHERE rc.organization_id = ${org_id}::uuid
         AND rc.is_platform_projected
         AND rc.run_has_campaign IS FALSE
         AND rc.created_at >= ${since}::timestamptz
         AND rc.created_at < ${nextDay.toISOString()}::timestamptz`;
  const [row] = (await db.execute(sql`
    WITH u AS (
      SELECT d.projected_gross AS pg, d.projected_net AS pn, d.actual_gross AS ag, d.actual_net AS an
        FROM org_no_campaign_days d
       WHERE d.organization_id = ${org_id}::uuid
         AND d.day >= ${firstFullDay}::date
      ${slice}
    )
    SELECT COALESCE(SUM(pg), 0)::text AS spent,
           COALESCE(SUM(pn), 0)::text AS net_spent,
           COALESCE(SUM(ag), 0)::text AS actual,
           COALESCE(SUM(an), 0)::text AS net_actual,
           (SELECT COUNT(*)::int FROM runs_costs
             WHERE organization_id = ${org_id}::uuid
               AND is_platform_projected
               AND run_has_campaign IS NULL
               AND created_at >= ${since}::timestamptz) AS unknown
      FROM u
  `)) as any[];

  if (row.unknown > 0) {
    console.error(
      `[runs-service] org-no-campaign-total: org=${org_id} since=${since} has ${row.unknown} cost rows whose campaign is not known (run_has_campaign NULL): backfill incomplete`
    );
    res.status(500).json({ error: `${row.unknown} cost rows in the window have no known campaign status (backfill incomplete)` });
    return;
  }

  res.json({
    org_id,
    since,
    spent_cents: new Decimal(row.spent).toFixed(10),
    net_spent_cents: new Decimal(row.net_spent).toFixed(10),
    total_expected_cents: new Decimal(row.actual).toFixed(10),
    net_total_expected_cents: new Decimal(row.net_actual).toFixed(10),
    as_of: new Date().toISOString(),
  });
});

// Which org a row counts under. `current` = the cost row's org now (where a brand
// transfer moved it). `incurred` = the org its run was OPENED under (bronze
// run.created, never touched by a transfer): a transferred brand's history stays
// on the org that held the brand when the money was spent. Fleet totals are the
// same on both bases; only the per-org split moves.
export type OrgBasis = "current" | "incurred";

// Live: every platform-projected cost row of the fleet (1.32M rows, 95 s on prod
// under load, 2026-10-23: past the stats statement_timeout). Kept as the
// fallback while the rollup is un-stamped (a rebuild in progress).
function monthlyLiveSql(basis: OrgBasis) {
  const org = basis === "incurred" ? sql.raw("COALESCE(o.origin, rc.organization_id)") : sql.raw("rc.organization_id");
  const origin = basis === "incurred"
    ? sql`LEFT JOIN LATERAL (SELECT run_origin_org(rc.run_id) AS origin) o ON true`
    : sql``;
  return sql`
  SELECT
    ${org}::text AS org_id,
    to_char(date_trunc('month', rc.created_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
    CASE WHEN GROUPING(rc.cost_name) = 0 THEN rc.cost_name END AS cost_name,
    COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.run_has_campaign = false), 0)::text AS no_campaign,
    COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.run_has_campaign = false), 0)::text AS net_no_campaign,
    COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.run_has_campaign = true), 0)::text AS campaign,
    COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.run_has_campaign = true), 0)::text AS net_campaign,
    COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.run_has_campaign IS NULL), 0)::text AS unknown,
    COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.run_has_campaign IS NULL), 0)::text AS net_unknown,
    GROUPING(rc.cost_name) = 0 AS by_name,
    GROUPING(${org}) = 0 AS by_org
  FROM runs_costs rc
  ${origin}
  WHERE rc.is_platform_projected
    AND rc.organization_id IS NOT NULL
  GROUP BY GROUPING SETS (
    (date_trunc('month', rc.created_at AT TIME ZONE 'UTC')),
    (${org}, date_trunc('month', rc.created_at AT TIME ZONE 'UTC')),
    (${org}, date_trunc('month', rc.created_at AT TIME ZONE 'UTC'), rc.cost_name)
  )
  ORDER BY 2, 1 NULLS FIRST, 3 NULLS FIRST
`;
}

// Rollup: same groups over (org, UTC day, cost name, run_has_campaign, origin
// org) rows. n counts the cost rows behind each figure; it can be negative on a
// single rollup row (a row written before 0056 carried no origin, and its later
// removal lands under its origin), so every test is on a GROUP's SUM(n), never on
// a row's: a group exists iff SUM(n) > 0 (the live GROUP BY's "at least one row"),
// a bucket renders '0' iff its SUM(n) is 0 (the live COALESCE(SUM … FILTER, 0)),
// else its sum at the column's scale 10.
const bucket = (has: string, col: "gross" | "net") =>
  sql.raw(`CASE WHEN COALESCE(SUM(d.n) FILTER (WHERE d.run_has_campaign ${has}), 0) > 0
    THEN round(SUM(d.${col}) FILTER (WHERE d.run_has_campaign ${has}), 10)::text ELSE '0' END`);
function monthlyFromRollupSql(basis: OrgBasis) {
  const org = sql.raw(basis === "incurred" ? "COALESCE(d.origin_org_id, d.organization_id)" : "d.organization_id");
  return sql`
  SELECT
    ${org}::text AS org_id,
    to_char(date_trunc('month', d.day), 'YYYY-MM') AS month,
    CASE WHEN GROUPING(d.cost_name) = 0 THEN d.cost_name END AS cost_name,
    ${bucket("= false", "gross")} AS no_campaign,
    ${bucket("= false", "net")} AS net_no_campaign,
    ${bucket("= true", "gross")} AS campaign,
    ${bucket("= true", "net")} AS net_campaign,
    ${bucket("IS NULL", "gross")} AS unknown,
    ${bucket("IS NULL", "net")} AS net_unknown,
    GROUPING(d.cost_name) = 0 AS by_name,
    GROUPING(${org}) = 0 AS by_org
  FROM stats_rollup_no_campaign_day d
  GROUP BY GROUPING SETS (
    (date_trunc('month', d.day)),
    (${org}, date_trunc('month', d.day)),
    (${org}, date_trunc('month', d.day), d.cost_name)
  )
  HAVING SUM(d.n) > 0
  ORDER BY 2, 1 NULLS FIRST, 3 NULLS FIRST
`;
}

/**
 * GET /internal/stats/costs/no-campaign/monthly — fleet-wide, per org per UTC
 * calendar month of the cost row's created_at: platform spend (actual +
 * provisioned, the org-usage-total predicate) split campaign / no campaign / not
 * known, gross and net, plus the no-campaign figure per cost name (so a reader can
 * set card-acquiring fees apart). Org-attributed rows only. months[] is dense from
 * the month of the first such row to the current month.
 */
router.get("/internal/stats/costs/no-campaign/monthly", requireInternalAuth, async (req, res) => {
  const parsed = NoCampaignMonthlyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }
  const orgBasis: OrgBasis = parsed.data.orgBasis ?? "current";
  try {
    // From the write-maintained rollup (migrations 0055 + 0056) once stamped (the
    // incurred basis needs the origin stamp too); the live query (same figures,
    // same text, same order) only until then.
    const ready =
      (await isStatsRollupReady(NO_CAMPAIGN_DAY_ROLLUP_NAME)) &&
      (orgBasis === "current" || (await isStatsRollupReady(NO_CAMPAIGN_ORIGIN_STAMP)));
    const rows = (await statsDb.execute(ready ? monthlyFromRollupSql(orgBasis) : monthlyLiveSql(orgBasis))) as any[];

    const figures = (r: any) => ({
      noCampaignCostInUsdCents: r.no_campaign as string,
      netNoCampaignCostInUsdCents: r.net_no_campaign as string,
      campaignCostInUsdCents: r.campaign as string,
      netCampaignCostInUsdCents: r.net_campaign as string,
      unknownCostInUsdCents: r.unknown as string,
      netUnknownCostInUsdCents: r.net_unknown as string,
    });

    const fleet = new Map<string, any>();
    const orgMonths = new Map<string, any>();
    for (const r of rows) {
      if (!r.by_org) {
        fleet.set(r.month, figures(r));
      } else if (!r.by_name) {
        orgMonths.set(`${r.org_id}|${r.month}`, { orgId: r.org_id, month: r.month, ...figures(r), noCampaignByCostName: [] });
      } else if (r.no_campaign !== "0") {
        orgMonths.get(`${r.org_id}|${r.month}`).noCampaignByCostName.push({
          costName: r.cost_name as string,
          noCampaignCostInUsdCents: r.no_campaign as string,
          netNoCampaignCostInUsdCents: r.net_no_campaign as string,
        });
      }
    }

    // Dense months: first month with a row .. current UTC month. A month with no
    // row is a true zero (no cost row at all), not an unknown.
    const zero = { noCampaignCostInUsdCents: "0", netNoCampaignCostInUsdCents: "0", campaignCostInUsdCents: "0", netCampaignCostInUsdCents: "0", unknownCostInUsdCents: "0", netUnknownCostInUsdCents: "0" };
    const months: any[] = [];
    const first = [...fleet.keys()].sort()[0];
    if (first) {
      const now = new Date();
      let y = Number(first.slice(0, 4));
      let m = Number(first.slice(5, 7));
      while (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth() + 1)) {
        const key = `${y}-${String(m).padStart(2, "0")}`;
        const orgCount = [...orgMonths.values()].filter((o) => o.month === key && o.noCampaignCostInUsdCents !== "0").length;
        months.push({ month: key, ...(fleet.get(key) ?? zero), orgsWithNoCampaignSpend: orgCount });
        m += 1;
        if (m === 13) { m = 1; y += 1; }
      }
    }

    res.json({ timezone: "UTC", statuses: ["actual", "provisioned"], orgBasis, months, orgs: [...orgMonths.values()] });
  } catch (err) {
    console.error("[Runs Service] Error in GET /internal/stats/costs/no-campaign/monthly:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
