import { Router } from "express";
import { requireInternalAuth } from "../middleware/auth.js";
import { addDays, utcDay, type Money } from "../services/outcome-ledger.js";
import { firstOutcomeCostDay, MAX_RANGE_DAYS } from "../services/outcome-cost-totals.js";
import { ledgerBackfillState, startLedgerBackfill } from "../services/outcome-ledger.js";
import { BRAND_RUN_KINDS, type BrandRunKind, BRAND_RUNS_MAX_LIMIT, readBrandLedgerCached, readBrandLedgerRuns, type BrandBooks } from "../services/brand-ledger.js";
import { OUTCOME_UUID_RE } from "../schemas.js";

const router = Router();

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BRAND_RE = /^[A-Za-z0-9_-]{1,128}$/;

const wire = (m: Money) => ({ grossCents: m.gross, netCents: m.net, vendorCents: m.vendor, unpricedGrossCents: m.unpricedGross });
const wireBooks = (b: BrandBooks) => ({
  production: wire(b.production),
  standardCharged: wire(b.standardCharged),
  reuseGain: wire(b.reuseGain),
  producedNone: wire(b.producedNone),
  support: wire(b.support),
  undeclared: wire(b.undeclared),
  abnormal: wire(b.abnormal),
  spend: wire(b.spend),
  difference: wire(b.difference),
  balanced: b.balanced,
});

const validDay = (d: string) => DAY_RE.test(d) && utcDay(new Date(`${d}T00:00:00Z`)) === d;

/**
 * GET /internal/brands/:brandId/ledger?since&until — the brand's books: standard cost charged,
 * reuse gain, spend of runs producing none, abnormal loss and the runs spend, reconciled to the
 * cent, over the range and per UTC day (stored days only; default since inception to today).
 */
router.get("/internal/brands/:brandId/ledger", requireInternalAuth, async (req, res) => {
  try {
    const unknown = Object.keys(req.query).filter((k) => k !== "since" && k !== "until");
    if (unknown.length > 0) {
      res.status(400).json({ error: `unknown query parameter(s): ${unknown.join(", ")}; accepted: since, until` });
      return;
    }
    const { brandId } = req.params;
    if (!BRAND_RE.test(brandId)) {
      res.status(400).json({ error: "brandId is not a brand id" });
      return;
    }
    const q = req.query as Record<string, string | undefined>;
    const until = q.until ?? utcDay(new Date());
    const since = q.since ?? (await firstOutcomeCostDay());
    if (!validDay(since) || !validDay(until)) {
      res.status(400).json({ error: "since/until must be YYYY-MM-DD" });
      return;
    }
    if (since > until) {
      res.status(400).json({ error: "since must be <= until" });
      return;
    }
    if (addDays(since, MAX_RANGE_DAYS) <= until) {
      res.status(400).json({ error: `range must be <= ${MAX_RANGE_DAYS} days` });
      return;
    }
    const l = await readBrandLedgerCached(brandId, since, until);
    res.json({
      brandId: l.brandId,
      since: l.since,
      until: l.until,
      complete: l.complete,
      daysMissing: l.daysMissing,
      books: wireBooks(l.books),
      days: l.days.map((d) => ({ day: d.day, occurrences: d.occurrences, ...wireBooks(d) })),
      outcomes: l.outcomes.map((o) => ({ outcomeKey: o.outcomeKey, occurrences: o.occurrences, cost: wire(o.cost) })),
    });
  } catch (err) {
    console.error("[Runs Service] brand ledger read failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /internal/brands/:brandId/ledger/runs?before&beforeId&limit — the brand's production orders,
 * newest first, each with its own cost, the outcomes it declared produced and consumed, and its
 * support mark. One page reads at most a 24h window before `before`; follow `nextBefore`.
 */
router.get("/internal/brands/:brandId/ledger/runs", requireInternalAuth, async (req, res) => {
  try {
    const unknown = Object.keys(req.query).filter((k) => !["before", "beforeId", "limit", "kind"].includes(k));
    if (unknown.length > 0) {
      res.status(400).json({ error: `unknown query parameter(s): ${unknown.join(", ")}; accepted: before, beforeId, limit, kind` });
      return;
    }
    const { brandId } = req.params;
    if (!BRAND_RE.test(brandId)) {
      res.status(400).json({ error: "brandId is not a brand id" });
      return;
    }
    const q = req.query as Record<string, string | undefined>;
    const before = q.before ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(before))) {
      res.status(400).json({ error: "before must be a timestamp" });
      return;
    }
    if (q.beforeId !== undefined && !OUTCOME_UUID_RE.test(q.beforeId)) {
      res.status(400).json({ error: "beforeId must be a run id" });
      return;
    }
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > BRAND_RUNS_MAX_LIMIT) {
      res.status(400).json({ error: `limit must be an integer 1..${BRAND_RUNS_MAX_LIMIT}` });
      return;
    }
    if (q.kind !== undefined && !(BRAND_RUN_KINDS as readonly string[]).includes(q.kind)) {
      res.status(400).json({ error: `kind must be one of ${BRAND_RUN_KINDS.join(", ")}` });
      return;
    }
    res.json(await readBrandLedgerRuns(brandId, before, q.beforeId ?? null, limit, (q.kind as BrandRunKind | undefined) ?? null));
  } catch (err) {
    console.error("[Runs Service] brand ledger runs read failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /internal/outcome-costs/backfill — computes, once, every past day not current under the
 * allocation version (missing, stale, older columns), paced to the box: one day at a time under
 * the refresher's lock, waiting while the database is busy, resting as long as each day took.
 * 202 with its state; 409 while one runs. GET returns the state (null before any).
 */
router.post("/internal/outcome-costs/backfill", requireInternalAuth, (req, res) => {
  const b = (req.body ?? {}) as { maxActive?: unknown; maxPasses?: unknown; restFactor?: unknown };
  const int = (v: unknown, lo: number, hi: number) => (v === undefined ? undefined : Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : NaN);
  const maxActive = int(b.maxActive, 1, 200);
  const maxPasses = int(b.maxPasses, 1, 10);
  const restFactor = b.restFactor === undefined ? undefined : typeof b.restFactor === "number" && b.restFactor >= 0 && b.restFactor <= 10 ? b.restFactor : NaN;
  if ([maxActive, maxPasses, restFactor].some((v) => v !== undefined && Number.isNaN(v))) {
    res.status(400).json({ error: "maxActive 1..200, maxPasses 1..10 (integers), restFactor 0..10" });
    return;
  }
  const state = startLedgerBackfill({ maxActive, maxPasses, restFactor });
  if (!state) {
    res.status(409).json({ error: "a backfill is already running", state: ledgerBackfillState() });
    return;
  }
  res.status(202).json(state);
});

router.get("/internal/outcome-costs/backfill", requireInternalAuth, (_req, res) => {
  res.json({ state: ledgerBackfillState() });
});

export default router;
