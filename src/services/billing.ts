const FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000;
const RETRYABLE_STATUS_CODES = new Set([502, 503, 429]);

export class BillingError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof BillingError) return RETRYABLE_STATUS_CODES.has(err.statusCode);
  if (err instanceof TypeError) return true;
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BillingContext {
  orgId: string;
  userId: string;
  runId: string;
  brandIds?: string[];
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}

function buildHeaders(ctx: BillingContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (apiKey) headers["x-api-key"] = apiKey;
  headers["x-org-id"] = ctx.orgId;
  headers["x-user-id"] = ctx.userId;
  headers["x-run-id"] = ctx.runId;
  if (ctx.brandIds && ctx.brandIds.length > 0) headers["x-brand-id"] = ctx.brandIds.join(",");
  if (ctx.campaignId) headers["x-campaign-id"] = ctx.campaignId;
  if (ctx.workflowSlug) headers["x-workflow-slug"] = ctx.workflowSlug;
  if (ctx.featureSlug) headers["x-feature-slug"] = ctx.featureSlug;
  return headers;
}

async function billingFetch(
  path: string,
  options: RequestInit,
): Promise<Response> {
  const billingUrl = process.env.BILLING_SERVICE_URL;
  if (!billingUrl) {
    throw new BillingError(502, "BILLING_SERVICE_URL is not configured");
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(INITIAL_BACKOFF_MS * 2 ** (attempt - 1));
    }

    try {
      const res = await fetch(`${billingUrl}${path}`, {
        ...options,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        throw new BillingError(res.status, `billing-service returned ${res.status}`);
      }

      return res;
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) throw err;
    }
  }

  throw lastError;
}

// --- Usage notification (fire-and-forget cache-invalidation hint) ---
//
// runs_costs is the source of truth for run-level platform spend. billing-service
// re-derives the truth on every authorize via GET /internal/org-usage-total.
// This notify call is a hint that allows billing-service to invalidate any cache
// proactively. Failures are logged to Railway and do NOT block the run lifecycle.
export async function notifyUsage(
  ctx: BillingContext,
  payload: { spentTotalCents: string },
): Promise<void> {
  try {
    await billingFetch("/v1/credits/usage-notify", {
      method: "POST",
      headers: buildHeaders(ctx),
      body: JSON.stringify({ spent_total_cents: payload.spentTotalCents }),
    });
  } catch (err) {
    console.error("[runs-service] notifyUsage failed:", err);
  }
}
