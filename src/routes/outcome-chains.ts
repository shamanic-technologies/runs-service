import { Router } from "express";
import { requireInternalAuth } from "../middleware/auth.js";
import {
  CHANGES_DEFAULT_LIMIT,
  CHANGES_MAX_LIMIT,
  OutcomeChainCursorError,
  OutcomeChainsNotBuiltError,
  MAX_UNITS_PER_RESOLVE,
  readOutcomeChainChanges,
  resolveUnitDecisions,
  readScriptReach,
  readStepRates,
} from "../services/outcome-chains.js";

// SCRIPT-VALUE-RATING-1113-RUNS: the produce / consume graph, summarised (services/outcome-chains.ts).

const router = Router();
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIST = 200;

function fail(res: any, route: string, err: unknown) {
  if (err instanceof OutcomeChainsNotBuiltError) {
    res.status(503).json({ error: err.message });
    return;
  }
  if (err instanceof OutcomeChainCursorError) {
    res.status(400).json({ error: err.message });
    return;
  }
  console.error(`[Runs Service] Error in GET ${route}:`, err);
  res.status(500).json({ error: "Internal server error" });
}

function list(v: unknown, name: string): string[] | null | Error {
  if (v === undefined) return null;
  if (typeof v !== "string") return new Error(`${name} must be a comma-separated string`);
  const out = [...new Set(v.split(",").map((s) => s.trim()).filter(Boolean))];
  if (out.length === 0 || out.length > MAX_LIST) return new Error(`${name} must list between 1 and ${MAX_LIST} values`);
  return out;
}

function brandOf(v: unknown): string | null | Error {
  if (v === undefined) return null;
  if (typeof v !== "string" || v.trim() === "") return new Error("brandId must be a non-empty string");
  return v.trim();
}

/** GET /internal/stats/outcome-chains/step-rates — how often a consumed Unit of one outcome yields a Unit of another. */
router.get("/internal/stats/outcome-chains/step-rates", requireInternalAuth, async (req, res) => {
  try {
    const brandId = brandOf(req.query.brandId);
    if (brandId instanceof Error) {
      res.status(400).json({ error: brandId.message });
      return;
    }
    res.json(await readStepRates(brandId));
  } catch (err) {
    fail(res, "/internal/stats/outcome-chains/step-rates", err);
  }
});

/** GET /internal/stats/outcome-chains/script-reach — script runs per day by the outcomes their chain reached. */
router.get("/internal/stats/outcome-chains/script-reach", requireInternalAuth, async (req, res) => {
  try {
    const q = req.query as Record<string, unknown>;
    const brandId = brandOf(q.brandId);
    const scriptSlugs = list(q.scriptSlugs, "scriptSlugs");
    const scriptDynasties = list(q.scriptDynasties, "scriptDynasties");
    const campaignIds = list(q.campaignIds, "campaignIds");
    for (const v of [brandId, scriptSlugs, scriptDynasties, campaignIds]) {
      if (v instanceof Error) {
        res.status(400).json({ error: v.message });
        return;
      }
    }
    for (const k of ["since", "until"] as const) {
      if (q[k] !== undefined && (typeof q[k] !== "string" || !DAY_RE.test(q[k] as string))) {
        res.status(400).json({ error: `${k} must be a UTC day YYYY-MM-DD` });
        return;
      }
    }
    const groupBy = q.groupBy ?? "version";
    if (groupBy !== "version" && groupBy !== "dynasty") {
      res.status(400).json({ error: "groupBy must be version or dynasty" });
      return;
    }
    res.json(
      await readScriptReach({
        brandId: brandId as string | null,
        scriptSlugs: scriptSlugs as string[] | null,
        scriptDynasties: scriptDynasties as string[] | null,
        since: (q.since as string | undefined) ?? null,
        until: (q.until as string | undefined) ?? null,
        groupBy,
        campaignIds: campaignIds as string[] | null,
      }),
    );
  } catch (err) {
    fail(res, "/internal/stats/outcome-chains/script-reach", err);
  }
});

/** GET /internal/stats/outcome-chains/changes — raw rows each build moved, for a consumer keeping a copy. */
router.get("/internal/stats/outcome-chains/changes", requireInternalAuth, async (req, res) => {
  try {
    const { cursor, limit } = req.query as Record<string, unknown>;
    if (cursor !== undefined && (typeof cursor !== "string" || cursor === "")) {
      res.status(400).json({ error: "cursor must be the nextCursor a previous page served" });
      return;
    }
    let n = CHANGES_DEFAULT_LIMIT;
    if (limit !== undefined) {
      n = Number(limit);
      if (typeof limit !== "string" || !Number.isInteger(n) || n < 1 || n > CHANGES_MAX_LIMIT) {
        res.status(400).json({ error: `limit must be an integer between 1 and ${CHANGES_MAX_LIMIT}` });
        return;
      }
    }
    res.json(await readOutcomeChainChanges(cursor as string | undefined, n));
  } catch (err) {
    fail(res, "/internal/stats/outcome-chains/changes", err);
  }
});

/** POST /internal/stats/outcome-chains/unit-decisions — the script decision that made each named Unit, in script-reach terms. */
router.post("/internal/stats/outcome-chains/unit-decisions", requireInternalAuth, async (req, res) => {
  try {
    const units = (req.body as { units?: unknown })?.units;
    if (!Array.isArray(units) || units.length === 0 || units.length > MAX_UNITS_PER_RESOLVE) {
      res.status(400).json({ error: `units must list between 1 and ${MAX_UNITS_PER_RESOLVE} Units` });
      return;
    }
    const now = new Date().toISOString();
    const parsed = [];
    for (const u of units as any[]) {
      const str = (v: unknown) => typeof v === "string" && v.trim() !== "";
      if (!u || !str(u.outcomeKey) || !str(u.subjectService) || !str(u.subjectId) || (u.at !== undefined && (typeof u.at !== "string" || Number.isNaN(Date.parse(u.at))))) {
        res.status(400).json({ error: "each unit needs outcomeKey, subjectService, subjectId (strings) and an optional ISO `at`" });
        return;
      }
      parsed.push({ outcomeKey: u.outcomeKey, subjectService: u.subjectService, subjectId: u.subjectId, at: u.at ? new Date(u.at).toISOString() : now });
    }
    res.json(await resolveUnitDecisions(parsed));
  } catch (err) {
    fail(res, "/internal/stats/outcome-chains/unit-decisions", err);
  }
});

export default router;
