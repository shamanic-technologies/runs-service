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

// --- Deduct ---

export interface DeductResult {
  success: boolean;
  balance_cents: number | null;
  billing_mode: string;
  depleted: boolean;
}

export async function deductCredits(
  amountCents: number,
  description: string,
  ctx: BillingContext,
): Promise<DeductResult> {
  const res = await billingFetch("/v1/credits/deduct", {
    method: "POST",
    headers: buildHeaders(ctx),
    body: JSON.stringify({ amount_cents: amountCents, description }),
  });
  return res.json() as Promise<DeductResult>;
}

// --- Provision ---

export interface ProvisionResult {
  transaction_id: string;
  balance_cents: number | null;
}

export async function provisionCredits(
  amountCents: number,
  description: string,
  ctx: BillingContext,
  costId: string,
): Promise<ProvisionResult> {
  const res = await billingFetch("/v1/credits/provision", {
    method: "POST",
    headers: buildHeaders(ctx),
    body: JSON.stringify({ amount_cents: amountCents, description, cost_id: costId }),
  });
  const body = (await res.json()) as { transaction_id?: string; provision_id?: string; balance_cents: number | null };
  // billing-service returns both `transaction_id` and `provision_id` (deprecated alias).
  // Prefer `transaction_id`; fall back to alias for transitional compatibility.
  const transactionId = body.transaction_id ?? body.provision_id;
  if (!transactionId) {
    throw new BillingError(502, "billing-service response missing transaction_id");
  }
  return { transaction_id: transactionId, balance_cents: body.balance_cents };
}

// --- Confirm provision (by cost_id) ---

export interface ConfirmResult {
  success: boolean;
  balance_cents: number | null;
}

export async function confirmProvision(
  costId: string,
  actualAmountCents: number,
  ctx: BillingContext,
): Promise<ConfirmResult> {
  const res = await billingFetch(
    `/v1/credits/provision/by-cost/${encodeURIComponent(costId)}/confirm`,
    {
      method: "POST",
      headers: buildHeaders(ctx),
      body: JSON.stringify({ actual_amount_cents: actualAmountCents }),
    },
  );
  return res.json() as Promise<ConfirmResult>;
}

// --- Cancel provision (by cost_id) ---

export interface CancelResult {
  success: boolean;
  balance_cents: number | null;
}

export async function cancelProvision(
  costId: string,
  ctx: BillingContext,
): Promise<CancelResult> {
  const res = await billingFetch(
    `/v1/credits/provision/by-cost/${encodeURIComponent(costId)}/cancel`,
    {
      method: "POST",
      headers: buildHeaders(ctx),
      body: JSON.stringify({}),
    },
  );
  return res.json() as Promise<CancelResult>;
}
