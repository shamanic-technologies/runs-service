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
    organizationId: z.string().uuid().nullable(),
    userId: z.string().uuid().nullable(),
    brandId: z.string().nullable(),
    campaignId: z.string().nullable(),
    workflowName: z.string().nullable(),
    featureSlug: z.string().nullable(),
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
  ownActualCostInUsdCents: z.string(),
  ownProvisionedCostInUsdCents: z.string(),
}).openapi("RunWithOwnCost");

export const CreateRunRequestSchema = z
  .object({
    brandId: z.string().min(1).optional().openapi({ deprecated: true, description: "Deprecated: use x-brand-id header instead. Kept for backwards compatibility; header takes precedence." }),
    campaignId: z.string().min(1).optional().openapi({ deprecated: true, description: "Deprecated: use x-campaign-id header instead. Kept for backwards compatibility; header takes precedence." }),
    workflowName: z.string().min(1).optional().openapi({ deprecated: true, description: "Deprecated: use x-workflow-name header instead. Kept for backwards compatibility; header takes precedence." }),
    featureSlug: z.string().min(1).optional().openapi({ deprecated: true, description: "Deprecated: use x-feature-slug header instead. Kept for backwards compatibility; header takes precedence." }),
    serviceName: z.string().min(1),
    taskName: z.string().min(1),
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

export const CostStatusEnum = z.enum(["actual", "provisioned", "cancelled"]).openapi("CostStatus");

export const CostSourceEnum = z.enum(["platform", "org"]).openapi("CostSource");

export const CostSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    costName: z.string(),
    costSource: CostSourceEnum,
    quantity: z.string(),
    unitCostInUsdCents: z.string(),
    totalCostInUsdCents: z.string(),
    status: CostStatusEnum,
    createdAt: z.string().datetime(),
  })
  .openapi("Cost");

export const CostItemSchema = z
  .object({
    costName: z.string().min(1),
    costSource: CostSourceEnum,
    quantity: z.number().positive(),
    status: CostStatusEnum.default("actual"),
  })
  .openapi("CostItem");

export const AddCostsRequestSchema = z
  .object({
    items: z.array(CostItemSchema).min(1),
  })
  .openapi("AddCostsRequest");

export type AddCostsRequest = z.infer<typeof AddCostsRequestSchema>;

export const UpdateCostRequestSchema = z
  .object({
    status: CostStatusEnum,
  })
  .openapi("UpdateCostRequest");

export type UpdateCostRequest = z.infer<typeof UpdateCostRequestSchema>;

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
    ownActualCostInUsdCents: z.string(),
    ownProvisionedCostInUsdCents: z.string(),
  })
  .openapi("DescendantRun");

export const RunWithCostsSchema = z
  .object({
    id: z.string().uuid(),
    organizationId: z.string().uuid().nullable(),
    userId: z.string().uuid().nullable(),
    brandId: z.string().nullable(),
    campaignId: z.string().nullable(),
    workflowName: z.string().nullable(),
    featureSlug: z.string().nullable(),
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
    actualCostInUsdCents: z.string(),
    provisionedCostInUsdCents: z.string(),
    ownCostInUsdCents: z.string(),
    ownActualCostInUsdCents: z.string(),
    ownProvisionedCostInUsdCents: z.string(),
    childrenCostInUsdCents: z.string(),
    childrenActualCostInUsdCents: z.string(),
    childrenProvisionedCostInUsdCents: z.string(),
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

// --- Workflow tracking headers (optional, injected by workflow-service) ---

const WorkflowTrackingHeadersSchema = z.object({
  "x-brand-id": z.string().optional().openapi({ description: "Brand identifier, injected by workflow-service" }),
  "x-campaign-id": z.string().optional().openapi({ description: "Campaign identifier, injected by workflow-service" }),
  "x-workflow-name": z.string().optional().openapi({ description: "Workflow name, injected by workflow-service" }),
  "x-feature-slug": z.string().optional().openapi({ description: "Feature slug from features-service, injected by campaign-service" }),
});

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
    "Creates a new execution run. Organization and user are identified via x-org-id and x-user-id headers. Pass x-run-id header to set the parent run (the caller's run ID becomes parentRunId). Field resolution priority: header > body (deprecated) > parent inheritance. If a field conflicts with the parent run value, the request is rejected with 409. Returns 409 if orgId, userId, brandId, campaignId, or workflowName differ from the parent run.",
  security: [{ apiKey: [] }],
  request: {
    headers: WorkflowTrackingHeadersSchema,
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
    409: {
      description: "Parent-child field conflict — request values differ from parent run",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/runs",
  summary: "List runs",
  description:
    "Lists runs for the organization identified by x-org-id header. Each run includes ownCostInUsdCents.",
  security: [{ apiKey: [] }],
  request: {
    query: z.object({
      userId: z.string().uuid().optional(),
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
      workflowName: z.string().optional(),
      featureSlug: z.string().optional(),
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
    "Adds cost line items. Unit costs are resolved automatically from the costs-service. Optional x-brand-id, x-campaign-id, x-workflow-name headers are forwarded to downstream services.",
  security: [{ apiKey: [] }],
  request: {
    headers: WorkflowTrackingHeadersSchema,
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
  path: "/v1/runs/{id}/costs/{costId}",
  summary: "Update a cost item status",
  description:
    "Updates a cost item status. Use to realize a provisioned cost (set status to 'actual') or cancel it (set status to 'cancelled').",
  security: [{ apiKey: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
      costId: z.string().uuid(),
    }),
    body: {
      content: { "application/json": { schema: UpdateCostRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Cost updated",
      content: { "application/json": { schema: CostSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
    404: {
      description: "Run or cost not found",
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

// --- Stats schemas ---

export const StatsFiltersSchema = z.object({
  brandId: z.string().optional(),
  campaignId: z.string().optional(),
  workflowName: z.string().optional().openapi({ description: "Filter by a single workflow name" }),
  workflowNames: z.string().optional().openapi({ description: "Filter by multiple workflow names (comma-separated). Takes precedence over workflowName when both are provided." }),
  featureSlug: z.string().optional().openapi({ description: "Filter by feature slug" }),
  serviceName: z.string().optional(),
  taskName: z.string().optional(),
  startedAfter: z.string().datetime().optional(),
  startedBefore: z.string().datetime().optional(),
});

export const StatsCostsQuerySchema = StatsFiltersSchema.extend({
  groupBy: z.string().min(1),
}).openapi("StatsCostsQuery");

export const StatsCostsResponseSchema = z
  .object({
    groups: z.array(
      z.object({
        dimensions: z.record(z.string(), z.string().nullable()),
        totalCostInUsdCents: z.string(),
        actualCostInUsdCents: z.string(),
        provisionedCostInUsdCents: z.string(),
        cancelledCostInUsdCents: z.string(),
        runCount: z.number(),
        minStartedAt: z.string().datetime().nullable().openapi({ description: "Earliest started_at across matching runs" }),
        maxStartedAt: z.string().datetime().nullable().openapi({ description: "Latest started_at across matching runs" }),
      })
    ),
  })
  .openapi("StatsCostsResponse");

export const BudgetWindowSchema = z.object({
  label: z.string().min(1),
  since: z.string().datetime().optional(),
});

export const BudgetRequestSchema = z
  .object({
    campaignId: z.string().optional(),
    brandId: z.string().optional(),
    workflowName: z.string().optional(),
    featureSlug: z.string().optional(),
    windows: z.array(BudgetWindowSchema).min(1).max(10),
  })
  .openapi("BudgetRequest");

export const BudgetResponseSchema = z
  .object({
    windows: z.array(
      z.object({
        label: z.string(),
        totalCostInUsdCents: z.string(),
        actualCostInUsdCents: z.string(),
        provisionedCostInUsdCents: z.string(),
      })
    ),
  })
  .openapi("BudgetResponse");

export const ChildSummarySchema = z
  .object({
    id: z.string().uuid(),
    serviceName: z.string(),
    taskName: z.string(),
    status: z.string(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    totalCostInUsdCents: z.string(),
    actualCostInUsdCents: z.string(),
    provisionedCostInUsdCents: z.string(),
    costsByName: z.array(
      z.object({
        costName: z.string(),
        totalCostInUsdCents: z.string(),
        actualCostInUsdCents: z.string(),
        provisionedCostInUsdCents: z.string(),
      })
    ),
  })
  .openapi("ChildSummary");

export const ChildrenSummaryResponseSchema = z
  .object({
    parentRunId: z.string().uuid(),
    children: z.array(ChildSummarySchema),
  })
  .openapi("ChildrenSummaryResponse");

export const PublicCostsQuerySchema = z
  .object({
    groupBy: z.enum(["brandId", "workflowName", "campaignId", "featureSlug", "serviceName", "costName"]),
    orgId: z.string().uuid().optional(),
    brandId: z.string().optional(),
    campaignId: z.string().optional(),
    featureSlug: z.string().optional(),
    taskName: z.string().optional(),
  })
  .openapi("PublicCostsQuery");

// --- Stats path registrations ---

registry.registerPath({
  method: "get",
  path: "/v1/stats/costs",
  summary: "Aggregate costs with GROUP BY",
  description:
    "Returns aggregated costs grouped by one or more dimensions (brandId, workflowName, campaignId, serviceName, costName). When costName is included in groupBy, the response includes totalQuantity and uses INNER JOIN. Organization identified via x-org-id header.",
  security: [{ apiKey: [] }],
  request: {
    query: StatsCostsQuerySchema,
  },
  responses: {
    200: {
      description: "Aggregated cost groups",
      content: { "application/json": { schema: StatsCostsResponseSchema } },
    },
    400: {
      description: "Invalid groupBy value",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/stats/budget",
  summary: "Budget check with temporal windows",
  description:
    "Returns aggregated actual + provisioned costs across temporal windows. Organization identified via x-org-id header.",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: BudgetRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Budget per window",
      content: { "application/json": { schema: BudgetResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/runs/{id}/children-summary",
  summary: "Per-child cost summary",
  description:
    "Returns aggregated costs per direct child run, including all descendant costs. Each child includes a costsByName breakdown.",
  security: [{ apiKey: [] }],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: "Children with aggregated costs",
      content: { "application/json": { schema: ChildrenSummaryResponseSchema } },
    },
    401: { description: "Unauthorized" },
    404: {
      description: "Run not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/stats/public/costs",
  summary: "Public cost aggregation (no auth)",
  description:
    "Returns aggregated costs across all organizations, grouped by brandId, workflowName, campaignId, serviceName, or costName. Supports optional filters: orgId, brandId, campaignId, taskName. No authentication required.",
  request: {
    query: PublicCostsQuerySchema,
  },
  responses: {
    200: {
      description: "Aggregated cost groups",
      content: { "application/json": { schema: StatsCostsResponseSchema } },
    },
    400: {
      description: "Invalid groupBy value",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// --- Platform runs paths ---

registry.registerPath({
  method: "post",
  path: "/v1/platform-runs",
  summary: "Create a platform-level run",
  description:
    "Creates a run for a platform-level system operation (no org or user). Requires x-service-name header to identify the calling service. Field resolution priority: header > body (deprecated).",
  security: [{ apiKey: [] }],
  request: {
    headers: WorkflowTrackingHeadersSchema,
    body: {
      content: { "application/json": { schema: CreateRunRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Platform run created",
      content: { "application/json": { schema: RunSchema } },
    },
    400: {
      description: "Invalid request or missing x-service-name",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/platform-runs/{id}/costs",
  summary: "Add costs to a platform run",
  description:
    "Adds cost line items to a platform-level run. Unit costs are resolved automatically from the costs-service.",
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
  path: "/v1/platform-runs/{id}",
  summary: "Update platform run status",
  description:
    "Updates a platform-level run status to completed or failed. Sets completedAt automatically.",
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
