import { Router } from "express";
import { Decimal } from "decimal.js";
import { requireInternalAuth } from "../middleware/auth.js";
import { isStatsRollupReady } from "../services/stats-rollup.js";
import {
  TASK_UNITS_GROUP_BY,
  TASK_UNITS_ROLLUP_NAME,
  readTaskUnits,
  type TaskUnitsFilters,
  type TaskUnitsGroupKey,
  type TaskUnitsRow,
} from "../services/stats-rollup-task-units.js";

const router = Router();

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIST = 100;
const GROUP_KEYS = Object.keys(TASK_UNITS_GROUP_BY) as TaskUnitsGroupKey[];

function csv(v: unknown, name: string): string[] | undefined | { error: string } {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return { error: `${name} must be a comma-separated string` };
  const list = [...new Set(v.split(",").map((s) => s.trim()).filter(Boolean))];
  if (list.length === 0 || list.length > MAX_LIST) return { error: `${name} must list between 1 and ${MAX_LIST} values` };
  return list;
}

function figures(r: TaskUnitsRow) {
  return {
    runCount: Number(r.run_count),
    orgCount: Number(r.org_count),
    costRowCount: Number(r.n_actual),
    quantity: new Decimal(r.quantity).toFixed(6),
    billedCostInUsdCents: new Decimal(r.gross).toFixed(10),
    netBilledCostInUsdCents: new Decimal(r.net).toFixed(10),
  };
}

/**
 * GET /internal/stats/costs/task-units — fleet-wide, what one service's runs were
 * CHARGED (status 'actual' cost rows), by month of run start, task, asking service
 * (the parent run's service), cost name and cost source: runs, distinct orgs, cost
 * rows, units and cents. Served from the 0049 rollup only (live it is a scan of
 * every run); 503 until the rollup is stamped ready.
 */
router.get("/internal/stats/costs/task-units", requireInternalAuth, async (req, res) => {
  try {
    const serviceName = req.query.serviceName;
    if (typeof serviceName !== "string" || serviceName.trim() === "") {
      res.status(400).json({ error: "serviceName is required" });
      return;
    }
    const taskNames = csv(req.query.taskNames, "taskNames");
    const costNames = csv(req.query.costNames, "costNames");
    for (const l of [taskNames, costNames]) {
      if (l && !Array.isArray(l)) {
        res.status(400).json(l);
        return;
      }
    }
    const costNamePrefix = req.query.costNamePrefix;
    if (costNamePrefix !== undefined && (typeof costNamePrefix !== "string" || costNamePrefix.trim() === "")) {
      res.status(400).json({ error: "costNamePrefix must be a non-empty string" });
      return;
    }
    if (costNamePrefix !== undefined && costNames !== undefined) {
      res.status(400).json({ error: "pass costNames or costNamePrefix, not both" });
      return;
    }
    const costSource = req.query.costSource;
    if (costSource !== undefined && costSource !== "platform" && costSource !== "org") {
      res.status(400).json({ error: "costSource must be 'platform' or 'org'" });
      return;
    }
    const since = req.query.since;
    if (since !== undefined && (typeof since !== "string" || !DAY_RE.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`)))) {
      res.status(400).json({ error: "since must be a YYYY-MM-DD day" });
      return;
    }
    let groupBy: TaskUnitsGroupKey[] = [];
    if (req.query.groupBy !== undefined) {
      const keys = csv(req.query.groupBy, "groupBy");
      if (!Array.isArray(keys) || keys.some((k) => !(GROUP_KEYS as string[]).includes(k))) {
        res.status(400).json({ error: `groupBy must be a comma-separated subset of ${GROUP_KEYS.join(", ")}` });
        return;
      }
      groupBy = GROUP_KEYS.filter((k) => keys.includes(k));
    }

    if (!(await isStatsRollupReady(TASK_UNITS_ROLLUP_NAME))) {
      res.status(503).json({ error: `stats rollup '${TASK_UNITS_ROLLUP_NAME}' is not built yet (scripts/rebuild-stats-rollup.ts ${TASK_UNITS_ROLLUP_NAME})` });
      return;
    }

    const filters: TaskUnitsFilters = {
      serviceName,
      ...(taskNames && { taskNames: taskNames as string[] }),
      ...(costNames && { costNames: costNames as string[] }),
      ...(costNamePrefix && { costNamePrefix: costNamePrefix as string }),
      ...(costSource && { costSource }),
      ...(since && { since: since as string }),
    };
    const rows = await readTaskUnits(filters, groupBy);
    const totalRow = rows.find((r) => r.isTotal);
    const empty: TaskUnitsRow = { keys: {}, isTotal: true, run_count: "0", org_count: "0", n_actual: "0", quantity: "0", gross: "0", net: "0" };

    const nullLast = (v: string | null | undefined) => v ?? "￿";
    const groups = rows
      .filter((r) => !r.isTotal)
      .sort((a, b) => {
        for (const k of groupBy) {
          const x = nullLast(a.keys[k]);
          const y = nullLast(b.keys[k]);
          if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
      })
      .map((r) => ({ ...r.keys, ...figures(r) }));

    res.json({
      serviceName,
      since: since ?? null,
      statuses: ["actual"],
      groupBy,
      groups: groupBy.length > 0 ? groups : [],
      total: figures(totalRow ?? empty),
    });
  } catch (err) {
    console.error("[Runs Service] Error in GET /internal/stats/costs/task-units:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
