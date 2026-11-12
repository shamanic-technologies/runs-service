import { Router } from "express";
import { requireInternalAuth } from "../middleware/auth.js";
import { VendorCostCatalogError, fetchVendorCostCatalog } from "../services/vendor-costs.js";
import {
  CursorError,
  SERVICE_CALLS_DEFAULT_LIMIT,
  SERVICE_CALLS_MAX_LIMIT,
  readServiceCalls,
} from "../services/service-calls.js";
import {
  DecisionCursorError,
  MAX_DECISIONS_PER_CALL,
  readDecisionChanges,
  readDecisionUnits,
} from "../services/decision-units.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TASKS = 100;

/**
 * GET /internal/stats/service-calls — every run of one service, fleet-wide, whole
 * history then what changed, with its cost lines and the decision it was part of
 * (LLM-RATING-PER-ENGINE-1112-RUNS). See services/service-calls.ts.
 */
router.get("/internal/stats/service-calls", requireInternalAuth, async (req, res) => {
  try {
    const { serviceName, taskNames, cursor, limit } = req.query as Record<string, unknown>;
    if (typeof serviceName !== "string" || serviceName.trim() === "") {
      res.status(400).json({ error: "serviceName is required" });
      return;
    }
    let tasks: string[] | null = null;
    if (taskNames !== undefined) {
      if (typeof taskNames !== "string") {
        res.status(400).json({ error: "taskNames must be a comma-separated string" });
        return;
      }
      tasks = [...new Set(taskNames.split(",").map((s) => s.trim()).filter(Boolean))];
      if (tasks.length === 0 || tasks.length > MAX_TASKS) {
        res.status(400).json({ error: `taskNames must list between 1 and ${MAX_TASKS} values` });
        return;
      }
    }
    if (cursor !== undefined && (typeof cursor !== "string" || cursor === "")) {
      res.status(400).json({ error: "cursor must be the nextCursor a previous page served" });
      return;
    }
    let n = SERVICE_CALLS_DEFAULT_LIMIT;
    if (limit !== undefined) {
      n = Number(limit);
      if (typeof limit !== "string" || !Number.isInteger(n) || n < 1 || n > SERVICE_CALLS_MAX_LIMIT) {
        res.status(400).json({ error: `limit must be an integer between 1 and ${SERVICE_CALLS_MAX_LIMIT}` });
        return;
      }
    }
    const versions = await fetchVendorCostCatalog();
    const page = await readServiceCalls({ serviceName: serviceName.trim(), taskNames: tasks }, cursor as string | undefined, n, versions);
    res.json(page);
  } catch (err) {
    if (err instanceof CursorError) {
      res.status(err.expired ? 410 : 400).json({ error: err.message });
      return;
    }
    console.error("[Runs Service] Error in GET /internal/stats/service-calls:", err);
    if (err instanceof VendorCostCatalogError) {
      res.status(502).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

/** POST /internal/stats/decision-units — the Units each named decision produced (own + one hop downstream). */
router.post("/internal/stats/decision-units", requireInternalAuth, async (req, res) => {
  try {
    const ids = (req.body as { decisionRunIds?: unknown })?.decisionRunIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_DECISIONS_PER_CALL || !ids.every((i) => typeof i === "string" && UUID_RE.test(i))) {
      res.status(400).json({ error: `decisionRunIds must list between 1 and ${MAX_DECISIONS_PER_CALL} run UUIDs` });
      return;
    }
    const decisions = await readDecisionUnits(ids.map((i: string) => i.toLowerCase()));
    res.json({ decisions });
  } catch (err) {
    console.error("[Runs Service] Error in POST /internal/stats/decision-units:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** GET /internal/stats/decision-units/changes — decisions whose Units may have moved since the cursor. */
router.get("/internal/stats/decision-units/changes", requireInternalAuth, async (req, res) => {
  try {
    const cursor = req.query.cursor;
    if (cursor !== undefined && (typeof cursor !== "string" || cursor === "")) {
      res.status(400).json({ error: "cursor must be the nextCursor a previous page served" });
      return;
    }
    res.json(await readDecisionChanges(cursor as string | undefined));
  } catch (err) {
    if (err instanceof DecisionCursorError) {
      res.status(err.expired ? 410 : 400).json({ error: err.message });
      return;
    }
    console.error("[Runs Service] Error in GET /internal/stats/decision-units/changes:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
