// The outcome keys a run may declare = features-service's step catalogue
// (`GET /public/catalogue/steps`, rows[].key). A misspelled key would sit in the
// ledger and silently fall out of every per-outcome cost, so an unknown key is
// refused (400) — and an unreadable catalogue fails loud (502), never "accept
// blindly". Cached 5 min; an unknown key re-reads the catalogue once (a key the
// catalogue declared a minute ago is accepted without waiting for the cache).

export class OutcomeCatalogueError extends Error {}

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;
const MIN_REFETCH_MS = 30_000;

let cache: { at: number; keys: Set<string> } | null = null;

/** Test hook. */
export function resetOutcomeCatalogueCache(): void {
  cache = null;
}

async function fetchKeys(): Promise<Set<string>> {
  const url = process.env.FEATURES_SERVICE_URL;
  if (!url) throw new OutcomeCatalogueError("FEATURES_SERVICE_URL not configured");
  let res: Response;
  try {
    res = await fetch(`${url}/public/catalogue/steps`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new OutcomeCatalogueError(`features-service step catalogue unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) throw new OutcomeCatalogueError(`features-service step catalogue returned ${res.status}`);
  const body = (await res.json().catch(() => null)) as { rows?: Array<{ key?: unknown }> } | null;
  if (!body || !Array.isArray(body.rows) || body.rows.length === 0) {
    throw new OutcomeCatalogueError("features-service step catalogue returned no rows");
  }
  const keys = new Set<string>();
  for (const r of body.rows) if (typeof r.key === "string") keys.add(r.key);
  if (keys.size === 0) throw new OutcomeCatalogueError("features-service step catalogue rows carry no key");
  return keys;
}

/** Keys (already normalized) that the catalogue does not hold. Throws OutcomeCatalogueError when unreadable. */
export async function unknownOutcomeKeys(keys: string[]): Promise<string[]> {
  const now = Date.now();
  if (!cache || now - cache.at >= CACHE_TTL_MS) cache = { at: now, keys: await fetchKeys() };
  let unknown = [...new Set(keys)].filter((k) => !cache!.keys.has(k));
  if (unknown.length > 0 && now - cache.at >= MIN_REFETCH_MS) {
    cache = { at: Date.now(), keys: await fetchKeys() };
    unknown = unknown.filter((k) => !cache!.keys.has(k));
  }
  return unknown;
}
