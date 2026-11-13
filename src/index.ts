import { startSupportPropagation } from "./services/support-effective.js";
import express from "express";
import cors from "cors";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import healthRoutes from "./routes/health.js";
import runsRoutes from "./routes/runs.js";
import statsRoutes from "./routes/stats.js";
import runOutcomesRoutes from "./routes/run-outcomes.js";
import platformRunsRoutes from "./routes/platform-runs.js";
import internalRoutes from "./routes/internal.js";
import refundRoutes from "./routes/refunds.js";
import repriceRoutes from "./routes/reprices.js";
import incurredCostRoutes from "./routes/incurred-costs.js";
import vendorCostRoutes from "./routes/vendor-costs.js";
import eventsRoutes from "./routes/events.js";
import noCampaignSpendRoutes from "./routes/no-campaign-spend.js";
import taskUnitsRoutes from "./routes/task-units.js";
import outcomeOccurrenceRoutes from "./routes/outcome-occurrences.js";
import brandLedgerRoutes from "./routes/brand-ledger.js";
import serviceCallsRoutes from "./routes/service-calls.js";
import outcomeChainRoutes from "./routes/outcome-chains.js";
import { db } from "./db/index.js";
import { startRunEventsRetention } from "./services/run-events-retention.js";
import { startStaleMinMaxRepair } from "./services/stats-rollup-minmax-repair.js";
import { startCostLedgerRefresh } from "./services/outcome-ledger.js";
import { startLifecycleArchive } from "./services/lifecycle-archive.js";
import { startOutcomeChainBuilds } from "./services/outcome-chains.js";
import { startRunRollupDrain } from "./services/run-rollup-drain.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Serve generated OpenAPI spec (no auth required)
app.get("/openapi.json", async (_req, res) => {
  try {
    const specPath = join(__dirname, "..", "openapi.json");
    const spec = await readFile(specPath, "utf-8");
    res.json(JSON.parse(spec));
  } catch {
    res.status(404).json({
      error: "OpenAPI spec not found. Run: npm run generate:openapi",
    });
  }
});

app.use(healthRoutes);
app.use(runsRoutes);
app.use(statsRoutes);
app.use(runOutcomesRoutes);
app.use(platformRunsRoutes);
app.use(internalRoutes);
app.use(refundRoutes);
app.use(repriceRoutes);
app.use(incurredCostRoutes);
app.use(vendorCostRoutes);
app.use(eventsRoutes);
app.use(noCampaignSpendRoutes);
app.use(taskUnitsRoutes);
app.use(outcomeOccurrenceRoutes);
app.use(brandLedgerRoutes);
app.use(serviceCallsRoutes);
app.use(outcomeChainRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Only start server if not in test environment
if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(() => {
      console.log("[Runs Service] Migrations complete");
      app.listen(Number(PORT), "::", () => {
        console.log(`[Runs Service] Service running on port ${PORT}`);
        // AFTER the port bind: the sweep touches the database and must never
        // delay listen() (CLAUDE.md "Boot-window hazards").
        startRunEventsRetention();
        // Clears the rollups' stale min/max so brand-history reads stay on the rollup
        // (services/stats-rollup-minmax-repair.ts). Also after listen().
        startStaleMinMaxRepair();
        // The stored per-day production-cost ledger check + coverage series
        // (services/outcome-ledger.ts): first tick ~60 s after boot, then every 15 min.
        startCostLedgerRefresh();
        // Support marks propagated to their subtrees (services/support-effective.ts, 0091):
        // first tick ~60 s after boot, then every 15 s.
        startSupportPropagation();
        // Bronze lifecycle events past the archive boundary move to R2, verified, then
        // deleted (services/lifecycle-archive.ts, BOX-DISK-1101): first tick ~60 s after
        // boot, then every 6 h; the boundary moves monthly. Kill switch LIFECYCLE_ARCHIVE_DISABLED.
        startLifecycleArchive();
        // Queued run-count +1s folded into the rollups every ~1 s (services/run-rollup-drain.ts,
        // SEND-RUN-LATENCY-1111): first tick right away, it drains whatever the last process left.
        startRunRollupDrain();
        // The produce / consume graph summarised for the script Rating (services/outcome-chains.ts,
        // SCRIPT-VALUE-RATING-1113-RUNS): first build ~90 s after boot, then 15 min after each one ends.
        startOutcomeChainBuilds();
      });
    })
    .catch((err) => {
      console.error("[Runs Service] Migration failed:", err);
      process.exit(1);
    });
}

export default app;
