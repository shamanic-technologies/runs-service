import { describe, it, expect } from "vitest";
import {
  CreateRunRequestSchema,
  UpdateRunRequestSchema,
  AddCostsRequestSchema,
} from "../../src/schemas.js";

describe("schemas", () => {
  describe("CreateRunRequestSchema", () => {
    it("accepts valid input with required fields", () => {
      const result = CreateRunRequestSchema.safeParse({
        clerkOrgId: "org_clerk_123",
        appId: "my-app",
        serviceName: "my-agent",
        taskName: "run-task",
      });
      expect(result.success).toBe(true);
    });

    it("accepts all optional fields", () => {
      const result = CreateRunRequestSchema.safeParse({
        clerkOrgId: "org_clerk_123",
        clerkUserId: "user_clerk_456",
        appId: "my-app",
        brandId: "brand_1",
        campaignId: "campaign_1",
        serviceName: "my-agent",
        taskName: "run-task",
        parentRunId: "770e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing clerkOrgId", () => {
      const result = CreateRunRequestSchema.safeParse({
        appId: "my-app",
        serviceName: "my-agent",
        taskName: "run-task",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing appId", () => {
      const result = CreateRunRequestSchema.safeParse({
        clerkOrgId: "org_clerk_123",
        serviceName: "my-agent",
        taskName: "run-task",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing serviceName", () => {
      const result = CreateRunRequestSchema.safeParse({
        clerkOrgId: "org_clerk_123",
        appId: "my-app",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty serviceName", () => {
      const result = CreateRunRequestSchema.safeParse({
        clerkOrgId: "org_clerk_123",
        appId: "my-app",
        serviceName: "",
        taskName: "task",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty appId", () => {
      const result = CreateRunRequestSchema.safeParse({
        clerkOrgId: "org_clerk_123",
        appId: "",
        serviceName: "svc",
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
