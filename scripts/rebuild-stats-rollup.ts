// Rebuild a write-maintained stats rollup from the ledger and mark it ready.
// Until this has run once on a database that already held runs, the reads it
// serves keep using the live query.
//
//   feature_workflow (migration 0034) — GET /v1/stats/public/costs, the cross-org
//                                       per-workflow benchmark. The default.
//   campaign_day     (migration 0037) — the campaign-family reads: the public
//                                       costs + timeseries with campaignId(s).
//   cost_day         (migration 0040) — the staff margin reads
//                                       (/internal/stats/costs/margin[/timeseries]).
//   org_hour         (migration 0042) — GET /v1/stats/costs/timeseries.
//   campaign_entry   (migration 0040) — run_campaign_entries, for
//                                       GET /v1/stats/run-outcomes (scope=entry).
//                                       A lock-free windowed backfill, not the
//                                       snapshot protocol below.
//
// Run manually AFTER the deploy that ships the migration (never on boot: it
// aggregates the whole ledger). Safe to re-run at any time.
//
//   RUNS_SERVICE_DATABASE_URL=postgres://... npx tsx scripts/rebuild-stats-rollup.ts [feature_workflow|campaign_day|cost_day|org_hour|campaign_entry]
//
// Writes QUEUE (never fail) for well under a second while it clears the rollup
// and exports a snapshot under a SHARE ROW EXCLUSIVE lock; the aggregate then
// runs on that snapshot with no lock held. Reads fall back to the live query
// until it stamps the rollup ready. See rebuildRollup in
// src/services/stats-rollup.ts.
import { rebuildStatsRollup } from "../src/services/stats-rollup.js";
import { rebuildCampaignDayRollup } from "../src/services/stats-rollup-campaign.js";
import { rebuildCostDayRollup } from "../src/services/stats-rollup-cost-day.js";
import { rebuildOrgHourRollup } from "../src/services/stats-rollup-org-hour.js";
import { backfillRunCampaignEntries } from "../src/services/run-campaign-entries.js";

const url = process.env.RUNS_SERVICE_DATABASE_URL;
if (!url) throw new Error("RUNS_SERVICE_DATABASE_URL is not set");

const which = process.argv[2] ?? "feature_workflow";

if (which === "campaign_entry") {
  const t0 = Date.now();
  const r = await backfillRunCampaignEntries(url, (line) => console.log(`[rebuild-stats-rollup campaign_entry] ${line}`));
  console.log(`[rebuild-stats-rollup campaign_entry] ${r.inserted} entry runs over ${r.windows} day windows in ${Date.now() - t0} ms`);
  process.exit(0);
}

const rebuild = { feature_workflow: rebuildStatsRollup, campaign_day: rebuildCampaignDayRollup, cost_day: rebuildCostDayRollup, org_hour: rebuildOrgHourRollup }[which];
if (!rebuild) throw new Error(`Unknown rollup '${which}'. Expected feature_workflow, campaign_day, cost_day, org_hour or campaign_entry.`);

const t0 = Date.now();
const result = await rebuild(url);
console.log(`[rebuild-stats-rollup ${which}] ${result.runGroups} run groups, ${result.costGroups} cost groups in ${Date.now() - t0} ms (writers held ${result.lockedMs} ms)`);
process.exit(0);
