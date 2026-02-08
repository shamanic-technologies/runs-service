import { describe, it, expect } from "vitest";
import {
  CreateOrganizationRequestSchema,
  CreateUserRequestSchema,
  CreateRunRequestSchema,
  UpdateRunRequestSchema,
  AddCostsRequestSchema,
} from "../../src/schemas.js";

describe("schemas", () => {
  describe("CreateOrganizationRequestSchema", () => {
    it("accepts valid input", () => {
      const result = CreateOrganizationRequestSchema.safeParse({
        externalId: "org_123",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing externalId", () => {
      const result = CreateOrganizationRequestSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects empty externalId", () => {
      const result = CreateOrganizationRequestSchema.safeParse({
        externalId: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("CreateUserRequestSchema", () => {
    it("accepts valid input", () => {
      const result = CreateUserRequestSchema.safeParse({
        externalId: "user_456",
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing organizationId", () => {
      const result = CreateUserRequestSchema.safeParse({
        externalId: "user_456",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid uuid for organizationId", () => {
      const result = CreateUserRequestSchema.safeParse({
        externalId: "user_456",
        organizationId: "not-a-uuid",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("CreateRunRequestSchema", () => {
    it("accepts valid input with required fields", () => {
      const result = CreateRunRequestSchema.safeParse({
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
        serviceName: "my-agent",
        taskName: "run-task",
      });
      expect(result.success).toBe(true);
    });

    it("accepts optional userId and parentRunId", () => {
      const result = CreateRunRequestSchema.safeParse({
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
        serviceName: "my-agent",
        taskName: "run-task",
        userId: "660e8400-e29b-41d4-a716-446655440000",
        parentRunId: "770e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing required fields", () => {
      const result = CreateRunRequestSchema.safeParse({
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty serviceName", () => {
      const result = CreateRunRequestSchema.safeParse({
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
        serviceName: "",
        taskName: "task",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("UpdateRunRequestSchema", () => {
    it("accepts 'completed'", () => {
      const result = UpdateRunRequestSchema.safeParse({ status: "completed" });
      expect(result.success).toBe(true);
    });

    it("accepts 'failed'", () => {
      const result = UpdateRunRequestSchema.safeParse({ status: "failed" });
      expect(result.success).toBe(true);
    });

    it("rejects invalid status", () => {
      const result = UpdateRunRequestSchema.safeParse({ status: "running" });
      expect(result.success).toBe(false);
    });

    it("rejects missing status", () => {
      const result = UpdateRunRequestSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("AddCostsRequestSchema", () => {
    it("accepts valid cost items", () => {
      const result = AddCostsRequestSchema.safeParse({
        items: [
          { costName: "gpt-4o-input-token", quantity: 1000 },
          { costName: "gpt-4o-output-token", quantity: 200 },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty items array", () => {
      const result = AddCostsRequestSchema.safeParse({ items: [] });
      expect(result.success).toBe(false);
    });

    it("rejects missing items", () => {
      const result = AddCostsRequestSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects non-positive quantity", () => {
      const result = AddCostsRequestSchema.safeParse({
        items: [{ costName: "test", quantity: 0 }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty costName", () => {
      const result = AddCostsRequestSchema.safeParse({
        items: [{ costName: "", quantity: 1 }],
      });
      expect(result.success).toBe(false);
    });
  });
});
