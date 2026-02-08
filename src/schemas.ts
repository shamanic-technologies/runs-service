import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// --- Security scheme ---
registry.registerComponent("securitySchemes", "apiKey", {
  type: "apiKey",
  in: "header",
  name: "X-API-Key",
  description: "API key for authenticating requests",
});

// --- Shared schemas ---

export const ErrorSchema = z
  .object({
    error: z.string(),
  })
  .openapi("Error");

export const ValidationErrorSchema = z
  .object({
    error: z.string(),
    details: z.any(),
  })
  .openapi("ValidationError");

// --- Run schemas ---

export const RunSchema = z
  .object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    userId: z.string().uuid().nullable(),
    appId: z.string(),
    brandId: z.string().nullable(),
    campaignId: z.string().nullable(),
    serviceName: z.string(),
    taskName: z.string(),
    status: z.string(),
    parentRunId: z.string().uuid().nullable(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("Run");

export const RunWithOwnCostSchema = RunSchema.extend({
  ownCostInUsdCents: z.string(),
}).openapi("RunWithOwnCost");

export const CreateRunRequestSchema = z
  .object({
    clerkOrgId: z.string().min(1),
    clerkUserId: z.string().min(1).optional(),
    appId: z.string().min(1),
    brandId: z.string().min(1).optional(),
    campaignId: z.string().min(1).optional(),
    serviceName: z.string().min(1),
    taskName: z.string().min(1),
    parentRunId: z.string().uuid().optional(),
  })
  .openapi("CreateRunRequest");

export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export const UpdateRunRequestSchema = z
  .object({
    status: z.enum(["completed", "failed"]),
  })
  .openapi("UpdateRunRequest");

export type UpdateRunRequest = z.infer<typeof UpdateRunRequestSchema>;

// --- Cost schemas ---

export const CostSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    costName: z.string(),
    quantity: z.string(),
    unitCostInUsdCents: z.string(),
    totalCostInUsdCents: z.string(),
    createdAt: z.string().datetime(),
  })
  .openapi("Cost");

export const CostItemSchema = z
  .object({
    costName: z.string().min(1),
    quantity: z.number().positive(),
  })
  .openapi("CostItem");

export const AddCostsRequestSchema = z
  .object({
    items: z.array(CostItemSchema).min(1),
  })
  .openapi("AddCostsRequest");

export type AddCostsRequest = z.infer<typeof AddCostsRequestSchema>;

export const AddCostsResponseSchema = z
  .object({
    costs: z.array(CostSchema),
  })
  .openapi("AddCostsResponse");

export const DescendantRunSchema = z
  .object({
    id: z.string().uuid(),
    parentRunId: z.string().uuid().nullable(),
    serviceName: z.string(),
    taskName: z.string(),
    status: z.string(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    costs: z.array(CostSchema),
    ownCostInUsdCents: z.string(),
  })
  .openapi("DescendantRun");

export const RunWithCostsSchema = z
  .object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    userId: z.string().uuid().nullable(),
    appId: z.string(),
    brandId: z.string().nullable(),
    campaignId: z.string().nullable(),
    serviceName: z.string(),
    taskName: z.string(),
    status: z.string(),
    parentRunId: z.string().uuid().nullable(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    costs: z.array(CostSchema),
    totalCostInUsdCents: z.string(),
    ownCostInUsdCents: z.string(),
    childrenCostInUsdCents: z.string(),
    descendantRuns: z.array(DescendantRunSchema),
  })
  .openapi("RunWithCosts");

export const ListRunsResponseSchema = z
  .object({
    runs: z.array(RunWithOwnCostSchema),
    limit: z.number(),
    offset: z.number(),
  })
  .openapi("ListRunsResponse");

export const HealthResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    service: z.string(),
    database: z.enum(["ok", "unreachable"]),
  })
  .openapi("HealthResponse");

// --- Register paths ---

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  description: "Verifies service and database connectivity",
  responses: {
    200: {
      description: "Service is healthy",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
    503: {
      description: "Service is degraded (database unreachable)",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/openapi.json",
  summary: "OpenAPI specification",
  description: "Returns the OpenAPI 3.0 specification for this service",
  responses: {
    200: {
      description: "OpenAPI specification",
      content: { "application/json": { schema: z.any() } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/runs",
  summary: "Create a run",
  description:
    "Creates a new execution run. Organizations and users are resolved automatically from clerkOrgId/clerkUserId.",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: CreateRunRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Run created",
      content: { "application/json": { schema: RunSchema } },
    },
    400: {
      description: "Invalid request or parentRunId does not exist",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/runs",
  summary: "List runs",
  description:
    "Lists runs filtered by clerkOrgId and optional parameters. Each run includes ownCostInUsdCents.",
  security: [{ apiKey: [] }],
  request: {
    query: z.object({
      clerkOrgId: z.string(),
      clerkUserId: z.string().optional(),
      appId: z.string().optional(),
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
      serviceName: z.string().optional(),
      taskName: z.string().optional(),
      status: z.string().optional(),
      parentRunId: z.string().uuid().optional(),
      startedAfter: z.string().datetime().optional(),
      startedBefore: z.string().datetime().optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "List of runs with cost totals",
      content: { "application/json": { schema: ListRunsResponseSchema } },
    },
    400: {
      description: "Missing clerkOrgId",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/runs/{id}",
  summary: "Get a run with costs",
  description:
    "Returns the run with its cost breakdown, including all descendant runs and their costs",
  security: [{ apiKey: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: "Run with cost details and descendant runs",
      content: { "application/json": { schema: RunWithCostsSchema } },
    },
    401: { description: "Unauthorized" },
    404: {
      description: "Run not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/runs/{id}/costs",
  summary: "Add costs to a run",
  description:
    "Adds cost line items. Unit costs are resolved automatically from the costs-service.",
  security: [{ apiKey: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: {
      content: { "application/json": { schema: AddCostsRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Costs added",
      content: { "application/json": { schema: AddCostsResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
    404: {
      description: "Run not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Unknown cost name",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/runs/{id}",
  summary: "Update run status",
  description:
    "Updates the run status to completed or failed. Sets completedAt automatically.",
  security: [{ apiKey: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: {
      content: { "application/json": { schema: UpdateRunRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Run updated",
      content: { "application/json": { schema: RunSchema } },
    },
    400: {
      description: "Invalid status value",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
    404: {
      description: "Run not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});
