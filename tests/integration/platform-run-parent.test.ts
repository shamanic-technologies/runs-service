import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders, getPlatformAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

// COST-ACCOUNTING-1023-P1: chat-service serves platform LLM calls ON BEHALF of a
// caller's run. The platform run is opened as that run's CHILD (body.parentRunId),
// so its spend lands in the caller's subtree and rolls into the caller's nearest
// declaring ancestor, while it stays platform-billed: the parent's org is never
// charged, because the child inherits nothing from its parent.

const ORG = "0c05acc0-1023-4c0a-8b1e-0000000000a1";
const OTHER_ORG = "0c05acc0-1023-4c0a-8b1e-0000000000a2";

vi.mock("../../src/services/cost-resolver.js", () => ({
  resolveMultipleUnitCosts: vi.fn().mockResolvedValue(new Map([["tok", "5.0000000000"]])),
  CostNotFoundError: class CostNotFoundError extends Error {
    costName = "";
  },
  UpstreamError: class UpstreamError extends Error {},
}));
vi.mock("../../src/services/billing.js", () => ({
  notifyUsage: vi.fn().mockResolvedValue(undefined),
  fetchOrgPlatformSpent: vi.fn().mockResolvedValue(0),
}));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return {
    ...actual,
    fetchVendorCostCatalog: vi.fn().mockResolvedValue([
      { costName: "tok", provider: "acme", servedFrom: "2024-01-01T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" },
    ]),
  };
});
vi.mock("../../src/services/outcome-catalogue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/outcome-catalogue.js")>();
  return { ...actual, unknownOutcomeKeys: vi.fn().mockResolvedValue([]) };
});

const app = createTestApp();
const orgHeaders = getAuthHeaders({ orgId: ORG });
const platform = getPlatformAuthHeaders({ serviceName: "chat-service" });
const internal = getInternalAuthHeaders();

async function orgRun() {
  const res = await request(app).post("/v1/runs").set(orgHeaders).send({ serviceName: "instantly-service", taskName: "classify-reply" });
  expect(res.status).toBe(201);
  return res.body;
}

async function platformChild(body: Record<string, unknown>, headers: Record<string, string> = platform) {
  return request(app).post("/v1/platform-runs").set(headers).send({ serviceName: "chat-service", taskName: "platform-judgments", ...body });
}

async function spend(runId: string, qty: number) {
  const res = await request(app).post(`/v1/platform-runs/${runId}/costs`).set(platform).send({ items: [{ costName: "tok", costSource: "platform", quantity: qty }] });
  expect(res.status).toBe(201);
  const done = await request(app).patch(`/v1/platform-runs/${runId}`).set(platform).send({ status: "completed" });
  expect(done.status).toBe(200);
}

async function orgCharges() {
  const usage = await request(app).get("/internal/org-usage-total").set(internal).query({ org_id: ORG });
  const actual = await request(app).get("/internal/org-actual-total").set(internal).query({ org_id: ORG });
  expect(usage.status).toBe(200);
  expect(actual.status).toBe(200);
  return {
    spent: usage.body.spent_cents,
    netSpent: usage.body.net_spent_cents,
    actual: actual.body.total_expected_cents,
    netActual: actual.body.net_total_expected_cents,
  };
}

describe("POST /v1/platform-runs with body.parentRunId", () => {
  beforeEach(async () => {
    await cleanTestData([ORG, OTHER_ORG, null]);
  });

  afterAll(async () => {
    await cleanTestData([ORG, OTHER_ORG, null]);
    await closeDb();
  });

  it("a platform run under an ORG run is that run's child, its cost counts in the subtree, and the org is not charged", async () => {
    const parent = await orgRun();
    const before = await orgCharges();

    const res = await platformChild({ parentRunId: parent.id });
    expect(res.status).toBe(201);
    expect(res.body.parentRunId).toBe(parent.id);
    // Nothing inherited: org-less, user-less, platform-billed.
    expect(res.body.organizationId).toBeNull();
    expect(res.body.userId).toBeNull();
    await spend(res.body.id, 4); // 20 cents

    const [costRow] = await db.select().from(runsCosts).where(eq(runsCosts.runId, res.body.id));
    expect(costRow.costSource).toBe("platform");
    expect(costRow.organizationId).toBeNull();

    // Subtree: the parent's tree total now includes the child's 20 cents.
    const tree = await request(app).get(`/v1/runs/${parent.id}`).set(orgHeaders);
    expect(tree.status).toBe(200);
    expect(tree.body.totalCostInUsdCents).toBe("20.0000000000");
    expect(tree.body.descendantRuns.map((d: any) => d.id)).toContain(res.body.id);

    // Who pays: the org's charge reads did not move.
    expect(await orgCharges()).toEqual(before);
  });

  it("the child's cost rolls into the parent's declared occurrences (outcome ledger)", async () => {
    const parent = await orgRun();
    const child = await platformChild({ parentRunId: parent.id });
    expect(child.status).toBe(201);
    await spend(child.body.id, 4); // 20 cents gross, 4 cents vendor

    const declared = await request(app)
      .post(`/v1/runs/${parent.id}/outcomes`)
      .set(orgHeaders)
      .send({
        produced: [
          { outcomeKey: "conversation", subjectService: "lead-service", subjectId: "reply-1" },
          { outcomeKey: "conversation", subjectService: "lead-service", subjectId: "reply-2" },
        ],
      });
    expect(declared.status).toBe(201);

    const occ = await request(app).get(`/internal/outcome-occurrences?runIds=${parent.id}`).set(internal);
    expect(occ.status).toBe(200);
    expect(occ.body.occurrences.map((o: any) => o.cost.grossCents)).toEqual(["10.0000000000", "10.0000000000"]);
    expect(occ.body.occurrences.every((o: any) => o.cost.vendorCents === "2.0000000000")).toBe(true);
  });

  it("a platform run under a PLATFORM run is its child too", async () => {
    const root = await platformChild({});
    const child = await platformChild({ parentRunId: root.body.id });
    expect(child.status).toBe(201);
    expect(child.body.parentRunId).toBe(root.body.id);
    expect(child.body.organizationId).toBeNull();
  });

  it("no parent named = a root run, exactly as before (x-run-id stays ignored here)", async () => {
    const parent = await orgRun();
    const res = await platformChild({}, { ...platform, "x-run-id": parent.id });
    expect(res.status).toBe(201);
    expect(res.body.parentRunId).toBeNull();
    expect(res.body.organizationId).toBeNull();
  });

  it("an unknown parent is refused with parent_run_not_found, nothing created", async () => {
    const ghost = "0c05acc0-1023-4c0a-8b1e-00000000dead";
    const res = await platformChild({ parentRunId: ghost, idempotencyKey: "test:ghost-parent" });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "parent_run_not_found", parentRunId: ghost });
    const rows = await db.select().from(runs).where(eq(runs.idempotencyKey, "test:ghost-parent"));
    expect(rows).toHaveLength(0);
  });

  it("a malformed parentRunId is a 400", async () => {
    const res = await platformChild({ parentRunId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("an x-org-id naming another org than the parent's is parent_org_mismatch; the same org is accepted", async () => {
    const parent = await orgRun();
    const mismatch = await platformChild({ parentRunId: parent.id }, { ...platform, "x-org-id": OTHER_ORG });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error).toBe("parent_org_mismatch");

    const same = await platformChild({ parentRunId: parent.id }, { ...platform, "x-org-id": ORG });
    expect(same.status).toBe(201);
    expect(same.body.organizationId).toBe(ORG);
  });
});
