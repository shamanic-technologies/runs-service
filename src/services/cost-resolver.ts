const COSTS_SERVICE_URL = process.env.COSTS_SERVICE_URL || "https://costs.mcpfactory.org";
const COSTS_SERVICE_API_KEY = process.env.COSTS_SERVICE_API_KEY;

export class CostNotFoundError extends Error {
  constructor(public readonly costName: string) {
    super(`Cost not found: ${costName}`);
  }
}

export interface ResolvedCost {
  name: string;
  costPerUnitInUsdCents: string;
}

export async function resolveUnitCost(name: string): Promise<ResolvedCost> {
  const headers: Record<string, string> = {};
  if (COSTS_SERVICE_API_KEY) {
    headers["X-API-Key"] = COSTS_SERVICE_API_KEY;
  }

  const res = await fetch(
    `${COSTS_SERVICE_URL}/v1/costs/${encodeURIComponent(name)}`,
    { headers }
  );

  if (res.status === 404) {
    throw new CostNotFoundError(name);
  }
  if (!res.ok) {
    throw new Error(`costs-service returned ${res.status}`);
  }

  const data = await res.json();
  return { name: data.name, costPerUnitInUsdCents: data.costPerUnitInUsdCents };
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
