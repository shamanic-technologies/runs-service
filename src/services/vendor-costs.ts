// VENDOR cost of a cost row — what that unit really cost us from the vendor,
// before our markup — as stated by costs-service, never derived here.
//
// A runs_costs row freezes the BILLED unit price (whatever costs-service's
// platform price was at write time) and nothing about the vendor. The markup
// has changed over time (6x -> 5x on 2026-09-15), some vendors carry VAT and
// pass-through lines carry no markup at all, so dividing a billed figure by a
// constant is wrong for part of every history. costs-service owns the price
// catalogue, so it owns the statement "price version V of cost name N cost us
// X from the vendor" — including "unknown" (null), which this service reports
// as UNPRICED billed spend and never folds in at the billed price.
//
// ⚠️ The vendor cost reveals our margin. Everything built on this module is
// served on service-auth routes only (`/internal/*`), never on a public one.

export interface VendorCostVersion {
  costName: string;
  /**
   * The instant this version started being served: the later of its effective_from and its
   * created_at — exactly when `/v1/platform-prices/{name}` could first have returned it, i.e.
   * the earliest a runs row could have frozen its price (costs-service's own "would have
   * served" rule on `GET /internal/vendor-costs/:name?at=`).
   */
  servedFrom: string;
  /** The billed (platform) unit price of this version — what a cost row froze. Null for a delisted version. */
  billedUnitCostInUsdCents: string | null;
  /** The vendor unit cost of this version. Null when costs-service cannot state it. */
  vendorUnitCostInUsdCents: string | null;
}

export class VendorCostCatalogError extends Error {}

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60_000;

let cache: { at: number; versions: VendorCostVersion[] } | null = null;

/** Test hook — the catalogue is cached process-wide. */
export function resetVendorCostCache(): void {
  cache = null;
}

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function decimalOrNull(value: unknown, where: string): string | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && DECIMAL_RE.test(value)) return value;
  throw new VendorCostCatalogError(`costs-service vendor catalogue: ${where} is not a decimal or null`);
}

/**
 * Every price version of every cost name, with its vendor unit cost. Fetched in
 * ONE service-auth call and cached for five minutes: the catalogue changes only
 * when costs-service seeds a new price version, and a version stated after the
 * cache was filled only moves rows written in the last few minutes.
 *
 * Fail loud: an unreachable or malformed catalogue throws — a vendor-basis read
 * that silently served everything as unpriced would read as "no vendor cost is
 * known" rather than "we could not ask".
 */
export async function fetchVendorCostCatalog(): Promise<VendorCostVersion[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.versions;

  const url = process.env.COSTS_SERVICE_URL;
  const apiKey = process.env.COSTS_SERVICE_API_KEY;
  if (!url || !apiKey) throw new VendorCostCatalogError("COSTS_SERVICE_URL or COSTS_SERVICE_API_KEY not configured");

  const res = await fetch(`${url}/internal/vendor-costs`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable body)");
    throw new VendorCostCatalogError(`costs-service vendor catalogue returned ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { versions?: unknown };
  if (!Array.isArray(data.versions)) {
    throw new VendorCostCatalogError("costs-service vendor catalogue returned no versions array");
  }

  const versions = data.versions.map((raw, i): VendorCostVersion => {
    const v = raw as Record<string, unknown>;
    if (typeof v.name !== "string" || typeof v.effectiveFrom !== "string" || typeof v.createdAt !== "string") {
      throw new VendorCostCatalogError(`costs-service vendor catalogue: version ${i} lacks name/effectiveFrom/createdAt`);
    }
    const effectiveFrom = Date.parse(v.effectiveFrom);
    const createdAt = Date.parse(v.createdAt);
    if (Number.isNaN(effectiveFrom) || Number.isNaN(createdAt)) {
      throw new VendorCostCatalogError(`costs-service vendor catalogue: version ${i} has an invalid timestamp`);
    }
    if (v.vendorCostKnown === true && v.vendorCostPerUnitInUsdCents === null) {
      throw new VendorCostCatalogError(`costs-service vendor catalogue: version ${i} is known but carries no vendor cost`);
    }
    return {
      costName: v.name,
      servedFrom: new Date(Math.max(effectiveFrom, createdAt)).toISOString(),
      billedUnitCostInUsdCents: decimalOrNull(v.billedPricePerUnitInUsdCents, `version ${i} billedPricePerUnitInUsdCents`),
      vendorUnitCostInUsdCents: decimalOrNull(v.vendorCostPerUnitInUsdCents, `version ${i} vendorCostPerUnitInUsdCents`),
    };
  });

  cache = { at: Date.now(), versions };
  return versions;
}
