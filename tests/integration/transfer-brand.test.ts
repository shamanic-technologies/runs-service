import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, closeDb } from "../helpers/test-db.js";

// UUIDs that pass Zod v4 strict validation (version [1-8], variant [89abAB])
const SOURCE_ORG_ID = "11111111-1111-4111-a111-111111111111";
const TARGET_ORG_ID = "33333333-3333-4333-a333-333333333333";
const BRAND_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const BRAND_B = "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb";

describe("POST /internal/transfer-brand", () => {
  const app = createTestApp();
  const headers = getInternalAuthHeaders();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("Content-Type", "application/json")
      .send({ brandId: BRAND_A, sourceOrgId: SOURCE_ORG_ID, targetOrgId: TARGET_ORG_ID });

    expect(res.status).toBe(401);
  });

  it("returns 400 with invalid body", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ brandId: "not-a-uuid" });

    expect(res.status).toBe(400);
  });

  it("transfers solo-brand runs from source to target org", async () => {
    // Solo-brand run — should be transferred
    const run1 = await insertTestRun({
      organizationId: SOURCE_ORG_ID,
      serviceName: "test-service",
      taskName: "task-1",
      brandIds: [BRAND_A],
    });

    // Another solo-brand run — should be transferred
    const run2 = await insertTestRun({
      organizationId: SOURCE_ORG_ID,
      serviceName: "test-service",
      taskName: "task-2",
      brandIds: [BRAND_A],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ brandId: BRAND_A, sourceOrgId: SOURCE_ORG_ID, targetOrgId: TARGET_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([{ tableName: "runs", count: 2 }]);

    // Verify runs are now under target org
    const verifyRes = await request(app)
      .get(`/v1/runs/${run1.id}`)
      .set({
        ...headers,
        "x-org-id": TARGET_ORG_ID,
      });
    expect(verifyRes.body.organizationId).toBe(TARGET_ORG_ID);
  });

  it("skips co-branding runs (multiple brand IDs)", async () => {
    // Co-brand run — should NOT be transferred
    await insertTestRun({
      organizationId: SOURCE_ORG_ID,
      serviceName: "test-service",
      taskName: "task-cobranded",
      brandIds: [BRAND_A, BRAND_B],
    });

    // Solo-brand run — should be transferred
    await insertTestRun({
      organizationId: SOURCE_ORG_ID,
      serviceName: "test-service",
      taskName: "task-solo",
      brandIds: [BRAND_A],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ brandId: BRAND_A, sourceOrgId: SOURCE_ORG_ID, targetOrgId: TARGET_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([{ tableName: "runs", count: 1 }]);
  });

  it("skips runs with a different brand ID", async () => {
    await insertTestRun({
      organizationId: SOURCE_ORG_ID,
      serviceName: "test-service",
      taskName: "task-other-brand",
      brandIds: [BRAND_B],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ brandId: BRAND_A, sourceOrgId: SOURCE_ORG_ID, targetOrgId: TARGET_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([{ tableName: "runs", count: 0 }]);
  });

  it("skips runs from a different org", async () => {
    await insertTestRun({
      organizationId: TARGET_ORG_ID,
      serviceName: "test-service",
      taskName: "task-wrong-org",
      brandIds: [BRAND_A],
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ brandId: BRAND_A, sourceOrgId: SOURCE_ORG_ID, targetOrgId: TARGET_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([{ tableName: "runs", count: 0 }]);
  });

  it("is idempotent — second call is a no-op", async () => {
    await insertTestRun({
      organizationId: SOURCE_ORG_ID,
      serviceName: "test-service",
      taskName: "task-idempotent",
      brandIds: [BRAND_A],
    });

    const body = { brandId: BRAND_A, sourceOrgId: SOURCE_ORG_ID, targetOrgId: TARGET_ORG_ID };

    const res1 = await request(app).post("/internal/transfer-brand").set(headers).send(body);
    expect(res1.body.updatedTables).toEqual([{ tableName: "runs", count: 1 }]);

    const res2 = await request(app).post("/internal/transfer-brand").set(headers).send(body);
    expect(res2.body.updatedTables).toEqual([{ tableName: "runs", count: 0 }]);
  });

  it("skips runs with null brand_ids", async () => {
    await insertTestRun({
      organizationId: SOURCE_ORG_ID,
      serviceName: "test-service",
      taskName: "task-no-brand",
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ brandId: BRAND_A, sourceOrgId: SOURCE_ORG_ID, targetOrgId: TARGET_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([{ tableName: "runs", count: 0 }]);
  });
});
