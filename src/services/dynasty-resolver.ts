const FETCH_TIMEOUT_MS = 10_000;

export interface DynastyEntry {
  dynastySlug: string;
  slugs: string[];
}

async function fetchJson<T>(url: string, apiKey: string | undefined): Promise<T> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["X-API-Key"] = apiKey;

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`Dynasty resolution failed: ${res.status} ${body}`);
  }

  return res.json() as Promise<T>;
}

export async function resolveWorkflowDynastySlugs(dynastySlug: string): Promise<string[]> {
  const url = process.env.WORKFLOW_SERVICE_URL;
  if (!url) throw new Error("WORKFLOW_SERVICE_URL not configured");
  const data = await fetchJson<{ slugs: string[] }>(
    `${url}/workflows/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`,
    process.env.WORKFLOW_SERVICE_API_KEY
  );
  return data.slugs;
}

export async function resolveFeatureDynastySlugs(dynastySlug: string): Promise<string[]> {
  const url = process.env.FEATURES_SERVICE_URL;
  if (!url) throw new Error("FEATURES_SERVICE_URL not configured");
  const data = await fetchJson<{ slugs: string[] }>(
    `${url}/features/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`,
    process.env.FEATURES_SERVICE_API_KEY
  );
  return data.slugs;
}

export async function fetchAllWorkflowDynasties(): Promise<DynastyEntry[]> {
  const url = process.env.WORKFLOW_SERVICE_URL;
  if (!url) throw new Error("WORKFLOW_SERVICE_URL not configured");
  const data = await fetchJson<{ dynasties: DynastyEntry[] }>(
    `${url}/workflows/dynasties`,
    process.env.WORKFLOW_SERVICE_API_KEY
  );
  return data.dynasties;
}

export async function fetchAllFeatureDynasties(): Promise<DynastyEntry[]> {
  const url = process.env.FEATURES_SERVICE_URL;
  if (!url) throw new Error("FEATURES_SERVICE_URL not configured");
  const data = await fetchJson<{ dynasties: DynastyEntry[] }>(
    `${url}/features/dynasties`,
    process.env.FEATURES_SERVICE_API_KEY
  );
  return data.dynasties;
}

export function buildSlugToDynastyMap(dynasties: DynastyEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of dynasties) {
    for (const slug of d.slugs) map.set(slug, d.dynastySlug);
  }
  return map;
}
