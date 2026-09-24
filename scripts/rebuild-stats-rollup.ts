// Rebuild the cross-org (feature, workflow, payer) stats rollup from the ledger
// and mark it ready (migration 0034). Until this has run once on a database that
// already held runs, GET /v1/stats/public/costs keeps using the live query.
//
// Run manually AFTER the 0034 deploy (never on boot: it aggregates the whole
// ledger). Safe to re-run at any time to re-derive the rollup from scratch.
//
//   RUNS_SERVICE_DATABASE_URL=postgres://... npx tsx scripts/rebuild-stats-rollup.ts
//
// Writes QUEUE (never fail) for well under a second while it clears the rollup
// and exports a snapshot under a SHARE ROW EXCLUSIVE lock; the ~20 s aggregate
// then runs on that snapshot with no lock held. Reads fall back to the live
// query until it stamps the rollup ready. See rebuildStatsRollup in
// src/services/stats-rollup.ts.
import { rebuildStatsRollup } from "../src/services/stats-rollup.js";

const url = process.env.RUNS_SERVICE_DATABASE_URL;
if (!url) throw new Error("RUNS_SERVICE_DATABASE_URL is not set");

const t0 = Date.now();
const result = await rebuildStatsRollup(url);
console.log(`[rebuild-stats-rollup] ${result.runGroups} run groups, ${result.costGroups} cost groups in ${Date.now() - t0} ms (writers held ${result.lockedMs} ms)`);
process.exit(0);
