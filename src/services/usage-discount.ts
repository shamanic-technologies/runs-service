// Org usage-discount resolution + net-cost freeze.
//
// The platform charges a per-org usage discount (a percentage owned by
// billing-service). Product decision: the discount is FROZEN at cost-write
// time on the `runs_costs` row, so every downstream reader reads gross or net
// with zero recomputation, and a later discount change is NON-RETROACTIVE.
//
// This module owns:
//   - resolveUsageDiscount(orgId): read the org's current discount fraction
//     [0,1] from billing-service (billing owns the value), with a short-lived
//     per-org cache to avoid a billing call on every cost write.
//   - netFromGross(gross, pct): the pure freeze math, net = gross * (1 - pct).
//
// Fail-loud doctrine (CLAUDE.md): when resolution is ENABLED and the discount
// genuinely cannot be resolved (billing unreachable / 5xx / malformed body),
// we THROW — we never silently write gross-as-net. The only non-error "zero
// discount" cases are: resolution disabled, no orgId, or billing returns 404
// (unknown org / no billing account) — all of which mean net == gross by
// definition, matching the "no discount / unknown org → net == gross" spec.
//
// Rollout gate: USAGE_DISCOUNT_RESOLUTION_ENABLED. Default OFF, so until
// billing-service ships GET /internal/accounts/by-org/{orgId}/usage-discount
// and ops flips the flag, every org resolves to 0 (net == gross) with NO
// billing call added to the hot cost-write path — zero regression, zero added
// latency. Enable it only once the billing endpoint is live in the same env
// (deploy-ordering: producer first).

import { Decimal } from "decimal.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000;
const RETRYABLE_STATUS_CODES = new Set([502, 503, 429]);
const CACHE_TTL_MS = 60_000;

export class UsageDiscountError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

function isResolutionEnabled(): boolean {
  return process.env.USAGE_DISCOUNT_RESOLUTION_ENABLED === "true";
}

function isRetryable(err: unknown): boolean {
  if (err instanceof UsageDiscountError) return RETRYABLE_STATUS_CODES.has(err.statusCode);
  if (err instanceof TypeError) return true; // fetch network failure
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-org cache of the resolved discount fraction. Only successful resolutions
// (including a 0 from a 404) are cached; errors are never cached so a transient
// billing outage self-heals on the next write.
type CacheEntry = { pct: Decimal; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/** Test-only: clear the per-org discount cache. */
export function __clearUsageDiscountCache(): void {
  cache.clear();
}

/**
 * Resolve the org's frozen usage-discount fraction in [0,1].
 * Returns 0 when resolution is disabled, no orgId is present, or billing has no
 * account for the org (404). Throws UsageDiscountError when enabled and billing
 * is unreachable / errors / returns a malformed or out-of-range value.
 */
export async function resolveUsageDiscount(orgId: string | null | undefined): Promise<Decimal> {
  if (!isResolutionEnabled() || !orgId) return ZERO;

  const cached = cache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.pct;

  const billingUrl = process.env.BILLING_SERVICE_URL;
  if (!billingUrl) {
    // Enabled but misconfigured — fail loud rather than silently skip.
    throw new UsageDiscountError(502, "BILLING_SERVICE_URL is not configured");
  }

  const headers: Record<string, string> = {};
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (apiKey) headers["x-api-key"] = apiKey;

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(INITIAL_BACKOFF_MS * 2 ** (attempt - 1));

    try {
      const res = await fetch(
        `${billingUrl}/internal/accounts/by-org/${encodeURIComponent(orgId)}/usage-discount`,
        { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );

      // Unknown org / no billing account (also covers a not-yet-deployed
      // endpoint): no discount → net == gross.
      if (res.status === 404) {
        cache.set(orgId, { pct: ZERO, expiresAt: Date.now() + CACHE_TTL_MS });
        return ZERO;
      }
      if (!res.ok) {
        throw new UsageDiscountError(res.status, `billing-service returned ${res.status}`);
      }

      const data = await res.json();
      const pct = parseDiscountFraction(data);
      cache.set(orgId, { pct, expiresAt: Date.now() + CACHE_TTL_MS });
      return pct;
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) throw err;
    }
  }

  throw lastError;
}

/**
 * Parse billing's discount response into a fraction in [0,1]. Accepts
 * `discount_pct` as a decimal string/number fraction (0.5 == 50%). Fail loud on
 * a missing/malformed/out-of-range value — never default to 0 here (that would
 * silently write gross-as-net when billing IS reachable but returns garbage).
 */
function parseDiscountFraction(data: unknown): Decimal {
  const raw = (data as { discount_pct?: unknown })?.discount_pct;
  if (raw === null || raw === undefined) {
    throw new UsageDiscountError(422, "billing-service usage-discount response missing discount_pct");
  }
  let pct: Decimal;
  try {
    pct = new Decimal(raw as Decimal.Value);
  } catch {
    throw new UsageDiscountError(422, `billing-service returned non-numeric discount_pct: ${String(raw)}`);
  }
  if (!pct.isFinite() || pct.lt(0) || pct.gt(1)) {
    throw new UsageDiscountError(422, `billing-service discount_pct out of [0,1] range: ${pct.toString()}`);
  }
  return pct;
}

/**
 * Freeze math: net = gross * (1 - pct), at numeric(16,10) scale. Pure function —
 * the frozen net is stored on the row and never recomputed on read, which is
 * what makes a later discount change non-retroactive.
 */
export function netFromGross(grossCents: string | Decimal, pct: Decimal): string {
  return new Decimal(grossCents).times(ONE.minus(pct)).toFixed(10);
}
