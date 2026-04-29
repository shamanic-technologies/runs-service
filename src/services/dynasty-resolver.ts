const FETCH_TIMEOUT_MS = 10_000;

export interface DynastyEntry {
  dynastySlug: string;
  slugs: string[];
}

export interface IdentityHeaders {
  orgId: string;
  userId?: string;
  runId?: string;
}

async function fetchJson<T>(url: string, apiKey: string | undefined, identity?: IdentityHeaders): Promise<T> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["X-API-Key"] = apiKey;
  if (identity?.orgId) headers["x-org-id"] = identity.orgId;
  if (identity?.userId) headers["x-user-id"] = identity.userId;
  if (identity?.runId) headers["x-run-id"] = identity.runId;

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

export async function resolveWorkflowDynastySlugs(dynastySlug: string, identity: IdentityHeaders): Promise<string[]> {
  const url = process.env.WORKFLOW_SERVICE_URL;
  if (!url) throw new Error("WORKFLOW_SERVICE_URL not configured");
  const data = await fetchJson<{ workflowSlugs: string[] }>(
    `${url}/workflows/dynasty/slugs?workflowDynastySlug=${encodeURIComponent(dynastySlug)}`,
    process.env.WORKFLOW_SERVICE_API_KEY,
    identity
  );
  return data.workflowSlugs;
}

export async function resolveFeatureDynastySlugs(dynastySlug: string, identity: IdentityHeaders): Promise<string[]> {
  const url = process.env.FEATURES_SERVICE_URL;
  if (!url) throw new Error("FEATURES_SERVICE_URL not configured");
  const data = await fetchJson<{ slugs: string[] }>(
    `${url}/features/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`,
    process.env.FEATURES_SERVICE_API_KEY,
    identity
  );
  return data.slugs;
}

export async function fetchAllWorkflowDynasties(identity: IdentityHeaders): Promise<DynastyEntry[]> {
  const url = process.env.WORKFLOW_SERVICE_URL;
  if (!url) throw new Error("WORKFLOW_SERVICE_URL not configured");
  const data = await fetchJson<{ dynasties: { workflowDynastySlug: string; workflowSlugs: string[] }[] }>(
    `${url}/workflows/dynasties`,
    process.env.WORKFLOW_SERVICE_API_KEY,
    identity
  );
  return data.dynasties.map((d) => ({ dynastySlug: d.workflowDynastySlug, slugs: d.workflowSlugs }));
}

export async function fetchAllFeatureDynasties(identity: IdentityHeaders): Promise<DynastyEntry[]> {
  const url = process.env.FEATURES_SERVICE_URL;
  if (!url) throw new Error("FEATURES_SERVICE_URL not configured");
  const data = await fetchJson<{ dynasties: DynastyEntry[] }>(
    `${url}/features/dynasties`,
    process.env.FEATURES_SERVICE_API_KEY,
    identity
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
