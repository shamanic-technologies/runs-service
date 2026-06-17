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
    brandIds: z.array(z.string()).nullable(),
    campaignId: z.string().nullable(),
    workflowSlug: z.string().nullable(),
    featureSlug: z.string().nullable(),
    serviceName: z.string(),
    taskName: z.string(),
    status: z.string(),
    parentRunId: z.string().uuid().nullable(),
    idempotencyKey: z.string().nullable(),
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
    brandIds: z.array(z.string().uuid()).min(1).optional().openapi({ deprecated: true, description: "Deprecated: use x-brand-id header (CSV) instead. Kept for backwards compatibility; header takes precedence." }),
    campaignId: z.string().min(1).optional().openapi({ deprecated: true, description: "Deprecated: use x-campaign-id header instead. Kept for backwards compatibility; header takes precedence." }),
    workflowSlug: z.string().min(1).optional().openapi({ deprecated: true, description: "Deprecated: use x-workflow-slug header instead. Kept for backwards compatibility; header takes precedence." }),
    featureSlug: z.string().min(1).optional().openapi({ deprecated: true, description: "Deprecated: use x-feature-slug header instead. Kept for backwards compatibility; header takes precedence." }),
    serviceName: z.string().min(1),
    taskName: z.string().min(1),
    idempotencyKey: z.string().min(1).max(256).optional().openapi({
      description:
        "Caller-supplied dedup key. Optional. Uniqueness is GLOBAL across all runs in the table — callers MUST self-namespace (e.g. `stripe:txn_abc`, `workflow:run_xyz`) to avoid colliding with other services. On retry with the same key, the original run is returned with HTTP 200. If a different (serviceName, taskName) is requested with the same key, the request is rejected with HTTP 409. Max 256 chars.",
      example: "stripe:txn_3MV8nL2eZvKYlo2C1lE9ZmKj",
    }),
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
    idempotencyKey: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("Cost");

export const CostItemSchema = z
  .object({
    costName: z.string().min(1),
    costSource: CostSourceEnum,
    quantity: z.number().positive(),
    status: CostStatusEnum.default("actual"),
    idempotencyKey: z.string().min(1).max(256).optional().openapi({
      description:
        "Caller-supplied per-item dedup key. Optional. Uniqueness is PER-RUN — two items inside the same run may not share an idempotencyKey, but two different runs may use the same key independently. Callers should still self-namespace to keep cross-run audit clean. On retry, the original cost row is returned and no duplicate row is created. Max 256 chars.",
      example: "stripe:txn_3MV8nL2eZvKYlo2C1lE9ZmKj",
    }),
  })
  .openapi("CostItem");

export const AddCostsRequestSchema = z
  .object({
    items: z.array(CostItemSchema).min(1),
  })
  .openapi("AddCostsRequest");

export type AddCostsRequest = z.infer<typeof AddCostsRequestSchema>;

// PATCH /v1/runs/:id/costs/:costId only supports forward transitions out of `provisioned`.
// Phase 5 of γ migration plan: each silver mutation maps to a domain event
// (`cost.materialized` for actual, `cost.cancelled` for cancelled). Re-provisioning
// an already-actual row has no domain meaning and is rejected with 400.
export const UpdateCostRequestSchema = z
  .object({
    status: z.enum(["actual", "cancelled"]),
  })
  .openapi("UpdateCostRequest");

export type UpdateCostRequest = z.infer<typeof UpdateCostRequestSchema>;

export const BatchCostsRequestSchema = z
  .object({
    runIds: z.array(z.string().uuid()).min(1),
  })
  .openapi("BatchCostsRequest");

// POST /v1/runs/batch — fetch many runs with full RunWithCosts shape in one call.
// Replaces the N × GET /v1/runs/:id fanout the api-service runs-client does today.
export const BatchRunsRequestSchema = z
  .object({
    runIds: z.array(z.string().uuid()).min(1).max(10000),
  })
  .openapi("BatchRunsRequest");

export type BatchRunsRequest = z.infer<typeof BatchRunsRequestSchema>;

export type BatchCostsRequest = z.infer<typeof BatchCostsRequestSchema>;

export const BatchCostsEntrySchema = z
  .object({
    runId: z.string().uuid(),
    totalCostInUsdCents: z.string(),
    actualCostInUsdCents: z.string(),
    provisionedCostInUsdCents: z.string(),
    ownActualPlatformCostInUsdCents: z.string(),
    ownProvisionedPlatformCostInUsdCents: z.string(),
  })
  .openapi("BatchCostsEntry");

export const BatchCostsResponseSchema = z
  .object({
    costs: z.array(BatchCostsEntrySchema),
  })
  .openapi("BatchCostsResponse");

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
    brandIds: z.array(z.string()).nullable(),
    campaignId: z.string().nullable(),
    workflowSlug: z.string().nullable(),
    featureSlug: z.string().nullable(),
    serviceName: z.string(),
    taskName: z.string(),
    status: z.string(),
    parentRunId: z.string().uuid().nullable(),
    idempotencyKey: z.string().nullable(),
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
    limit: z.number().optional(),
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

// --- Run event schemas ---

export const EventLevelEnum = z.enum(["info", "warn", "error"]).openapi("EventLevel");

export const RunEventSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    service: z.string(),
    event: z.string(),
    detail: z.string().nullable(),
    level: EventLevelEnum,
    data: z.any().nullable(),
    orgId: z.string().uuid().nullable(),
    userId: z.string().uuid().nullable(),
    brandIds: z.string().nullable(),
    campaignId: z.string().uuid().nullable(),
    workflowSlug: z.string().nullable(),
    featureSlug: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("RunEvent");

export const CreateRunEventRequestSchema = z
  .object({
    service: z.string().min(1),
    event: z.string().min(1),
    detail: z.string().optional(),
    level: EventLevelEnum.optional(),
    data: z.any().optional(),
  })
  .openapi("CreateRunEventRequest");

export type CreateRunEventRequest = z.infer<typeof CreateRunEventRequestSchema>;

export const ListRunEventsResponseSchema = z
  .object({
    events: z.array(RunEventSchema),
  })
  .openapi("ListRunEventsResponse");

// --- Workflow tracking headers (optional, injected by workflow-service) ---

const WorkflowTrackingHeadersSchema = z.object({
  "x-brand-id": z.string().optional().openapi({ description: "Brand identifier(s) as CSV (e.g. uuid1,uuid2), injected by workflow-service", example: "uuid1,uuid2" }),
  "x-campaign-id": z.string().optional().openapi({ description: "Campaign identifier, injected by workflow-service" }),
  "x-workflow-slug": z.string().optional().openapi({ description: "Workflow slug, injected by workflow-service" }),
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
    "Creates a new execution run. Organization is required via x-org-id; user is optional via x-user-id. Pass x-run-id header to set the parent run (the caller's run ID becomes parentRunId). Field resolution priority: header > body (deprecated) > parent inheritance. If a field conflicts with the parent run value, the request is rejected with 409. Idempotency: pass body.idempotencyKey for safe retries — repeated calls return the original run with HTTP 200. The key is globally unique across the runs table, so callers MUST self-namespace (e.g. `stripe:<txn_id>`, `workflow:<run_id>`). A mismatched (serviceName, taskName) on the same key returns 409.",
  security: [{ apiKey: [] }],
  request: {
    headers: WorkflowTrackingHeadersSchema,
    body: {
      content: { "application/json": { schema: CreateRunRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Idempotent replay — existing run returned",
      content: { "application/json": { schema: RunSchema } },
    },
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
      description: "Parent-child field conflict OR idempotencyKey collides with a run of different (serviceName, taskName)",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/runs",
  summary: "List runs",
  description:
    "Lists runs for the organization identified by x-org-id header. Returns one item per run, ordered by startedAt DESC (most recent first). Each item is a `RunWithOwnCost` — the full `Run` (via allOf, so the stable `id` UUID is on the embedded base schema) plus own-cost totals (`ownCostInUsdCents`, `ownActualCostInUsdCents`, `ownProvisionedCostInUsdCents`) summed across the run's own `runs_costs` rows. There is no per-cost-name breakdown at this level; for that call `GET /v1/runs/{id}` and read `RunWithCosts.costs[]`. Suitable for an org-wide ledger UI: use `id` as the row key and `taskName` (or `serviceName.taskName`) as the row label.",
  security: [{ apiKey: [] }],
  request: {
    query: z.object({
      userId: z.string().uuid().optional(),
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
      workflowSlug: z.string().optional(),
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
    "Adds cost line items. Unit costs are resolved automatically from the costs-service. Optional x-brand-id, x-campaign-id, x-workflow-slug headers are forwarded to downstream services. Idempotency: each item may carry an optional idempotencyKey scoped to the run — repeated submissions with the same key for the same run do not create duplicate rows; the original row is returned. Two different runs may use the same per-item key independently.",
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
  method: "post",
  path: "/v1/runs/costs/batch",
  summary: "Batch cost lookup by run IDs",
  description:
    "Returns aggregated cost totals (including all descendant costs) for a list of run IDs. Per-row also includes `ownActualPlatformCostInUsdCents` and `ownProvisionedPlatformCostInUsdCents` — own-run-only sums of `cost_source='platform'` items, used by billing-service for reconcile (no rounding, full numeric precision). Runs not found are omitted from the response. Uses a single recursive CTE for efficiency.",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: BatchCostsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Cost totals per run",
      content: { "application/json": { schema: BatchCostsResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/runs/batch",
  summary: "Batch get runs with full cost breakdown",
  description:
    "Returns one `RunWithCosts` per requested run ID — the exact same shape as `GET /v1/runs/:id` including per-run own costs, rolled-up totals, and the `descendantRuns[]` tree. Org-scoped via x-org-id; rows not found or not belonging to the org are silently omitted from the response. Per-request cap is 10000 runIds; callers above the cap MUST chunk. Designed to replace the N × `GET /v1/runs/:id` fanout that runs-client does today.",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: BatchRunsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Runs with cost breakdown",
      content: {
        "application/json": {
          schema: z.object({ runs: z.array(RunWithCostsSchema) }),
        },
      },
    },
    400: {
      description: "Invalid request or runIds count > 10000",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
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

// --- Internal schemas ---

export const TransferBrandRequestSchema = z
  .object({
    sourceBrandId: z.string().uuid(),
    sourceOrgId: z.string().uuid(),
    targetOrgId: z.string().uuid(),
    targetBrandId: z.string().uuid().optional(),
  })
  .openapi("TransferBrandRequest");

export type TransferBrandRequest = z.infer<typeof TransferBrandRequestSchema>;

export const DeleteRunsByOrgParamsSchema = z
  .object({
    orgId: z.string().uuid(),
  })
  .openapi("DeleteRunsByOrgParams");

export const DeleteRunsByOrgResponseSchema = z
  .object({
    orgId: z.string().uuid(),
    deleted: z.object({
      runs: z.number(),
      costs: z.number(),
      runEvents: z.number(),
      runLifecycleEvents: z.number(),
      costLifecycleEvents: z.number(),
    }),
  })
  .openapi("DeleteRunsByOrgResponse");

registry.registerPath({
  method: "delete",
  path: "/internal/runs/by-org/{orgId}",
  summary: "Delete runs-service state for an org",
  description:
    "Idempotent internal cascade-teardown endpoint for deleted organizations. Deletes runs-service-owned org-scoped bronze lifecycle events and silver run/cost/event projections for the internal org UUID. No cross-service fan-out is performed.",
  security: [{ apiKey: [] }],
  request: {
    params: DeleteRunsByOrgParamsSchema,
  },
  responses: {
    200: {
      description: "Org run state deleted or already absent",
      content: { "application/json": { schema: DeleteRunsByOrgResponseSchema } },
    },
    400: {
      description: "Invalid path parameters",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
    500: {
      description: "Database or invariant failure",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const TransferBrandResponseSchema = z
  .object({
    updatedTables: z.array(
      z.object({
        tableName: z.string(),
        count: z.number(),
      })
    ),
  })
  .openapi("TransferBrandResponse");

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  summary: "Transfer solo-brand runs to a different org",
  description:
    "Re-assigns all runs where brand_ids contains exactly one element matching sourceBrandId from sourceOrgId to targetOrgId. When targetBrandId is provided, also rewrites the brand reference. Skips co-branding rows (multiple brand IDs). Idempotent.",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: TransferBrandRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Transfer complete",
      content: { "application/json": { schema: TransferBrandResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

export const RunsExpectedTotalsQuerySchema = z
  .object({
    org_id: z.string().uuid(),
  })
  .openapi("RunsExpectedTotalsQuery");

export const RunsExpectedTotalsEntrySchema = z
  .object({
    run_id: z.string().uuid(),
    expected_cents: z.string(),
  })
  .openapi("RunsExpectedTotalsEntry");

export const RunsExpectedTotalsResponseSchema = z
  .object({
    total_expected_cents: z.string(),
    runs: z.array(RunsExpectedTotalsEntrySchema),
  })
  .openapi("RunsExpectedTotalsResponse");

export const OrgUsageTotalQuerySchema = z
  .object({
    org_id: z.string().uuid(),
  })
  .openapi("OrgUsageTotalQuery");

export const OrgUsageTotalResponseSchema = z
  .object({
    org_id: z.string().uuid(),
    spent_cents: z.string(),
    as_of: z.string().datetime(),
  })
  .openapi("OrgUsageTotalResponse");

registry.registerPath({
  method: "get",
  path: "/internal/runs-expected-totals",
  summary: "Per-run expected platform-actual cost totals for an org",
  description:
    "Returns, for every completed/failed run in the org, the SUM of runs_costs.total_cost_in_usd_cents over rows where cost_source='platform' AND status='actual'. Runs with zero qualifying total are omitted. The org-level total_expected_cents is the sum of all per-run totals. All values are strings to preserve numeric(16,10) precision — billing-service uses this to detect drift against confirmed transactions.",
  security: [{ apiKey: [] }],
  request: {
    query: RunsExpectedTotalsQuerySchema,
  },
  responses: {
    200: {
      description: "Per-run expected totals + org-level aggregate",
      content: { "application/json": { schema: RunsExpectedTotalsResponseSchema } },
    },
    400: {
      description: "Invalid query parameters",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/org-usage-total",
  summary: "Org-level platform usage spend total",
  description:
    "Returns the total platform usage spend for one org as SUM(runs_costs.total_cost_in_usd_cents) over runs belonging to org_id where cost_source='platform' and status IN ('actual', 'provisioned'). Cancelled costs and org/BYOK costs are excluded. spent_cents is a decimal string with numeric(16,10) precision for billing-service authorize.",
  security: [{ apiKey: [] }],
  request: {
    query: OrgUsageTotalQuerySchema,
  },
  responses: {
    200: {
      description: "Org-level platform spend total",
      content: { "application/json": { schema: OrgUsageTotalResponseSchema } },
    },
    400: {
      description: "Invalid query parameters",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

// --- Public runs stats schemas ---

export const PublicRunsStatsStatusBreakdownSchema = z
  .object({
    completed: z.number(),
    failed: z.number(),
    running: z.number(),
  })
  .openapi("PublicRunsStatsStatusBreakdown");

export const PublicRunsStatsMonthlyEntrySchema = z
  .object({
    month: z.string().openapi({ description: "YYYY-MM format", example: "2026-01" }),
    completed: z.number(),
    failed: z.number(),
    running: z.number(),
    totalCostInUsdCents: z
      .string()
      .openapi({
        description:
          "Sum of total_cost_in_usd_cents for cost rows belonging to runs started in this month, restricted to cost_source='platform' AND status IN ('actual','provisioned'). 10-decimal string to preserve numeric(16,10) precision.",
        example: "0.4500000000",
      }),
  })
  .openapi("PublicRunsStatsMonthlyEntry");

export const PublicRunsStatsWeeklyEntrySchema = z
  .object({
    period: z
      .string()
      .openapi({
        description:
          "ISO week start (Monday, UTC) in YYYY-MM-DD format. Buckets are computed as DATE_TRUNC('week', started_at AT TIME ZONE 'UTC').",
        example: "2026-01-05",
      }),
    completed: z.number(),
    failed: z.number(),
    running: z.number(),
    totalCostInUsdCents: z
      .string()
      .openapi({
        description:
          "Sum of total_cost_in_usd_cents for cost rows belonging to runs started in this ISO week, restricted to cost_source='platform' AND status IN ('actual','provisioned'). 10-decimal string to preserve numeric(16,10) precision.",
        example: "0.4500000000",
      }),
  })
  .openapi("PublicRunsStatsWeeklyEntry");

export const PublicRunsStatsResponseSchema = z
  .object({
    byStatus: PublicRunsStatsStatusBreakdownSchema,
    monthly: z.array(PublicRunsStatsMonthlyEntrySchema),
    weekly: z.array(PublicRunsStatsWeeklyEntrySchema),
    totalCostInUsdCents: z
      .string()
      .openapi({
        description:
          "All-time cumulative cost across all runs and all organizations, restricted to cost_source='platform' AND status IN ('actual','provisioned') (excludes BYOK rows and cancelled rows). 10-decimal string to preserve numeric(16,10) precision.",
        example: "1234.5678901234",
      }),
  })
  .openapi("PublicRunsStatsResponse");

// --- Stats schemas ---

export const StatsFiltersSchema = z.object({
  brandId: z.string().optional().openapi({ description: "Filter by brand ID. Matches runs where this brand is in brandIds array." }),
  campaignId: z.string().optional(),
  workflowSlug: z.string().optional().openapi({ description: "Filter by a single workflow slug" }),
  workflowSlugs: z.string().optional().openapi({ description: "Filter by multiple workflow slugs (comma-separated). Takes precedence over workflowSlug when both are provided." }),
  workflowDynastySlug: z.string().optional().openapi({ description: "Filter by workflow dynasty slug. Resolved to all versioned slugs via workflow-service. Takes precedence over workflowSlug/workflowSlugs." }),
  featureSlug: z.string().optional().openapi({ description: "Filter by a single feature slug" }),
  featureSlugs: z.string().optional().openapi({ description: "Filter by multiple feature slugs (comma-separated). Takes precedence over featureSlug when both are provided. Callers that compute feature lineage themselves (e.g. features-service) pass the full lineage in one call to avoid N HTTP roundtrips." }),
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

export const ServiceTaskSchema = z
  .object({
    serviceName: z.string().min(1),
    taskName: z.string().min(1),
  })
  .openapi("ServiceTask");

export const StatsCostsByServiceTasksRequestSchema = z
  .object({
    groupBy: z.string().min(1).openapi({ description: "Comma-separated dimensions to aggregate by. Allowed: brandId, workflowSlug, campaignId, featureSlug, serviceName, taskName, costName. Dynasty groupBy is NOT supported on POST." }),
    brandId: z.string().optional(),
    campaignId: z.string().optional(),
    workflowSlug: z.string().optional(),
    workflowSlugs: z.array(z.string().min(1)).optional().openapi({ description: "Filter by multiple workflow slugs. Takes precedence over workflowSlug." }),
    featureSlug: z.string().optional(),
    featureSlugs: z.array(z.string().min(1)).optional().openapi({ description: "Filter by multiple feature slugs. Takes precedence over featureSlug." }),
    startedAfter: z.string().datetime().optional(),
    startedBefore: z.string().datetime().optional(),
    serviceTasks: z.array(ServiceTaskSchema).min(1).openapi({ description: "List of (serviceName, taskName) pairs. Each pair produces its own bucket of aggregated groups in the response. Pairs are matched as a tuple — passing [{serviceName:'a', taskName:'b'}] is NOT the same as serviceName='a' AND taskName='b' across multiple service-task combos." }),
  })
  .openapi("StatsCostsByServiceTasksRequest");

export const StatsCostsByServiceTasksResponseSchema = z
  .object({
    buckets: z.array(
      z.object({
        serviceName: z.string(),
        taskName: z.string(),
        groups: z.array(
          z.object({
            dimensions: z.record(z.string(), z.string().nullable()),
            totalCostInUsdCents: z.string(),
            actualCostInUsdCents: z.string(),
            provisionedCostInUsdCents: z.string(),
            cancelledCostInUsdCents: z.string(),
            runCount: z.number(),
            minStartedAt: z.string().datetime().nullable(),
            maxStartedAt: z.string().datetime().nullable(),
            totalQuantity: z.string().optional(),
          })
        ),
      })
    ),
  })
  .openapi("StatsCostsByServiceTasksResponse");

export const BudgetWindowSchema = z.object({
  label: z.string().min(1),
  since: z.string().datetime().optional(),
});

export const BudgetRequestSchema = z
  .object({
    campaignId: z.string().optional(),
    brandId: z.string().optional(),
    workflowSlug: z.string().optional(),
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
    groupBy: z.enum(["brandId", "workflowSlug", "campaignId", "featureSlug", "serviceName", "costName", "workflowDynastySlug"]),
    orgId: z.string().uuid().optional(),
    brandId: z.string().optional(),
    campaignId: z.string().optional(),
    featureSlug: z.string().optional(),
    featureSlugs: z.string().optional().openapi({ description: "Filter by multiple feature slugs (comma-separated). Takes precedence over featureSlug." }),
    workflowDynastySlug: z.string().optional().openapi({ description: "Filter by workflow dynasty slug. Resolved to all versioned slugs via workflow-service." }),
    taskName: z.string().optional(),
  })
  .openapi("PublicCostsQuery");

// --- Stats path registrations ---

registry.registerPath({
  method: "get",
  path: "/v1/stats/costs",
  summary: "Aggregate costs with GROUP BY",
  description:
    "Returns aggregated costs grouped by one or more dimensions (brandId, workflowSlug, campaignId, featureSlug, serviceName, taskName, costName, workflowDynastySlug). When costName is included in groupBy, the response includes totalQuantity and uses INNER JOIN. workflowDynastySlug re-groups versioned slugs under their dynasty. featureSlugs (comma-separated) lets callers that compute feature lineage themselves filter across many slugs in one call. Organization identified via x-org-id header.",
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
  path: "/v1/stats/costs",
  summary: "Batched cost aggregation across multiple (serviceName, taskName) tuples",
  description:
    "Returns aggregated cost groups for each requested (serviceName, taskName) pair in ONE SQL pass. Replaces N separate GET /v1/stats/costs calls when a caller (e.g. features-service stats registry) needs counts for K specific service+task combos under the same scoping (org, brand, feature lineage, date window). Response is a list of buckets in input order. A bucket with no matching rows returns groups: []. Dynasty groupBy is NOT supported on POST — callers compute lineage client-side and pass featureSlugs / workflowSlugs explicitly. Organization identified via x-org-id header.",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: StatsCostsByServiceTasksRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Aggregated cost groups per (serviceName, taskName) bucket",
      content: { "application/json": { schema: StatsCostsByServiceTasksResponseSchema } },
    },
    400: {
      description: "Invalid request or unsupported groupBy",
      content: { "application/json": { schema: ValidationErrorSchema } },
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
    "Returns aggregated costs across all organizations, grouped by brandId, workflowSlug, campaignId, featureSlug, serviceName, costName, or workflowDynastySlug. Supports optional filters: orgId, brandId, campaignId, featureSlug, featureSlugs (comma-separated), workflowDynastySlug, taskName. No authentication required.",
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

registry.registerPath({
  method: "get",
  path: "/public/stats/runs",
  summary: "Public run stats (no auth)",
  description:
    "Returns run counts by status, a monthly breakdown, a weekly breakdown (ISO week, Monday UTC start), and an all-time top-level cumulative cost. Each monthly/weekly entry includes per-status counts and per-bucket cumulative cost. Cost fields sum runs_costs rows where cost_source='platform' AND status IN ('actual','provisioned') (BYOK and cancelled rows excluded). 10-decimal strings preserve numeric(16,10) precision. Monthly and weekly arrays are ordered ascending (oldest first) and include the current in-progress bucket. No authentication required. Cross-tenant aggregate.",
  responses: {
    200: {
      description: "Run stats",
      content: { "application/json": { schema: PublicRunsStatsResponseSchema } },
    },
  },
});

// --- Platform runs paths ---

registry.registerPath({
  method: "post",
  path: "/v1/platform-runs",
  summary: "Create a platform-level run",
  description:
    "Creates a run originating from a system-level caller (cron job, webhook handler, internal worker). Requires x-service-name. Accepts optional x-org-id and x-user-id headers — when provided, the values are stored on the row so the run can be attributed to an organization (e.g. a Stripe webhook charging a specific org's account). Both default to null when absent. Idempotency: pass body.idempotencyKey for safe retries (Stripe webhook redelivery, queue replay, etc.). Repeated calls return the original run with HTTP 200. The key is globally unique across the runs table — callers MUST self-namespace (e.g. `stripe:<txn_id>`). A mismatched (serviceName, taskName) on the same key returns 409.",
  security: [{ apiKey: [] }],
  request: {
    headers: WorkflowTrackingHeadersSchema,
    body: {
      content: { "application/json": { schema: CreateRunRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Idempotent replay — existing run returned",
      content: { "application/json": { schema: RunSchema } },
    },
    201: {
      description: "Platform run created",
      content: { "application/json": { schema: RunSchema } },
    },
    400: {
      description: "Invalid request, missing x-service-name, or invalid x-org-id / x-user-id (must be UUID when present)",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
    409: {
      description: "idempotencyKey collides with a run of different (serviceName, taskName)",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/platform-runs/{id}/costs",
  summary: "Add costs to a platform run",
  description:
    "Adds cost line items to a platform-level run. Unit costs are resolved automatically from the costs-service. Idempotency: each item may carry an optional idempotencyKey scoped to the run — safe for webhook redelivery. Repeated submissions with the same key for the same run do not create duplicates.",
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

// --- Run events path registrations ---

registry.registerPath({
  method: "post",
  path: "/v1/runs/{id}/events",
  summary: "Create a run event",
  description:
    "Logs a structured event for a run. Reads identity headers (x-org-id, x-user-id, x-brand-id, x-campaign-id, x-workflow-slug, x-feature-slug) and stores them in the event row.",
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: CreateRunEventRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Event created",
      content: { "application/json": { schema: RunEventSchema } },
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
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/runs/{id}/events",
  summary: "List events for a run",
  description:
    "Returns all events for a run, ordered by created_at ASC. Optionally filter by level.",
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    query: z.object({
      level: EventLevelEnum.optional(),
    }),
  },
  responses: {
    200: {
      description: "List of events",
      content: { "application/json": { schema: ListRunEventsResponseSchema } },
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
  path: "/v1/runs/{id}/events/stream",
  summary: "Stream events for a run (SSE)",
  description:
    "Server-Sent Events endpoint streaming run events in real-time. Polls every 1s with last_id cursor.",
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "SSE event stream",
      content: { "text/event-stream": { schema: z.any() } },
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
  path: "/v1/events",
  summary: "List events across all runs",
  description:
    "Returns events across all runs for admin log viewing. Supports filtering by service, orgId, brandId, campaignId, workflowSlug, featureSlug, level, and event (comma-separated allowlist of event slugs, union within the set). Ordered by created_at DESC.",
  security: [{ apiKey: [] }],
  request: {
    query: z.object({
      service: z.string().optional(),
      orgId: z.string().uuid().optional(),
      brandId: z.string().optional(),
      campaignId: z.string().uuid().optional(),
      workflowSlug: z.string().optional(),
      featureSlug: z.string().optional(),
      level: EventLevelEnum.optional(),
      event: z
        .string()
        .optional()
        .describe("Comma-separated allowlist of event slugs, e.g. send-start,generate-start. Absent/empty → no event filter."),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "List of events",
      content: { "application/json": { schema: ListRunEventsResponseSchema } },
    },
    401: { description: "Unauthorized" },
  },
});
