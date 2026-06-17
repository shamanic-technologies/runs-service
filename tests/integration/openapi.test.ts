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
    expect(res.body.paths["/internal/runs/by-org/{orgId}"]).toBeDefined();
    expect(res.body.components?.schemas).toBeDefined();
    expect(res.body.components.schemas.Run).toBeDefined();
    expect(res.body.components.schemas.Cost).toBeDefined();
    expect(res.body.components.schemas.RunWithCosts).toBeDefined();
    expect(res.body.components.schemas.DescendantRun).toBeDefined();
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
