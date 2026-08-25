import { describe, it, expect } from "vitest";
import {
  CreateRunRequestSchema,
  UpdateRunRequestSchema,
  UpdateCostRequestSchema,
  RefundApplyRequestSchema,
  AddCostsRequestSchema,
} from "../../src/schemas.js";

describe("schemas", () => {
  describe("CreateRunRequestSchema", () => {
    it("accepts valid input with required fields", () => {
      const result = CreateRunRequestSchema.safeParse({
        serviceName: "my-agent",
        taskName: "run-task",
      });
      expect(result.success).toBe(true);
    });

    it("accepts all optional fields", () => {
      const result = CreateRunRequestSchema.safeParse({
        brandIds: ["aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"],
        campaignId: "campaign_1",
        workflowSlug: "wf-1",
        serviceName: "my-agent",
        taskName: "run-task",
        parentRunId: "770e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing serviceName", () => {
      const result = CreateRunRequestSchema.safeParse({
        taskName: "run-task",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing taskName", () => {
      const result = CreateRunRequestSchema.safeParse({
        serviceName: "my-agent",
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-UUID brandIds", () => {
      const result = CreateRunRequestSchema.safeParse({
        brandIds: ["lifecycle"],
        serviceName: "my-agent",
        taskName: "run-task",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty serviceName", () => {
      const result = CreateRunRequestSchema.safeParse({
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
          { costName: "gpt-4o-input-token", costSource: "platform", quantity: 1000 },
          { costName: "gpt-4o-output-token", costSource: "org", quantity: 200 },
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
        items: [{ costName: "test", costSource: "platform", quantity: 0 }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty costName", () => {
      const result = AddCostsRequestSchema.safeParse({
        items: [{ costName: "", costSource: "platform", quantity: 1 }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing costSource", () => {
      const result = AddCostsRequestSchema.safeParse({
        items: [{ costName: "test", quantity: 1 }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid costSource value", () => {
      const result = AddCostsRequestSchema.safeParse({
        items: [{ costName: "test", costSource: "invalid", quantity: 1 }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("UpdateCostRequestSchema — refunds", () => {
    it("accepts a refund carrying a reason and an actor", () => {
      const result = UpdateCostRequestSchema.safeParse({
        status: "refunded",
        reason: "provider incident, spend comped",
        refundedBy: "kevin@distribute.you",
      });
      expect(result.success).toBe(true);
    });

    it("rejects a refund with no motive — a refund with no reason is just a late cancel", () => {
      const result = UpdateCostRequestSchema.safeParse({
        status: "refunded",
        refundedBy: "kevin@distribute.you",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a refund with no actor", () => {
      const result = UpdateCostRequestSchema.safeParse({
        status: "refunded",
        reason: "provider incident, spend comped",
      });
      expect(result.success).toBe(false);
    });

    it("still accepts the pre-existing actual / cancelled transitions with no extra fields", () => {
      expect(UpdateCostRequestSchema.safeParse({ status: "actual" }).success).toBe(true);
      expect(UpdateCostRequestSchema.safeParse({ status: "cancelled" }).success).toBe(true);
    });
  });

  describe("cost creation cannot start out refunded", () => {
    it("rejects status refunded on a new cost item", () => {
      const result = AddCostsRequestSchema.safeParse({
        items: [{ costName: "token", costSource: "platform", quantity: 1, status: "refunded" }],
      });
      expect(result.success).toBe(false);
    });

    it("still accepts the three creatable statuses", () => {
      for (const status of ["actual", "provisioned", "cancelled"]) {
        const result = AddCostsRequestSchema.safeParse({
          items: [{ costName: "token", costSource: "platform", quantity: 1, status }],
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe("RefundApplyRequestSchema", () => {
    it("requires an org, a reason and an actor", () => {
      expect(RefundApplyRequestSchema.safeParse({ orgId: "11111111-1111-4111-8111-111111111111" }).success).toBe(false);
      expect(
        RefundApplyRequestSchema.safeParse({
          orgId: "11111111-1111-4111-8111-111111111111",
          reason: "provider incident",
          refundedBy: "kevin@distribute.you",
        }).success
      ).toBe(true);
    });
  });
});
