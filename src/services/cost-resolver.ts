const COSTS_SERVICE_URL = process.env.COSTS_SERVICE_URL || "https://costs.mcpfactory.org";
const COSTS_SERVICE_API_KEY = process.env.COSTS_SERVICE_API_KEY;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000;
const RETRYABLE_STATUS_CODES = new Set([502, 503, 429]);

export class CostNotFoundError extends Error {
  constructor(public readonly costName: string) {
    super(`Cost not found: ${costName}`);
  }
}

export class UpstreamError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface ResolvedCost {
  name: string;
  costPerUnitInUsdCents: string;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof UpstreamError) return RETRYABLE_STATUS_CODES.has(err.statusCode);
  // Network errors (fetch throws TypeError on connection failure)
  if (err instanceof TypeError) return true;
  // AbortError from timeout
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveUnitCost(name: string): Promise<ResolvedCost> {
  const headers: Record<string, string> = {};
  if (COSTS_SERVICE_API_KEY) {
    headers["X-API-Key"] = COSTS_SERVICE_API_KEY;
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(INITIAL_BACKOFF_MS * 2 ** (attempt - 1));
    }

    try {
      const res = await fetch(
        `${COSTS_SERVICE_URL}/v1/costs/${encodeURIComponent(name)}`,
        { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
      );

      if (res.status === 404) {
        throw new CostNotFoundError(name);
      }
      if (!res.ok) {
        throw new UpstreamError(res.status, `costs-service returned ${res.status}`);
      }

      const data = await res.json();
      return { name: data.name, costPerUnitInUsdCents: data.costPerUnitInUsdCents };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) throw err;
    }
  }

  throw lastError;
}

export async function resolveMultipleUnitCosts(
  names: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(names)];
  const results = await Promise.all(unique.map(resolveUnitCost));
  const map = new Map<string, string>();
  for (const r of results) {
    map.set(r.name, r.costPerUnitInUsdCents);
  }
  return map;
}
