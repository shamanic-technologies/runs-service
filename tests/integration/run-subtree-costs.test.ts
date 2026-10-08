import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";

// GET /internal/runs/subtree-costs — every matching run with its subtree's
// committed cost on the billed, net and vendor bases, in one read. Per run it
// must equal the two paged reads features-service walked before:
// GET /internal/runs/vendor (billed, vendor, unpriced) and
// GET /v1/runs?include=subtreeCost (net).

const ORG_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const OTHER_ORG = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a";
const BRAND_ID = "brand-subtree-costs";
const OTHER_BRAND = "brand-subtree-costs-other";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});

const VERSIONS = [
  { costName: "tok", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "6", vendorUnitCostInUsdCents: "1" },
  { costName: "tok", servedFrom: "2026-09-15T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" },
  { costName: "tok", servedFrom: "2026-09-20T00:00:00Z", billedUnitCostInUsdCents: "6", vendorUnitCostInUsdCents: "1.2" },
  { costName: "reveal", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "3", vendorUnitCostInUsdCents: "0.3333333333" },
  { costName: "unknown", servedFrom: "2026-09-01T00:00:00Z", billedUnitCostInUsdCents: "2", vendorUnitCostInUsdCents: null },
];

const API_KEY = { "x-api-key": "test-api-key" };
const FILTER = { brandId: BRAND_ID, serviceName: "lead-service", taskName: "lead-serve" };

async function cost(runId: string, costName: string, qty: string, unit: string, createdAt: string, extra: Record<string, string> = {}) {
  const gross = new Decimal(qty).times(unit);
  await insertTestRunCost({
    runId,
    costName,
    quantity: qty,
    unitCostInUsdCents: unit,
    totalCostInUsdCents: gross.toFixed(10),
    createdAt: new Date(createdAt),
    ...extra,
  });
}

async function serve(startedAt: string, extra: Record<string, unknown> = {}) {
  const r = await insertTestRun({
    organizationId: ORG_ID,
    serviceName: "lead-service",
    taskName: "lead-serve",
    brandIds: [BRAND_ID],
    status: "completed",
    startedAt: new Date(startedAt),
    ...extra,
  });
  return r.id;
}

async function child(parentRunId: string, startedAt: string) {
  const r = await insertTestRun({
    organizationId: ORG_ID,
    serviceName: "apollo-service",
    taskName: "enrich",
    parentRunId,
    brandIds: [BRAND_ID],
    status: "completed",
    startedAt: new Date(startedAt),
  });
  return r.id;
}

describe("GET /internal/runs/subtree-costs", () => {
  const app = createTestApp();
  let deep: string;
  let bare: string;

  beforeAll(async () => {
    await cleanTestData([ORG_ID, OTHER_ORG]);
    catalog.fn.mockResolvedValue(VERSIONS);

    // A serve with a 3-level subtree: own rows, child, grandchild; every status.
    deep = await serve("2026-09-21T10:00:00Z", { audienceId: "aud-1", campaignId: "camp-1" });
    await cost(deep, "tok", "10", "6", "2026-09-21T10:00:01Z", { netCostInUsdCents: "48", usageDiscountPct: "0.2" });
    const c1 = await child(deep, "2026-09-21T10:00:02Z");
    await cost(c1, "reveal", "7", "3", "2026-09-21T10:00:03Z"); // pre-freeze: net == gross; vendor 2.3333333331
    await cost(c1, "unknown", "1", "2", "2026-09-21T10:00:03Z"); // unpriced 2
    await cost(c1, "tok", "4", "6", "2026-09-21T10:00:03Z", { status: "provisioned" }); // not committed
    const g1 = await child(c1, "2026-09-21T10:00:04Z");
    await cost(g1, "tok", "3", "6", "2026-09-21T10:00:05Z", { netCostInUsdCents: "14.4", usageDiscountPct: "0.2" });
    await cost(g1, "tok", "100", "6", "2026-09-21T10:00:05Z", { status: "cancelled" }); // never counted
    await cost(g1, "tok", "50", "6", "2026-09-21T10:00:05Z", { status: "refunded" }); // not charged

    // A serve whose subtree has only a provisioned row, and one with nothing at all.
    const held = await serve("2026-09-16T10:00:00Z", { audienceId: "aud-2" });
    await cost(held, "tok", "10", "5", "2026-09-16T10:00:01Z", { status: "provisioned" });
    bare = await serve("2026-09-10T10:00:00Z");

    // A 5x-era serve priced by the 5x version.
    const old = await serve("2026-09-16T11:00:00Z", { audienceId: "aud-1", campaignId: "camp-2" });
    await cost(old, "tok", "10", "5", "2026-09-16T11:00:01Z");

    // Not matching: another brand, another task, another org.
    const otherBrand = await insertTestRun({ organizationId: ORG_ID, serviceName: "lead-service", taskName: "lead-serve", brandIds: [OTHER_BRAND], status: "completed" });
    await cost(otherBrand.id, "tok", "1", "6", "2026-09-21T10:00:01Z");
    await insertTestRun({ organizationId: ORG_ID, serviceName: "lead-service", taskName: "other", brandIds: [BRAND_ID], status: "completed" });
    await insertTestRun({ organizationId: OTHER_ORG, serviceName: "lead-service", taskName: "lead-serve", brandIds: [BRAND_ID], status: "completed" });
  });

  afterAll(async () => {
    await cleanTestData([ORG_ID, OTHER_ORG]);
    await closeDb();
  });

  it("states every matching run's committed subtree cost on the billed, net and vendor bases", async () => {
    const res = await request(app).get("/internal/runs/subtree-costs").query({ orgId: ORG_ID, ...FILTER }).set(API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(4);
    expect(res.body.runs[0]).toEqual({
      id: deep,
      audienceId: "aud-1",
      campaignId: "camp-1",
      actualCostInUsdCents: "101.0000000000", // 60 + 21 + 2 + 18
      netActualCostInUsdCents: "85.4000000000", // 48 + 21 + 2 + 14.4
      vendorActualCostInUsdCents: "17.9333333331", // 12 + 2.3333333331 + 3.6
      unpricedActualCostInUsdCents: "2.0000000000",
    });
    const last = res.body.runs[3];
    expect(last).toEqual({
      id: bare,
      audienceId: null,
      campaignId: null,
      actualCostInUsdCents: "0.0000000000",
      netActualCostInUsdCents: "0.0000000000",
      vendorActualCostInUsdCents: "0.0000000000",
      unpricedActualCostInUsdCents: "0.0000000000",
    });
  });

  it("equals GET /internal/runs/vendor + GET /v1/runs?include=subtreeCost run for run, same order", async () => {
    const [one, vendor, net] = await Promise.all([
      request(app).get("/internal/runs/subtree-costs").query({ orgId: ORG_ID, ...FILTER }).set(API_KEY),
      request(app).get("/internal/runs/vendor").query({ orgId: ORG_ID, ...FILTER, limit: "500" }).set(API_KEY),
      request(app).get("/v1/runs").query({ ...FILTER, limit: "500", include: "subtreeCost" }).set({ ...API_KEY, "x-org-id": ORG_ID }),
    ]);
    expect(vendor.status).toBe(200);
    expect(net.status).toBe(200);
    const netById = new Map(net.body.runs.map((r: any) => [r.id, r.netActualCostInUsdCents]));
    const expected = vendor.body.runs.map((r: any) => ({
      id: r.id,
      audienceId: r.audienceId,
      campaignId: r.campaignId,
      actualCostInUsdCents: r.actualCostInUsdCents,
      netActualCostInUsdCents: netById.get(r.id),
      vendorActualCostInUsdCents: r.vendorActualCostInUsdCents,
      unpricedActualCostInUsdCents: r.unpricedActualCostInUsdCents,
    }));
    expect(one.body.runs).toEqual(expected);
  });

  it("filters by campaign", async () => {
    const res = await request(app).get("/internal/runs/subtree-costs").query({ orgId: ORG_ID, campaignId: "camp-2" }).set(API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: any) => [r.campaignId, r.actualCostInUsdCents, r.vendorActualCostInUsdCents])).toEqual([
      ["camp-2", "50.0000000000", "10.0000000000"],
    ]);
  });

  it("refuses an unbounded or malformed read", async () => {
    const cases: Array<Record<string, string>> = [
      { brandId: BRAND_ID },
      { orgId: "not-a-uuid", brandId: BRAND_ID },
      { orgId: ORG_ID },
      { orgId: ORG_ID, serviceName: "lead-service" },
      { orgId: ORG_ID, brandId: "" },
    ];
    for (const q of cases) {
      const res = await request(app).get("/internal/runs/subtree-costs").query(q).set(API_KEY);
      expect(res.status, JSON.stringify(q)).toBe(400);
    }
  });

  it("502s when the vendor catalogue cannot be read, never an all-unpriced 200", async () => {
    const { VendorCostCatalogError } = await import("../../src/services/vendor-costs.js");
    catalog.fn.mockRejectedValueOnce(new VendorCostCatalogError("costs-service down"));
    const res = await request(app).get("/internal/runs/subtree-costs").query({ orgId: ORG_ID, ...FILTER }).set(API_KEY);
    expect(res.status).toBe(502);
  });

  it("requires the service key", async () => {
    const res = await request(app).get("/internal/runs/subtree-costs").query({ orgId: ORG_ID, ...FILTER });
    expect(res.status).toBe(401);
  });
});
