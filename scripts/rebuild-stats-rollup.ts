// Rebuild a write-maintained stats rollup from the ledger and mark it ready.
// Until this has run once on a database that already held runs, the reads it
// serves keep using the live query.
//
//   feature_workflow (migration 0034) — GET /v1/stats/public/costs, the cross-org
//                                       per-workflow benchmark. The default.
//   campaign_day     (migration 0037) — the campaign-family reads: the public
//                                       costs + timeseries with campaignId(s).
//
// Run manually AFTER the deploy that ships the migration (never on boot: it
// aggregates the whole ledger). Safe to re-run at any time.
//
//   RUNS_SERVICE_DATABASE_URL=postgres://... npx tsx scripts/rebuild-stats-rollup.ts [feature_workflow|campaign_day]
//
// Writes QUEUE (never fail) for well under a second while it clears the rollup
// and exports a snapshot under a SHARE ROW EXCLUSIVE lock; the aggregate then
// runs on that snapshot with no lock held. Reads fall back to the live query
// until it stamps the rollup ready. See rebuildRollup in
// src/services/stats-rollup.ts.
import { rebuildStatsRollup } from "../src/services/stats-rollup.js";
import { rebuildCampaignDayRollup } from "../src/services/stats-rollup-campaign.js";

const url = process.env.RUNS_SERVICE_DATABASE_URL;
if (!url) throw new Error("RUNS_SERVICE_DATABASE_URL is not set");

const which = process.argv[2] ?? "feature_workflow";
const rebuild = { feature_workflow: rebuildStatsRollup, campaign_day: rebuildCampaignDayRollup }[which];
if (!rebuild) throw new Error(`Unknown rollup '${which}'. Expected feature_workflow or campaign_day.`);

const t0 = Date.now();
const result = await rebuild(url);
console.log(`[rebuild-stats-rollup ${which}] ${result.runGroups} run groups, ${result.costGroups} cost groups in ${Date.now() - t0} ms (writers held ${result.lockedMs} ms)`);
process.exit(0);
