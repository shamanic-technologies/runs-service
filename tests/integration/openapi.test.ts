import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";

describe("OpenAPI", () => {
  const app = createTestApp();

  it("GET /openapi.json returns valid OpenAPI 3.0 spec", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.0");
    expect(res.body.info.title).toBe("Runs Service");
    expect(res.body.paths).toBeDefined();
    expect(res.body.paths["/health"]).toBeDefined();
    expect(res.body.paths["/v1/runs"]).toBeDefined();
    expect(res.body.paths["/v1/runs/{id}"]).toBeDefined();
    expect(res.body.components?.schemas).toBeDefined();
    expect(res.body.components.schemas.Run).toBeDefined();
    expect(res.body.components.schemas.Cost).toBeDefined();
    expect(res.body.components.schemas.RunWithCosts).toBeDefined();
    expect(res.body.components.schemas.DescendantRun).toBeDefined();
  });

  it("documents GET /internal/stats/task-outcomes", async () => {
    const res = await request(app).get("/openapi.json");
    const op = res.body.paths["/internal/stats/task-outcomes"]?.get;
    expect(op).toBeDefined();
    const props = res.body.components.schemas.TaskOutcomesResponse.properties.tasks.items.properties;
    expect(Object.keys(props).sort()).toEqual([
      "avgCostInUsdCents", "avgDurationMs", "completedCount", "failedCount", "lastRunAt", "runningCount",
      "sampleSize", "successRate", "sumCompletedDurationMs", "sumCostInUsdCents", "taskName", "totalRunCount",
    ]);
  });

  it("documents the outcome-occurrence declaration and the production-cost reads (COST-ACCOUNTING-1023)", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.body.paths["/v1/runs/{id}/outcomes"]?.post).toBeDefined();
    expect(res.body.paths["/v1/platform-runs/{id}/outcomes"]?.post).toBeDefined();
    expect(res.body.paths["/internal/outcome-occurrences"]?.get).toBeDefined();
    expect(res.body.paths["/internal/outcome-costs/ledger-check"]?.get).toBeDefined();
    expect(res.body.paths["/internal/stats/outcome-coverage"]?.get).toBeDefined();
    expect(Object.keys(res.body.components.schemas.OutcomeOccurrenceInput.properties).sort()).toEqual(["outcomeKey", "quantity", "subjectId", "subjectService"]);
  });

  it("GET /openapi.json does not require authentication", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
  });

  it("GET /v1/runs description documents default sort, row shape, and id provenance", async () => {
    const res = await request(app).get("/openapi.json");
    const description = res.body.paths["/v1/runs"].get.description as string;
    expect(description).toMatch(/startedAt DESC/);
    expect(description).toMatch(/one (item|row) per run/i);
    expect(description).toMatch(/\/v1\/runs\/\{id\}/);
    expect(description).toMatch(/id/);
  });

  it("RunWithOwnCost extends Run (allOf) so list rows carry the run id", async () => {
    const res = await request(app).get("/openapi.json");
    const schema = res.body.components.schemas.RunWithOwnCost;
    expect(schema.allOf).toBeDefined();
    expect(schema.allOf[0].$ref).toBe("#/components/schemas/Run");
    const runSchema = res.body.components.schemas.Run;
    expect(runSchema.properties.id).toBeDefined();
    expect(runSchema.required).toContain("id");
  });
});
