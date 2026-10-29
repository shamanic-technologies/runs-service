import { Router } from "express";
import { requireInternalAuth } from "../middleware/auth.js";
import { addDays, utcDay, type Money } from "../services/outcome-ledger.js";
import { firstOutcomeCostDay, MAX_RANGE_DAYS } from "../services/outcome-cost-totals.js";
import { BRAND_RUNS_MAX_LIMIT, readBrandLedger, readBrandLedgerRuns, type BrandBooks } from "../services/brand-ledger.js";
import { OUTCOME_UUID_RE } from "../schemas.js";

const router = Router();

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BRAND_RE = /^[A-Za-z0-9_-]{1,128}$/;

const wire = (m: Money) => ({ grossCents: m.gross, netCents: m.net, vendorCents: m.vendor, unpricedGrossCents: m.unpricedGross });
const wireBooks = (b: BrandBooks) => ({
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
    const l = await readBrandLedger(brandId, since, until);
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
    const unknown = Object.keys(req.query).filter((k) => k !== "before" && k !== "beforeId" && k !== "limit");
    if (unknown.length > 0) {
      res.status(400).json({ error: `unknown query parameter(s): ${unknown.join(", ")}; accepted: before, beforeId, limit` });
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
    res.json(await readBrandLedgerRuns(brandId, before, q.beforeId ?? null, limit));
  } catch (err) {
    console.error("[Runs Service] brand ledger runs read failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
