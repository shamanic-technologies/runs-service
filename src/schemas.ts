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
    workflowName: z.string().nullable(),
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
    clerkOrgId: z.string().min(1),
    clerkUserId: z.string().min(1).optional(),
    appId: z.string().min(1),
    brandId: z.string().min(1).optional(),
    campaignId: z.string().min(1).optional(),
    workflowName: z.string().min(1).optional(),
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

export const CostStatusEnum = z.enum(["actual", "provisioned", "cancelled"]).openapi("CostStatus");

export const CostSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    costName: z.string(),
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
    organizationId: z.string().uuid(),
    userId: z.string().uuid().nullable(),
    appId: z.string(),
    brandId: z.string().nullable(),
    campaignId: z.string().nullable(),
    workflowName: z.string().nullable(),
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
      workflowName: z.string().optional(),
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
  clerkOrgId: z.string().min(1),
  appId: z.string().min(1),
  brandId: z.string().optional(),
  campaignId: z.string().optional(),
  workflowName: z.string().optional(),
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
      })
    ),
  })
  .openapi("StatsCostsResponse");

export const StatsCostsByCostNameResponseSchema = z
  .object({
    costs: z.array(
      z.object({
        costName: z.string(),
        totalCostInUsdCents: z.string(),
        actualCostInUsdCents: z.string(),
        provisionedCostInUsdCents: z.string(),
        cancelledCostInUsdCents: z.string(),
        totalQuantity: z.string(),
      })
    ),
  })
  .openapi("StatsCostsByCostNameResponse");

export const BudgetWindowSchema = z.object({
  label: z.string().min(1),
  since: z.string().datetime().optional(),
});

export const BudgetRequestSchema = z
  .object({
    clerkOrgId: z.string().min(1),
    appId: z.string().min(1),
    campaignId: z.string().optional(),
    brandId: z.string().optional(),
    workflowName: z.string().optional(),
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

export const PublicLeaderboardQuerySchema = z
  .object({
    appId: z.string().min(1),
    groupBy: z.enum(["brandId", "workflowName"]),
  })
  .openapi("PublicLeaderboardQuery");

// --- Stats path registrations ---

registry.registerPath({
  method: "get",
  path: "/v1/stats/costs",
  summary: "Aggregate costs with GROUP BY",
  description:
    "Returns aggregated costs grouped by one or more dimensions (brandId, workflowName, campaignId, serviceName, appId). All standard filters apply.",
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
      description: "Invalid groupBy value or missing required params (clerkOrgId, appId)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/stats/costs/by-cost-name",
  summary: "Cost breakdown by cost name",
  description:
    "Returns total costs broken down by costName (e.g., gpt-4o-input-token, email-send). Includes actual/provisioned/cancelled breakdown and total quantity.",
  security: [{ apiKey: [] }],
  request: {
    query: StatsFiltersSchema,
  },
  responses: {
    200: {
      description: "Cost breakdown by name",
      content: { "application/json": { schema: StatsCostsByCostNameResponseSchema } },
    },
    400: {
      description: "Missing required params (clerkOrgId, appId)",
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
    "Returns aggregated actual + provisioned costs across temporal windows (e.g., today, 7d, month, all). Used by the DAG budget gatekeeper before each step.",
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
    "Returns aggregated costs per direct child run, including all descendant costs. Each child includes a costsByName breakdown. Used for per-lead drill-down in a campaign.",
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
  path: "/v1/stats/public/leaderboard",
  summary: "Public leaderboard (no auth)",
  description:
    "Returns aggregated costs across all organizations for a given appId, grouped by brandId or workflowName. No authentication required. Used for the public performance landing page.",
  request: {
    query: PublicLeaderboardQuerySchema,
  },
  responses: {
    200: {
      description: "Aggregated cost groups",
      content: { "application/json": { schema: StatsCostsResponseSchema } },
    },
    400: {
      description: "Missing appId or invalid groupBy value",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});
