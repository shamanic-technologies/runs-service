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

export const GoalEnum = z.enum(["signup", "meetingBooked", "purchase"]).openapi("Goal");

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
    goal: GoalEnum.nullable(),
    brandProfileId: z.string().uuid().nullable(),
    audienceId: z.string().uuid().nullable(),
    workflowContext: z.string().nullable(),
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
    goal: GoalEnum.optional().openapi({ description: "Optional explicit brand runtime goal attribution. Header x-goal takes precedence when present." }),
    brandProfileId: z.string().uuid().optional().openapi({ description: "Optional real brand-profile attribution ID. Header x-brand-profile-id takes precedence when present." }),
    audienceId: z.string().uuid().optional().openapi({ description: "Optional audience attribution ID (human-service org-scoped saved filter-set, audience.id). Header x-audience-id takes precedence when present. Inherited from the parent run when not set." }),
    workflowContext: z.string().min(1).optional().openapi({ description: "Optional stable workflow-context attribution key. Header x-workflow-context takes precedence when present. Do not send guessed labels." }),
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

// A platform run may be opened ON BEHALF of a caller's run (chat-service serving
// another service's LLM call): it becomes that run's child, so its spend lands in
// the caller's subtree and rolls into the caller's nearest declaring ancestor
// (outcome ledger v1). The parent is named in the BODY, not x-run-id: several
// callers already forward x-run-id to /v1/platform-runs and it has always been
// ignored there; binding it would silently re-parent their runs.
// Nothing is inherited from the parent (no org, user, brand, campaign, workflow,
// attribution): the child stays exactly what its own headers/body say, so a
// platform child of an ORG run is never charged to that org.
export const CreatePlatformRunRequestSchema = CreateRunRequestSchema.extend({
  parentRunId: z.string().uuid().optional().openapi({
    description:
      "Optional: the caller's run this platform run is made on behalf of (an org run or a platform run). The new run is created as its child (parentRunId), so its cost counts in that run's subtree. NOTHING is inherited from the parent: the child keeps only the org/user/brand/campaign/workflow its own request states (absent = org-less, platform-billed, never charged to the parent's org). Unknown parent = 422 parent_run_not_found. A stated x-org-id differing from the parent's org = 409 parent_org_mismatch. Absent = a root run, as before.",
  }),
}).openapi("CreatePlatformRunRequest");

export const UpdateRunRequestSchema = z
  .object({
    status: z.enum(["completed", "failed"]),
  })
  .openapi("UpdateRunRequest");

export type UpdateRunRequest = z.infer<typeof UpdateRunRequestSchema>;

// --- Cost schemas ---

// Four distinct facts about a cost row, never conflated:
//   provisioned — a pre-call hold, not yet charged
//   actual      — the spend happened AND the org is charged for it
//   cancelled   — it never happened (the call failed; release the hold)
//   refunded    — it DID happen, but the platform has decided not to charge it
//
// `refunded` is an ACCOUNTING-side state only. It leaves every charge predicate
// (`is_platform_projected`, `is_platform_committed`, the aggregator's atomic
// status literals) — so the org stops owing it with no credit grant anywhere —
// while the money stays visible as real spend through the dedicated `refunded`
// aggregation columns, which is what a PERFORMANCE consumer (cost-per-outcome)
// adds back. See CLAUDE.md "Refunded costs".
export const CostStatusEnum = z.enum(["actual", "provisioned", "cancelled", "refunded"]).openapi("CostStatus");

// Statuses a cost row may be CREATED with. `refunded` is deliberately absent:
// a refund is a transition out of a charged row, never an initial state (a cost
// that was never charged is a cancel, not a refund).
export const CostCreateStatusEnum = z
  .enum(["actual", "provisioned", "cancelled"])
  .openapi("CostCreateStatus");

export const CostSourceEnum = z.enum(["platform", "org"]).openapi("CostSource");

export const CostSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    costName: z.string(),
    costSource: CostSourceEnum,
    quantity: z.string(),
    unitCostInUsdCents: z.string(),
    totalCostInUsdCents: z.string().openapi({ description: "GROSS cost (undiscounted). Unchanged from before the usage-discount freeze." }),
    netCostInUsdCents: z.string().nullable().openapi({ description: "Frozen NET cost = gross × (1 − usageDiscountPct), captured at write time and never recomputed (non-retroactive). NULL for rows written before the freeze — read as net == gross." }),
    usageDiscountPct: z.string().nullable().openapi({ description: "Frozen usage-discount fraction in [0,1] applied to produce the net. NULL when no discount was applied. Provenance only." }),
    status: CostStatusEnum,
    goal: GoalEnum.nullable(),
    brandProfileId: z.string().uuid().nullable(),
    audienceId: z.string().uuid().nullable(),
    workflowContext: z.string().nullable(),
    idempotencyKey: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("Cost");

export const CostItemSchema = z
  .object({
    costName: z.string().min(1),
    costSource: CostSourceEnum,
    quantity: z.number().positive(),
    status: CostCreateStatusEnum.default("actual"),
    goal: GoalEnum.optional().openapi({ description: "Optional per-cost goal attribution override. Omit to inherit the run/header attribution." }),
    brandProfileId: z.string().uuid().optional().openapi({ description: "Optional per-cost brand-profile attribution override. Omit to inherit the run/header attribution." }),
    audienceId: z.string().uuid().optional().openapi({ description: "Optional per-cost audience attribution override (audience.id). Omit to inherit the run/header attribution." }),
    workflowContext: z.string().min(1).optional().openapi({ description: "Optional per-cost workflow-context attribution override. Omit to inherit the run/header attribution." }),
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

// Refund provenance. A refund with no motive is indistinguishable from an
// ordinary cancel three months later, and this is money — so both fields are
// mandatory on every refund and land in the append-only bronze audit
// (`cost.refunded` payload), never on the silver projection.
export const RefundReasonSchema = z.string().trim().min(3).max(500).openapi({
  description: "Why the spend is being comped. Free text, recorded in the bronze audit trail.",
  example: "zai-glm-5.3 provider incident 2026-08-25 — spend comped for the customer",
});

export const RefundedBySchema = z.string().trim().min(1).max(200).openapi({
  description: "Who authorized the refund (staff email / user id / service name). Recorded in the bronze audit trail.",
  example: "kevin@distribute.you",
});

// PATCH /v1/runs/:id/costs/:costId supports forward transitions out of `provisioned`
// plus the refund of a charged row. Phase 5 of γ migration plan: each silver mutation
// maps to a domain event (`cost.materialized` for actual, `cost.cancelled` for
// cancelled, `cost.refunded` for refunded). Re-provisioning an already-actual row has
// no domain meaning and is rejected with 400.
//
// `refunded` requires `reason` + `refundedBy`, and is only reachable from `actual`
// (409 otherwise — refunding something never charged is the existing cancel).
export const UpdateCostRequestSchema = z
  .object({
    status: z.enum(["actual", "cancelled", "refunded"]),
    reason: RefundReasonSchema.optional(),
    refundedBy: RefundedBySchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.status !== "refunded") return;
    if (!val.reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "reason is required when status is 'refunded'" });
    }
    if (!val.refundedBy) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refundedBy"], message: "refundedBy is required when status is 'refunded'" });
    }
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
    goal: GoalEnum.nullable(),
    brandProfileId: z.string().uuid().nullable(),
    audienceId: z.string().uuid().nullable(),
    workflowContext: z.string().nullable(),
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
    goal: GoalEnum.nullable(),
    brandProfileId: z.string().uuid().nullable(),
    audienceId: z.string().uuid().nullable(),
    workflowContext: z.string().nullable(),
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

export const ListRunsQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  brandId: z.string().optional(),
  campaignId: z.string().optional(),
  campaignIds: z.string().optional().openapi({
    description:
      "Comma-separated campaign ids (at most 500): the runs of ANY of them, in one request. Use it for a campaign FAMILY (every stored row of one logical campaign) instead of one call per id. With `limit`, the page is the newest `limit` runs across the whole set, the same rows you get by asking each id for `limit` runs and keeping the newest `limit` of the union. Combines with every other filter (AND), including `campaignId`. An empty list or more than 500 ids is a 400.",
  }),
  workflowSlug: z.string().optional(),
  featureSlug: z.string().optional(),
  goal: GoalEnum.optional(),
  brandProfileId: z.string().uuid().optional(),
  audienceId: z.string().uuid().optional(),
  workflowContext: z.string().optional(),
  serviceName: z.string().optional(),
  taskName: z.string().optional(),
  status: z.string().optional(),
  parentRunId: z.string().uuid().optional(),
  startedAfter: z.string().datetime().optional(),
  startedBefore: z.string().datetime().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  include: z.string().optional().openapi({
    description:
      "Comma-separated opt-in extras. `subtreeCost`: each run also carries the BILLED cost of its whole subtree (`totalCostInUsdCents`, `actualCostInUsdCents`, `provisionedCostInUsdCents`, equal to GET /v1/runs/{id}'s totals) and the same split on the frozen NET basis (`netTotalCostInUsdCents`, `netActualCostInUsdCents`, `netProvisionedCostInUsdCents`). An execute-workflow run has no own cost rows, so this is what it cost. Requires `limit` between 1 and 500. An unknown value is a 400.",
  }),
});

export const VendorRunsResponseSchema = z
  .object({
    runs: z.array(
      RunWithOwnCostSchema.extend({
        vendorOwnCostInUsdCents: z.string().openapi({ description: "VENDOR cost (before our markup, per costs-service's statement for the price version in force when each row was written) of the run's own status IN ('actual','provisioned') cost rows whose vendor cost is known: SUM(quantity x vendor unit cost). Excludes unpriced rows, never approximated at the billed price." }),
        vendorOwnActualCostInUsdCents: z.string(),
        vendorOwnProvisionedCostInUsdCents: z.string(),
        unpricedOwnCostInUsdCents: z.string().openapi({ description: "BILLED amount of the run's own actual/provisioned rows with NO known vendor cost. ownCostInUsdCents - unpricedOwnCostInUsdCents is the billed amount of the priced rows. Non-zero means vendorOwnCostInUsdCents does not cover the whole run." }),
        unpricedOwnActualCostInUsdCents: z.string(),
        unpricedOwnProvisionedCostInUsdCents: z.string(),
        unpricedOwnCostNames: z.array(z.string()).openapi({ description: "Distinct cost names of the run's OWN unpriced actual/provisioned rows, sorted." }),
        totalCostInUsdCents: z.string().openapi({ description: "BILLED cost of the run's whole SUBTREE (its own rows + every descendant run's), status IN ('actual','provisioned') — equal to GET /v1/runs/{id}'s totalCostInUsdCents. An execute-workflow run carries no own cost rows: this is what it cost." }),
        actualCostInUsdCents: z.string(),
        provisionedCostInUsdCents: z.string(),
        vendorTotalCostInUsdCents: z.string().openapi({ description: "VENDOR cost of the run's subtree actual/provisioned rows whose vendor cost is known. Excludes unpriced rows, never approximated at the billed price." }),
        vendorActualCostInUsdCents: z.string(),
        vendorProvisionedCostInUsdCents: z.string(),
        unpricedTotalCostInUsdCents: z.string().openapi({ description: "BILLED amount of the subtree's actual/provisioned rows with NO known vendor cost. Non-zero means vendorTotalCostInUsdCents does not cover the whole run." }),
        unpricedActualCostInUsdCents: z.string(),
        unpricedProvisionedCostInUsdCents: z.string(),
        unpricedCostNames: z.array(z.string()).openapi({ description: "Distinct cost names of the subtree's unpriced actual/provisioned rows, sorted. Empty = the vendor figure covers the whole run." }),
      }),
    ),
    limit: z.number().optional(),
    offset: z.number(),
  })
  .openapi("VendorRunsResponse");

export const ListRunsResponseSchema = z
  .object({
    runs: z.array(
      RunWithOwnCostSchema.extend({
        totalCostInUsdCents: z.string().optional().openapi({ description: "Present only with `include=subtreeCost`. BILLED cost of the run's whole SUBTREE (its own rows + every descendant run's), status IN ('actual','provisioned') — equal to GET /v1/runs/{id}'s totalCostInUsdCents." }),
        actualCostInUsdCents: z.string().optional().openapi({ description: "Present only with `include=subtreeCost`. Subtree billed cost, status = 'actual'." }),
        provisionedCostInUsdCents: z.string().optional().openapi({ description: "Present only with `include=subtreeCost`. Subtree billed cost, status = 'provisioned'." }),
        netTotalCostInUsdCents: z.string().optional().openapi({ description: "Present only with `include=subtreeCost`. Subtree cost on the frozen NET basis (post per-org usage discount, what the org pays) = SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)), status IN ('actual','provisioned'). A row written before the discount freeze reads net == gross." }),
        netActualCostInUsdCents: z.string().optional().openapi({ description: "Present only with `include=subtreeCost`. Subtree NET cost, status = 'actual'." }),
        netProvisionedCostInUsdCents: z.string().optional().openapi({ description: "Present only with `include=subtreeCost`. Subtree NET cost, status = 'provisioned'." }),
      }),
    ),
    limit: z.number().optional(),
    offset: z.number(),
  })
  .openapi("ListRunsResponse");

export const HealthResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    service: z.string(),
    database: z.enum(["ok", "slow", "unreachable"]),
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
  "x-goal": GoalEnum.optional().openapi({ description: "Brand runtime goal attribution: signup, meetingBooked, or purchase" }),
  "x-brand-profile-id": z.string().uuid().optional().openapi({ description: "Real brand-profile attribution ID" }),
  "x-audience-id": z.string().uuid().optional().openapi({ description: "Audience attribution ID (human-service org-scoped saved filter-set, audience.id). Inherited down the run tree." }),
  "x-workflow-context": z.string().optional().openapi({ description: "Stable workflow-context attribution key" }),
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
      description:
        "Service is degraded (database unreachable, or too slow to answer inside the probe budget)",
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
    query: ListRunsQuerySchema,
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
    "Updates a cost item status. Use to realize a provisioned cost (set status to 'actual'), cancel it (set status to 'cancelled'), or refund it (set status to 'refunded'). A refund means the spend really happened and the platform has decided not to charge it: the row leaves every charge predicate (so the org's usage total drops and its spendable balance rises, with no credit granted anywhere) while staying visible as real spend through the refunded aggregation columns on the stats reads. It requires `reason` + `refundedBy`, both recorded in the append-only bronze audit, and is reachable ONLY from a charged row — refunding a provisioned or cancelled cost is refused with 409, because a cost that was never charged is cancelled, not refunded. Refunding an already-refunded row is a no-op 200 with the row unchanged.",
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
    409: {
      description: "Refund refused — the cost was never charged (status is not 'actual')",
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
  summary: "Move a brand's runs, costs and events to a different org",
  description:
    "Moves every run of sourceOrgId that belongs to sourceBrandId to targetOrgId: runs whose brand_ids contains the brand (solo AND co-branded: a co-branded run follows the first of its brands to leave the org), plus untagged runs (no brand_ids) of the brand's campaigns (a campaign carried by a run tagged with the brand). Each moved run's cost rows (runs_costs.organization_id) and telemetry events (run_events.org_id) move with it; org_actual_totals and the campaign rollup follow by trigger. When targetBrandId is provided, the brand id is rewritten inside brand_ids everywhere (and inside the moved runs' events). Processed in chunks, each its own transaction; the platform usage each chunk moved is frozen in the same transaction and served by GET /internal/brand-transfers/moved-usage. Idempotent and safe under concurrent calls: a re-run moves nothing and records nothing.",
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

export const FeatureSlugCorrectionRequestSchema = z
  .object({
    rootRunIds: z.array(z.string().uuid()).min(1).max(500),
    featureSlug: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    correctedBy: z.string().trim().min(1),
  })
  .openapi("FeatureSlugCorrectionRequest");

export const FeatureSlugCorrectionResponseSchema = z
  .object({
    featureSlug: z.string(),
    correctedRuns: z.number(),
    correctedRunIds: z.array(z.string().uuid()),
  })
  .openapi("FeatureSlugCorrectionResponse");

registry.registerPath({
  method: "post",
  path: "/internal/runs/feature-slug-corrections",
  summary: "Fill a feature slug a writer failed to state on run subtrees",
  description:
    "Staff correction of recorded history. For each root run and its descendants, every run whose feature_slug is NULL gets featureSlug. One bronze run.feature_slug_corrected event is recorded per corrected run (payload: featureSlug, reason, correctedBy: the audit trail) and the projection fills runs.feature_slug; the feature-keyed rollups follow by trigger, so every cost read filtered by that feature then counts the subtree's cost. Only a NULL slug is filled: a run stating a slug keeps it, and the walk does not descend below a run labelled with another slug. Cost amounts are never touched. Idempotent: a re-run corrects nothing. 404 when a root run does not exist, 409 when a root already states another slug (nothing is written in either case).",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: FeatureSlugCorrectionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Correction recorded",
      content: { "application/json": { schema: FeatureSlugCorrectionResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
    404: { description: "A root run does not exist (missingRunIds)" },
    409: { description: "A root run already states another feature slug (conflictingRuns)" },
  },
});

export const BrandTransferMovedUsageQuerySchema = z
  .object({
    sourceOrgId: z.string().uuid(),
    sourceBrandId: z.string().uuid(),
    targetOrgId: z.string().uuid(),
  })
  .openapi("BrandTransferMovedUsageQuery");

export const BrandTransferMovedUsageResponseSchema = z
  .object({
    sourceOrgId: z.string().uuid(),
    sourceBrandId: z.string().uuid(),
    targetOrgId: z.string().uuid(),
    runsMoved: z.number().int(),
    costsMoved: z.number().int(),
    projectedGrossCents: z.string(),
    projectedNetCents: z.string(),
    actualGrossCents: z.string(),
    actualNetCents: z.string(),
    firstMovedAt: z.string().nullable(),
    lastMovedAt: z.string().nullable(),
  })
  .openapi("BrandTransferMovedUsageResponse");

registry.registerPath({
  method: "get",
  path: "/internal/brand-transfers/moved-usage",
  summary: "Platform usage moved by brand transfers (for balance-neutral billing)",
  description:
    "Sum, over every POST /internal/transfer-brand call for (sourceOrgId, sourceBrandId) -> targetOrgId, of the platform usage those calls moved from the source org to the target org. Frozen at each move, so later spend in either org never changes it; a re-run that moved nothing adds nothing. projected* = platform actual + provisioned cost rows whose org moved (the figures GET /internal/org-usage-total counts: spent_cents / net_spent_cents). actual* = platform committed cost rows of runs completed/failed at the move (the figures GET /internal/org-actual-total counts). Net = COALESCE(frozen net, gross) per row. Decimal strings; '0' when nothing moved. Answers only for moves already made: call POST /internal/transfer-brand first (idempotent).",
  security: [{ apiKey: [] }],
  request: { query: BrandTransferMovedUsageQuerySchema },
  responses: {
    200: {
      description: "Moved usage",
      content: { "application/json": { schema: BrandTransferMovedUsageResponseSchema } },
    },
    400: {
      description: "Invalid query",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

export const DeleteRunsByOrgParamsSchema = z
  .object({
    orgId: z.string().uuid(),
  })
  .openapi("DeleteRunsByOrgParams");

export const DeleteRunsByOrgResponseSchema = z
  .object({
    orgId: z.string().uuid(),
    deletedRuns: z.number(),
    tombstoneEvents: z.number(),
  })
  .openapi("DeleteRunsByOrgResponse");

registry.registerPath({
  method: "delete",
  path: "/internal/runs/by-org/{orgId}",
  summary: "Delete runs-service state for an org",
  description:
    "Idempotently tears down runs-service-owned org state for a deleted internal org UUID. Writes bronze teardown events, then removes the live silver run projection so runs_costs and run_events cascade out of active billing/stat surfaces. Existing bronze history is retained for audit.",
  security: [{ apiKey: [] }],
  request: {
    params: DeleteRunsByOrgParamsSchema,
  },
  responses: {
    200: {
      description: "Org teardown complete",
      content: { "application/json": { schema: DeleteRunsByOrgResponseSchema } },
    },
    400: {
      description: "Invalid org ID",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
    500: {
      description: "Teardown failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
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
    total_expected_cents: z.string().openapi({ description: "GROSS (list-price) actualized platform total: SUM(total_cost_in_usd_cents) over every completed/failed run's committed platform rows. Unchanged — existing drift-reconciliation consumers keep today's number." }),
    net_total_expected_cents: z.string().openapi({ description: "Frozen NET (post-usage-discount) actualized platform total over the SAME rows: SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)). Pre-discount rows read net == gross (non-retroactive), so with no discount net == total_expected_cents. billing-service reads this for 'Confirmed charges' / the actual credit balance, consistent with net_spent_cents. numeric(16,10) decimal string." }),
    runs: z.array(RunsExpectedTotalsEntrySchema),
  })
  .openapi("RunsExpectedTotalsResponse");

export const OrgActualTotalQuerySchema = z
  .object({
    org_id: z.string().uuid(),
  })
  .openapi("OrgActualTotalQuery");

export const OrgActualTotalResponseSchema = z
  .object({
    org_id: z.string().uuid(),
    total_expected_cents: z.string().openapi({ description: "GROSS actualized platform total. Byte-identical to total_expected_cents on GET /internal/runs-expected-totals for the same org at the same moment." }),
    net_total_expected_cents: z.string().openapi({ description: "Frozen NET (post-usage-discount) actualized platform total. Byte-identical to net_total_expected_cents on GET /internal/runs-expected-totals for the same org at the same moment: SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) over committed platform cost rows (status='actual', cost_source='platform') of the org's completed/failed runs. Provisioned holds, cancelled, refunded and BYOK rows are excluded. Decimal string, '0' when nothing is charged." }),
    as_of: z.string().datetime(),
  })
  .openapi("OrgActualTotalResponse");

export const OrgUsageTotalQuerySchema = z
  .object({
    org_id: z.string().uuid(),
  })
  .openapi("OrgUsageTotalQuery");

export const OrgUsageTotalResponseSchema = z
  .object({
    org_id: z.string().uuid(),
    spent_cents: z.string().openapi({ description: "GROSS platform usage total (undiscounted). Unchanged — existing consumers keep today's number." }),
    net_spent_cents: z.string().openapi({ description: "Frozen NET platform usage total: SUM(COALESCE(net, gross)) over the same platform-projected rows. billing-service reads this for the spendable balance once it opts in; historical rows read net == gross." }),
    as_of: z.string().datetime(),
  })
  .openapi("OrgUsageTotalResponse");

registry.registerPath({
  method: "get",
  path: "/internal/runs-expected-totals",
  summary: "Per-run expected platform-actual cost totals for an org",
  description:
    "Returns, for every completed/failed run in the org, the SUM of runs_costs.total_cost_in_usd_cents over rows where cost_source='platform' AND status='actual'. Runs with zero qualifying gross total are omitted. The org-level total_expected_cents is the GROSS sum of all per-run totals (unchanged). net_total_expected_cents is the frozen NET (post-usage-discount) equivalent over the SAME rows — SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)); pre-discount rows read net == gross so it equals total_expected_cents when the org has no discount. All values are strings to preserve numeric(16,10) precision — billing-service uses total_expected_cents to detect drift against confirmed transactions and net_total_expected_cents for the discounted 'Confirmed charges' / actual credit balance.",
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
  path: "/internal/org-actual-total",
  summary: "Org-level ACTUALIZED platform total (O(1))",
  description:
    "The org's actualized platform charges, gross and net of the usage discount: the same two totals as GET /internal/runs-expected-totals (committed platform cost rows of completed/failed runs; provisioned holds excluded), without the per-run list. Served from org_actual_totals, a per-org total maintained by database triggers in the same transaction as every cost / run write, so it is never stale and reads in O(1) regardless of ledger size. Decimal strings with numeric(16,10) precision.",
  security: [{ apiKey: [] }],
  request: {
    query: OrgActualTotalQuerySchema,
  },
  responses: {
    200: {
      description: "Org-level actualized platform totals",
      content: { "application/json": { schema: OrgActualTotalResponseSchema } },
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
    "Returns the total platform usage spend for one org over runs belonging to org_id where cost_source='platform' and status IN ('actual', 'provisioned'). Cancelled costs and org/BYOK costs are excluded. spent_cents is the GROSS total SUM(total_cost_in_usd_cents) (unchanged). net_spent_cents is the frozen NET total SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) — billing-service reads it for the spendable balance once it opts in. Both are decimal strings with numeric(16,10) precision.",
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

export const OrgNoCampaignTotalQuerySchema = z
  .object({
    org_id: z.string().uuid(),
    since: z.string().datetime({ offset: true }).openapi({ description: "Cutover instant (ISO 8601). Only cost rows created at or after it are counted." }),
  })
  .openapi("OrgNoCampaignTotalQuery");

export const OrgNoCampaignTotalResponseSchema = z
  .object({
    org_id: z.string().uuid(),
    since: z.string(),
    spent_cents: z.string().openapi({ description: "GROSS no-campaign part of GET /internal/org-usage-total's spent_cents: platform actual + provisioned rows of the org whose run carries no campaign, created at or after since." }),
    net_spent_cents: z.string().openapi({ description: "Frozen NET twin of spent_cents (the no-campaign part of net_spent_cents)." }),
    total_expected_cents: z.string().openapi({ description: "GROSS no-campaign part of GET /internal/org-actual-total's total_expected_cents: platform actual rows of the org's completed/failed runs that carry no campaign, created at or after since." }),
    net_total_expected_cents: z.string().openapi({ description: "Frozen NET twin of total_expected_cents (the no-campaign part of net_total_expected_cents)." }),
    as_of: z.string().datetime(),
  })
  .openapi("OrgNoCampaignTotalResponse");

registry.registerPath({
  method: "get",
  path: "/internal/org-no-campaign-total",
  summary: "No-campaign part of the org's two platform totals, from a cutover instant",
  description:
    "For one org, the part of GET /internal/org-usage-total (spent_cents / net_spent_cents) and of GET /internal/org-actual-total (total_expected_cents / net_total_expected_cents) that belongs to NO campaign, counting only cost rows created at or after `since`. Same predicates as those totals, so total minus this figure is the campaign part, field for field. A cost row is campaign spend iff its run carries a campaign (a child run inherits its parent's at creation; a run's campaign never changes). Decimal strings, scale 10. 500 if a cost row in the window has no known campaign status (pre-backfill): never folded either way.",
  security: [{ apiKey: [] }],
  request: { query: OrgNoCampaignTotalQuerySchema },
  responses: {
    200: { description: "No-campaign parts of the two org totals", content: { "application/json": { schema: OrgNoCampaignTotalResponseSchema } } },
    400: { description: "Invalid query parameters", content: { "application/json": { schema: ValidationErrorSchema } } },
    401: { description: "Unauthorized" },
    500: { description: "Cost rows of unknown campaign status in the window", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const NoCampaignFiguresSchema = {
  noCampaignCostInUsdCents: z.string().openapi({ description: "GROSS platform spend (actual + provisioned) of runs with no campaign." }),
  netNoCampaignCostInUsdCents: z.string().openapi({ description: "Frozen NET twin of noCampaignCostInUsdCents." }),
  campaignCostInUsdCents: z.string().openapi({ description: "GROSS platform spend of runs carrying a campaign." }),
  netCampaignCostInUsdCents: z.string().openapi({ description: "Frozen NET twin of campaignCostInUsdCents." }),
  unknownCostInUsdCents: z.string().openapi({ description: "GROSS platform spend whose campaign status is not known yet (pre-backfill rows). Stated apart, never folded into either side; '0' once backfilled." }),
  netUnknownCostInUsdCents: z.string().openapi({ description: "Frozen NET twin of unknownCostInUsdCents." }),
};

export const NoCampaignMonthlyQuerySchema = z.object({
  orgBasis: z
    .enum(["current", "incurred"])
    .optional()
    .openapi({
      description:
        "Which org each cost row counts under in orgs[]. `current` (absent = current): the cost row's org now, where a brand transfer moved it. `incurred`: the org its run was opened under, so a transferred brand's history stays on the org that held the brand when the money was spent. months[] (fleet totals) is the same on both.",
    }),
});

export const NoCampaignMonthlyResponseSchema = z
  .object({
    timezone: z.literal("UTC"),
    statuses: z.array(z.string()),
    orgBasis: z.enum(["current", "incurred"]).openapi({ description: "The basis orgs[] is keyed on (the query's, `current` when absent)." }),
    months: z
      .array(z.object({ month: z.string().openapi({ description: "YYYY-MM, UTC, of the cost row's created_at." }), ...NoCampaignFiguresSchema, orgsWithNoCampaignSpend: z.number().int() }))
      .openapi({ description: "Fleet totals, DENSE from the month of the first org-attributed platform cost row to the current month." }),
    orgs: z
      .array(
        z.object({
          orgId: z.string(),
          month: z.string(),
          ...NoCampaignFiguresSchema,
          noCampaignByCostName: z
            .array(z.object({ costName: z.string(), noCampaignCostInUsdCents: z.string(), netNoCampaignCostInUsdCents: z.string() }))
            .openapi({ description: "The no-campaign figure split per cost name (names with a non-zero no-campaign spend). Sums to noCampaignCostInUsdCents / netNoCampaignCostInUsdCents." }),
        })
      )
      .openapi({ description: "SPARSE: one entry per (org, month) with at least one platform cost row. Ordered by month, orgId." }),
  })
  .openapi("NoCampaignMonthlyResponse");

registry.registerPath({
  method: "get",
  path: "/internal/stats/costs/no-campaign/monthly",
  summary: "Fleet-wide platform spend per org per UTC month, campaign vs no campaign (service-auth only)",
  description:
    "Every org-attributed platform cost row (actual + provisioned, the org-usage-total predicate), per org per UTC calendar month of its created_at: spend of runs with no campaign, spend of runs carrying a campaign, and spend whose campaign status is not known yet, gross and net, plus the no-campaign figure per cost name. months[] = fleet totals, dense since inception.",
  request: { query: NoCampaignMonthlyQuerySchema },
  security: [{ apiKey: [] }],
  responses: {
    200: { description: "Monthly campaign / no-campaign split", content: { "application/json": { schema: NoCampaignMonthlyResponseSchema } } },
    401: { description: "Unauthorized" },
    400: { description: "Invalid orgBasis", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- Refund schemas (staff cost-refund action) ---

// The set of cost rows a refund targets. preview and apply take the SAME filter,
// so what the preview shows is exactly what apply writes. Only CHARGED
// (status='actual') PLATFORM (cost_source='platform') rows can ever match:
// a provisioned hold was never charged (that is the existing cancel) and a BYOK
// row is paid straight to the provider, so there is nothing to comp.
export const RefundFilterSchema = z.object({
  orgId: z.string().uuid().openapi({ description: "Org whose charged costs are being comped. Required — a refund always belongs to one customer." }),
  rootRunId: z.string().uuid().optional().openapi({ description: "Restrict to this run AND all of its descendants, so staff can refund a whole run's costs without enumerating rows by hand." }),
  costName: z.string().min(1).optional().openapi({ description: "Exact cost-name match." }),
  costNamePrefix: z.string().min(1).optional().openapi({ description: "Cost-name prefix match (LIKE 'prefix%', with % and _ escaped).", example: "zai-glm-5.3" }),
  serviceName: z.string().min(1).optional().openapi({ description: "Restrict to costs whose run has this service name." }),
  taskName: z.string().min(1).optional().openapi({ description: "Restrict to costs whose run has this task name." }),
  startedAfter: z.string().datetime().optional().openapi({ description: "Inclusive lower bound on the run's started_at." }),
  startedBefore: z.string().datetime().optional().openapi({ description: "Exclusive upper bound on the run's started_at." }),
});

export type RefundFilter = z.infer<typeof RefundFilterSchema>;

export const RefundPreviewRequestSchema = RefundFilterSchema.openapi("RefundPreviewRequest");

export const RefundApplyRequestSchema = RefundFilterSchema.extend({
  reason: RefundReasonSchema,
  refundedBy: RefundedBySchema,
}).openapi("RefundApplyRequest");

export const RefundMatchedCostSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    costName: z.string(),
    serviceName: z.string(),
    taskName: z.string(),
    totalCostInUsdCents: z.string(),
    netCostInUsdCents: z.string(),
    runStartedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .openapi("RefundMatchedCost");

export const RefundTotalsSchema = z.object({
  costCount: z.number().openapi({ description: "Number of charged cost rows the filter matches." }),
  runCount: z.number().openapi({ description: "Number of distinct runs those rows belong to." }),
  grossTotalInUsdCents: z.string().openapi({ description: "GROSS total of the matched rows. 10-decimal string." }),
  netTotalInUsdCents: z.string().openapi({ description: "Frozen NET total of the matched rows — what the org is actually charged today, and therefore what its spendable balance rises by once the refund is applied. 10-decimal string." }),
});

export const RefundPreviewResponseSchema = RefundTotalsSchema.extend({
  orgId: z.string().uuid(),
  costsTruncated: z.boolean().openapi({ description: "True when more rows match than the listing cap. The TOTALS always cover the full matched set — only the `costs` array is capped." }),
  costsListLimit: z.number(),
  costs: z.array(RefundMatchedCostSchema),
}).openapi("RefundPreviewResponse");

export const RefundApplyResponseSchema = RefundTotalsSchema.extend({
  orgId: z.string().uuid(),
  refundedCostCount: z.number().openapi({ description: "Rows actually flipped to 'refunded' by this call. Zero on a re-apply — already-refunded rows no longer match, so no amount moves twice." }),
}).openapi("RefundApplyResponse");

registry.registerPath({
  method: "post",
  path: "/internal/cost-refunds/preview",
  summary: "Preview which charged costs a refund would comp, and for how much",
  description:
    "Returns the charged platform cost rows matching the filter (status='actual', cost_source='platform') plus the gross and net totals over the FULL matched set. Writes nothing. Apply takes the same filter and refunds exactly this set. Rows already refunded never match, so a preview after an apply comes back empty.",
  security: [{ apiKey: [] }],
  request: {
    body: { content: { "application/json": { schema: RefundPreviewRequestSchema } } },
  },
  responses: {
    200: {
      description: "Matched rows + totals",
      content: { "application/json": { schema: RefundPreviewResponseSchema } },
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
  path: "/internal/cost-refunds/apply",
  summary: "Refund (comp) the charged costs matching a filter",
  description:
    "Flips every matching charged platform cost row to status='refunded', recording the reason and the actor in the append-only bronze audit (`cost.refunded`). The org stops owing that money — its usage total drops and its spendable balance rises by the net amount — with no credit granted anywhere. The spend stays visible as REAL spend through the refunded aggregation columns on the stats reads, so a cost-per-outcome consumer is unaffected. Idempotent: a re-apply matches zero rows. Refuses (422) above a 5000-row cap so a wide filter is narrowed rather than discovered afterwards.",
  security: [{ apiKey: [] }],
  request: {
    body: { content: { "application/json": { schema: RefundApplyRequestSchema } } },
  },
  responses: {
    200: {
      description: "Refund applied",
      content: { "application/json": { schema: RefundApplyResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    401: { description: "Unauthorized" },
    422: {
      description: "Too many rows matched for one apply",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// --- Incurred, never-charged costs (late declaration of past spend) ---
//
// A cost that REALLY happened at the provider, that the platform decided never to
// charge, and that was never declared at the time. It is born in the state a
// refund leaves a row in (`refunded`), so it is in NO charge predicate at any
// instant, while every incurred/refunded read counts it. `created_at` = the stated
// `incurredAt` (migration 0048), so dated reads place it on the day it happened.
// See CLAUDE.md "Incurred, never-charged costs".

export const INCURRED_COSTS_MAX_ITEMS = 500;

export const IncurredCostItemSchema = z
  .object({
    runId: z.string().uuid().openapi({ description: "EXISTING run the spend belongs to (org, campaign, workflow attribution come from it)." }),
    costName: z.string().min(1).openapi({ description: "Catalogue cost name. Priced by runs-service at the costs-service platform price of the name as resolved now (same resolution as a live cost write).", example: "instantly-account-email-sent" }),
    quantity: z.number().positive(),
    incurredAt: z.string().datetime({ offset: true }).openapi({ description: "When the spend really happened. Must not be in the future nor before the run's started_at. Becomes the cost row's created_at.", example: "2026-09-02T14:31:07.000Z" }),
    idempotencyKey: z.string().min(1).max(256).openapi({
      description: "Mandatory per-item dedup key, unique PER RUN (same index as live cost writes). An item whose (runId, idempotencyKey) already exists is reported `already_recorded` and never written twice. Self-namespace it.",
      example: "instantly:incurred:<sequence-cost-id>:account",
    }),
  })
  .openapi("IncurredCostItem");

export const IncurredCostsPreviewRequestSchema = z
  .object({
    items: z.array(IncurredCostItemSchema).min(1).max(INCURRED_COSTS_MAX_ITEMS),
  })
  .openapi("IncurredCostsPreviewRequest");

export const IncurredCostsApplyRequestSchema = IncurredCostsPreviewRequestSchema.extend({
  reason: RefundReasonSchema,
  authorizedBy: RefundedBySchema.openapi({ description: "Who decided not to charge this spend (staff email / user id). Recorded in the bronze audit trail." }),
}).openapi("IncurredCostsApplyRequest");

export const IncurredCostOutcomeEnum = z
  .enum(["to_record", "recorded", "already_recorded", "invalid"])
  .openapi("IncurredCostOutcome");

export const IncurredCostItemResultSchema = z
  .object({
    runId: z.string().uuid(),
    idempotencyKey: z.string(),
    costName: z.string(),
    outcome: IncurredCostOutcomeEnum.openapi({ description: "preview: to_record | already_recorded | invalid. apply: recorded | already_recorded." }),
    costId: z.string().uuid().nullable().openapi({ description: "The cost row (new or existing). Null for to_record and invalid." }),
    status: CostStatusEnum.nullable().openapi({ description: "Stored status: 'refunded' for a row recorded here; for already_recorded, whatever the existing row holds." }),
    incurredAt: z.string().datetime().nullable().openapi({ description: "Stated instant (to_record), or the stored created_at (recorded / already_recorded)." }),
    totalCostInUsdCents: z.string().nullable().openapi({ description: "GROSS. To be written (to_record) or stored. 10-decimal string. Null for invalid." }),
    netCostInUsdCents: z.string().nullable().openapi({ description: "Frozen NET (org usage discount at write time). 10-decimal string. Null for invalid." }),
    error: z.string().nullable().openapi({ description: "Why the item is invalid. Null otherwise." }),
  })
  .openapi("IncurredCostItemResult");

const IncurredCostsTotalsSchema = z.object({
  itemCount: z.number(),
  toRecordCount: z.number().openapi({ description: "Items this call writes (apply: wrote)." }),
  alreadyRecordedCount: z.number().openapi({ description: "Items whose (runId, idempotencyKey) already exists. Written nothing." }),
  invalidCount: z.number(),
  totalCostInUsdCents: z.string().openapi({ description: "GROSS incurred total of the items to record (apply: recorded). Excludes already_recorded. 10-decimal string." }),
  netTotalCostInUsdCents: z.string().openapi({ description: "Frozen NET total of the same items. 10-decimal string." }),
  alreadyRecordedTotalCostInUsdCents: z.string().openapi({ description: "GROSS total of the already_recorded rows as stored. 10-decimal string." }),
  unitPrices: z.record(z.string(), z.string()).openapi({ description: "Price per unit in USD cents applied per cost name (costs-service platform price resolved by this call)." }),
});

export const IncurredCostsPreviewResponseSchema = IncurredCostsTotalsSchema.extend({
  items: z.array(IncurredCostItemResultSchema),
}).openapi("IncurredCostsPreviewResponse");

export const IncurredCostsApplyResponseSchema = IncurredCostsTotalsSchema.extend({
  recordedCount: z.number().openapi({ description: "Rows written by this call (status 'refunded'). Zero on a re-run." }),
  items: z.array(IncurredCostItemResultSchema),
}).openapi("IncurredCostsApplyResponse");

const incurredDescription =
  "Never in a charge predicate at any instant: the row is born `refunded` (no transient `actual`), so org-usage-total, org-actual-total, runs-expected-totals, no-campaign totals, budget/pacing reads and billing never see it, and nothing is notified to billing. Counted wherever incurred spend is: the refunded columns of GET/POST /v1/stats/costs, /v1/stats/public/costs and their timeseries, every rollup. Dated: created_at = incurredAt; run-dated reads use the run's started_at as for any cost. Priced by runs-service: costs-service platform price of each name resolved now, × quantity; net frozen with the org's current usage discount. Platform cost source only. Max 500 items per call, one transaction.";

registry.registerPath({
  method: "post",
  path: "/internal/incurred-costs/preview",
  summary: "Dry run: price late-declared, never-charged past spend without writing",
  description: `Prices exactly the items apply would record and reports, per item, to_record / already_recorded / invalid (unknown run, incurredAt in the future or before the run started, duplicate key in the body). Writes nothing. ${incurredDescription}`,
  security: [{ apiKey: [] }],
  request: { body: { content: { "application/json": { schema: IncurredCostsPreviewRequestSchema } } } },
  responses: {
    200: { description: "Priced preview", content: { "application/json": { schema: IncurredCostsPreviewResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ValidationErrorSchema } } },
    401: { description: "Unauthorized" },
    422: { description: "Unknown cost name", content: { "application/json": { schema: ErrorSchema } } },
    502: { description: "costs-service or billing (usage discount) unavailable", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/incurred-costs/apply",
  summary: "Record past spend that really happened and was never charged, at the date it happened",
  description: `Writes one cost row per item not already recorded, status 'refunded', with reason + authorizedBy in the append-only bronze audit (cost.added payload, origin 'incurred_uncharged'). Idempotent per (runId, idempotencyKey). Any invalid item = 422 with the per-item list and nothing written. ${incurredDescription}`,
  security: [{ apiKey: [] }],
  request: { body: { content: { "application/json": { schema: IncurredCostsApplyRequestSchema } } } },
  responses: {
    200: { description: "Recorded", content: { "application/json": { schema: IncurredCostsApplyResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ValidationErrorSchema } } },
    401: { description: "Unauthorized" },
    422: { description: "Unknown cost name, or at least one invalid item (body = the preview shape, nothing written)", content: { "application/json": { schema: IncurredCostsPreviewResponseSchema } } },
    502: { description: "costs-service or billing (usage discount) unavailable", content: { "application/json": { schema: ErrorSchema } } },
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
  campaignIds: z.string().optional().openapi({ description: "Comma-separated campaign ids (at most 500): answer for ANY of them in one request. Use it for a campaign FAMILY (every stored row of one logical campaign) instead of one call per id; the numbers equal the sum of the per-id answers. Combines with every other filter (AND), including `campaignId`. Blank and duplicate ids are dropped; an empty list or more than 500 ids is a 400." }),
  workflowSlug: z.string().optional().openapi({ description: "Filter by a single workflow slug" }),
  workflowSlugs: z.string().optional().openapi({ description: "Filter by multiple workflow slugs (comma-separated). Takes precedence over workflowSlug when both are provided." }),
  workflowDynastySlug: z.string().optional().openapi({ description: "Filter by workflow dynasty slug. Resolved to all versioned slugs via workflow-service. Takes precedence over workflowSlug/workflowSlugs." }),
  featureSlug: z.string().optional().openapi({ description: "Filter by a single feature slug" }),
  featureSlugs: z.string().optional().openapi({ description: "Filter by multiple feature slugs (comma-separated). Takes precedence over featureSlug when both are provided. Callers that compute feature lineage themselves (e.g. features-service) pass the full lineage in one call to avoid N HTTP roundtrips." }),
  goal: GoalEnum.optional().openapi({ description: "Filter by explicit run/cost goal attribution." }),
  brandProfileId: z.string().uuid().optional().openapi({ description: "Filter by explicit brand-profile attribution. Matches cost override first, then run attribution." }),
  audienceId: z.string().uuid().optional().openapi({ description: "Filter by explicit audience attribution (audience.id). Matches cost override first, then run attribution." }),
  workflowContext: z.string().optional().openapi({ description: "Filter by explicit stable workflow-context attribution. Matches cost override first, then run attribution." }),
  attributionStatus: z.enum(["all", "tagged", "unattributed"]).optional().openapi({ description: "Optional attribution filter. tagged means brandProfileId or audienceId is present; unattributed means both are null. Default all." }),
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
        refundedCostInUsdCents: z.string().openapi({ description: "GROSS spend that really happened but is NOT charged to the org (status = 'refunded'). Excluded from totalCostInUsdCents / actualCostInUsdCents (accounting view). Add it back to actualCostInUsdCents to reconstruct REAL spend for a cost-per-outcome (performance) view." }),
        netRefundedCostInUsdCents: z.string().optional().openapi({ description: "Frozen NET refunded spend = SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) where status = 'refunded'." }),
        netTotalCostInUsdCents: z.string().optional().openapi({ description: "Frozen NET displayed total (gross reduced by each row's frozen usage discount). Gross fields above are unchanged; read net only when you want the discounted figure." }),
        netActualCostInUsdCents: z.string().optional(),
        netProvisionedCostInUsdCents: z.string().optional(),
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
    groupBy: z.string().min(1).openapi({ description: "Comma-separated dimensions to aggregate by. Allowed: brandId, workflowSlug, campaignId, featureSlug, goal, brandProfileId, audienceId, workflowContext, serviceName, taskName, costName. Dynasty groupBy is NOT supported on POST." }),
    brandId: z.string().optional(),
    campaignId: z.string().optional(),
    workflowSlug: z.string().optional(),
    workflowSlugs: z.array(z.string().min(1)).optional().openapi({ description: "Filter by multiple workflow slugs. Takes precedence over workflowSlug." }),
    featureSlug: z.string().optional(),
    featureSlugs: z.array(z.string().min(1)).optional().openapi({ description: "Filter by multiple feature slugs. Takes precedence over featureSlug." }),
    goal: GoalEnum.optional(),
    brandProfileId: z.string().uuid().optional(),
    audienceId: z.string().uuid().optional(),
    workflowContext: z.string().optional(),
    attributionStatus: z.enum(["all", "tagged", "unattributed"]).optional(),
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
            refundedCostInUsdCents: z.string().openapi({ description: "GROSS spend that really happened but is NOT charged to the org (status = 'refunded'). Excluded from totalCostInUsdCents / actualCostInUsdCents (accounting view). Add it back to actualCostInUsdCents to reconstruct REAL spend for a cost-per-outcome (performance) view." }),
            netRefundedCostInUsdCents: z.string().optional().openapi({ description: "Frozen NET refunded spend = SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) where status = 'refunded'." }),
            netTotalCostInUsdCents: z.string().optional().openapi({ description: "Frozen NET displayed total (gross reduced by each row's frozen usage discount). Gross fields above are unchanged; read net only when you want the discounted figure." }),
            netActualCostInUsdCents: z.string().optional(),
            netProvisionedCostInUsdCents: z.string().optional(),
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
        totalCostInUsdCents: z.string().openapi({ description: "GROSS displayed total for the window (status IN actual,provisioned). Unchanged — list price." }),
        actualCostInUsdCents: z.string().openapi({ description: "GROSS committed spend for the window (status = actual). Unchanged — list price." }),
        provisionedCostInUsdCents: z.string().openapi({ description: "GROSS provisioned holds for the window (status = provisioned). Unchanged — list price." }),
        netTotalCostInUsdCents: z.string().openapi({ description: "NET (post-usage-discount) displayed total = SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) where status IN actual,provisioned. Frozen per-row net, no read-time discount math; pre-freeze rows fall back to gross." }),
        netActualCostInUsdCents: z.string().openapi({ description: "NET (post-usage-discount) committed spend = SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) where status = actual. Pace / display budgets on this to reflect what the org actually pays." }),
        netProvisionedCostInUsdCents: z.string().openapi({ description: "NET (post-usage-discount) provisioned holds = SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) where status = provisioned." }),
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
    campaignIds: z.string().optional().openapi({ description: "Comma-separated campaign ids (at most 500): answer for ANY of them in one request. Use it for a campaign FAMILY (every stored row of one logical campaign) instead of one call per id; the numbers equal the sum of the per-id answers. Combines with every other filter (AND), including `campaignId`. Blank and duplicate ids are dropped; an empty list or more than 500 ids is a 400." }),
    featureSlug: z.string().optional(),
    featureSlugs: z.string().optional().openapi({ description: "Filter by multiple feature slugs (comma-separated). Takes precedence over featureSlug." }),
    workflowDynastySlug: z.string().optional().openapi({ description: "Filter by workflow dynasty slug. Resolved to all versioned slugs via workflow-service." }),
    taskName: z.string().optional(),
    costSource: z
      .enum(["platform", "org"])
      .optional()
      .openapi({
        description:
          "Filter by WHO PAID the provider. platform = the platform paid, i.e. spend an org can be billed for. org = BYOK, paid by the org directly to its own provider key and never billed. Omit to count both, which is what this endpoint has always done (an unfiltered request is byte-identical to before this filter existed). An unrecognised value is a 400 — never a silently unfiltered answer.",
      }),
  })
  .openapi("PublicCostsQuery");

export const PublicCostsTimeseriesQuerySchema = z
  .object({
    interval: z
      .enum(["day", "week", "month"])
      .optional()
      .openapi({ description: "Bucket granularity. UTC-day aligned via DATE_TRUNC(interval, started_at AT TIME ZONE tz). Default day." }),
    tz: z
      .string()
      .optional()
      .openapi({ description: "IANA timezone name used for bucket-boundary alignment (e.g. America/New_York). Default UTC. Invalid names fail the request." }),
    orgId: z.string().uuid().optional(),
    brandId: z.string().optional(),
    campaignId: z.string().optional(),
    campaignIds: z.string().optional().openapi({ description: "Comma-separated campaign ids (at most 500): answer for ANY of them in one request. Use it for a campaign FAMILY (every stored row of one logical campaign) instead of one call per id; the numbers equal the sum of the per-id answers. Combines with every other filter (AND), including `campaignId`. Blank and duplicate ids are dropped; an empty list or more than 500 ids is a 400." }),
    groupBy: z
      .enum(["campaignId"])
      .optional()
      .openapi({
        description:
          "Split every bucket per campaign: one bucket per (period, campaignId), each carrying `campaignId`, ordered by period then campaignId. With `campaignIds` this is a campaign family's dated spend broken down per stored row, in one request. Omit for one bucket per period (the default, unchanged).",
      }),
    featureSlug: z.string().optional(),
    featureSlugs: z
      .string()
      .optional()
      .openapi({ description: "Filter by multiple feature slugs (comma-separated). Takes precedence over featureSlug." }),
    workflowDynastySlug: z
      .string()
      .optional()
      .openapi({ description: "Filter by workflow dynasty slug. Resolved to all versioned slugs via workflow-service." }),
    taskName: z.string().optional(),
    startedAfter: z
      .string()
      .datetime()
      .optional()
      .openapi({ description: "Only include runs with started_at >= this ISO-8601 timestamp." }),
    startedBefore: z
      .string()
      .datetime()
      .optional()
      .openapi({ description: "Only include runs with started_at <= this ISO-8601 timestamp." }),
    costSource: z
      .enum(["platform", "org"])
      .optional()
      .openapi({
        description:
          "Filter by WHO PAID the provider. platform = the platform paid, i.e. spend an org can be billed for — this is the figure to divide by the window length for a per-day burn rate. org = BYOK, paid by the org directly to its own provider key and never billed. Omit to count both, which is what this endpoint has always done (an unfiltered request is byte-identical to before this filter existed). run_count and the bucket set are unaffected by the filter: it narrows only the summed cost rows. An unrecognised value is a 400 — never a silently unfiltered answer.",
      }),
  })
  .openapi("PublicCostsTimeseriesQuery");

export const PublicCostsTimeseriesResponseSchema = z
  .object({
    interval: z.enum(["day", "week", "month"]),
    timezone: z.string(),
    buckets: z.array(
      z.object({
        period: z
          .string()
          .openapi({
            description:
              "Bucket start date in YYYY-MM-DD (local to timezone). For interval=day with tz=UTC this is the UTC calendar day. Only intervals with at least one run appear — empty intervals are absent, never fabricated.",
            example: "2026-07-01",
          }),
        campaignId: z
          .string()
          .nullable()
          .optional()
          .openapi({ description: "Present only with groupBy=campaignId: the campaign this bucket belongs to (null for runs with no campaign)." }),
        totalCostInUsdCents: z.string().openapi({ description: "SUM total_cost_in_usd_cents for cost rows of runs started in this bucket, status IN ('actual','provisioned'). 10-decimal string." }),
        actualCostInUsdCents: z.string(),
        provisionedCostInUsdCents: z.string(),
        cancelledCostInUsdCents: z.string(),
        refundedCostInUsdCents: z.string().openapi({ description: "GROSS spend that really happened but is NOT charged to the org (status = 'refunded'). Excluded from totalCostInUsdCents / actualCostInUsdCents (accounting view). Add it back to actualCostInUsdCents to reconstruct REAL spend for a cost-per-outcome (performance) view." }),
        netRefundedCostInUsdCents: z.string().openapi({ description: "Frozen NET refunded spend = SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) where status = 'refunded'." }),
        netTotalCostInUsdCents: z.string().openapi({ description: "Frozen NET (post per-org usage-discount) displayed total = SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) where status IN ('actual','provisioned'). Gross fields above are unchanged; sum net when you want the discounted (actually-collected) figure. Pre-freeze / no-discount rows fall back to gross." }),
        netActualCostInUsdCents: z.string().openapi({ description: "Frozen NET realized spend = SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) where status = 'actual'. This is the post-usage-discount amount the fleet actually collects." }),
        netProvisionedCostInUsdCents: z.string().openapi({ description: "Frozen NET provisioned holds = SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) where status = 'provisioned'." }),
        runCount: z.number(),
      })
    ),
  })
  .openapi("PublicCostsTimeseriesResponse");

export const StatsRunOutcomesQuerySchema = z
  .object({
    groupBy: z.string().optional().openapi({ description: "Comma-separated run-side dimensions: campaignId, workflowSlug, featureSlug, serviceName, taskName. Default campaignId." }),
    scope: z.enum(["entry", "all"]).optional().openapi({ description: "entry (default): count a run only when its parent is not a run of the same campaign (or it has no parent), i.e. the run the agent started (in practice workflow / execute-workflow), not the service calls it fans out into. all: every run the filters match, i.e. what GET /v1/runs lists for the same filters." }),
    brandId: z.string().optional().openapi({ description: "Runs where this brand is in brandIds." }),
    campaignId: z.string().optional(),
    campaignIds: z.string().optional().openapi({ description: "Comma-separated campaign ids (at most 500): a campaign FAMILY in one request. ANDs with campaignId. Blank/duplicate ids dropped; empty or more than 500 is a 400." }),
    workflowSlug: z.string().optional(),
    featureSlug: z.string().optional(),
    serviceName: z.string().optional(),
    taskName: z.string().optional(),
    startedAfter: z.string().datetime().optional().openapi({ description: "Inclusive lower bound on the run's started_at." }),
    startedBefore: z.string().datetime().optional().openapi({ description: "Inclusive upper bound on the run's started_at." }),
  })
  .openapi("StatsRunOutcomesQuery");

export const StatsRunOutcomesResponseSchema = z
  .object({
    scope: z.enum(["entry", "all"]),
    groups: z.array(
      z.object({
        dimensions: z.record(z.string(), z.string().nullable()),
        runCount: z.number().int().openapi({ description: "Runs in the group, every status." }),
        completedCount: z.number().int().openapi({ description: "Runs with status completed." }),
        failedCount: z.number().int().openapi({ description: "Runs with status failed." }),
        runningCount: z.number().int().openapi({ description: "Runs still running." }),
        successRate: z.number().nullable().openapi({ description: "completedCount / (completedCount + failedCount), a fraction in [0,1]. Running runs are excluded (not decided yet). null when no run has ended." }),
        medianDurationMs: z.number().int().nullable().openapi({ description: "Median of (completedAt - startedAt) over the COMPLETED runs, in milliseconds. Failed and running runs are excluded. null when the group has no completed run (never 0)." }),
        minStartedAt: z.string().datetime().nullable(),
        maxStartedAt: z.string().datetime().nullable(),
      })
    ),
  })
  .openapi("StatsRunOutcomesResponse");

export const TaskOutcomesQuerySchema = z
  .object({
    serviceName: z.string().openapi({ description: "Required. ONE service name (runs.service_name), e.g. apollo-service. 400 when absent." }),
    sample: z.coerce.number().int().min(1).max(1000).optional().openapi({ description: "Per task, only the most recent `sample` runs (by startedAt desc) are measured. Default 200, 1..1000; out of range is a 400." }),
  })
  .openapi("TaskOutcomesQuery");

export const TaskOutcomesResponseSchema = z
  .object({
    serviceName: z.string(),
    sample: z.number().int(),
    tasks: z.array(
      z.object({
        taskName: z.string().openapi({ description: "The run's task_name with every UUID (case-insensitive) replaced by the literal {id}: GET /v1/offers/d5ec.../revenue groups as GET /v1/offers/{id}/revenue." }),
        totalRunCount: z.number().int().openapi({ description: "ALL runs of this normalized task, all time, every org and org-less platform runs." }),
        sampleSize: z.number().int().openapi({ description: "Runs measured: the task's most recent runs, at most `sample`." }),
        completedCount: z.number().int().openapi({ description: "Sampled runs with status completed." }),
        failedCount: z.number().int().openapi({ description: "Sampled runs with status failed." }),
        runningCount: z.number().int().openapi({ description: "Sampled runs still running." }),
        successRate: z.number().nullable().openapi({ description: "completedCount / (completedCount + failedCount), in [0,1]. null when no sampled run has ended." }),
        avgDurationMs: z.number().int().nullable().openapi({ description: "Mean of (completedAt - startedAt) over the COMPLETED sampled runs, rounded to integer ms. null when none completed." }),
        sumCompletedDurationMs: z.number().int().openapi({ description: "Sum of (completedAt - startedAt) over the completed sampled runs, integer ms, so a consumer can merge groups exactly (sum / completedCount). 0 when none completed." }),
        avgCostInUsdCents: z.string().openapi({ description: "Mean over the sampled runs of each run's WHOLE-SUBTREE cost: SUM(total_cost_in_usd_cents) of status='actual' cost rows (all cost sources, gross billed basis) on the run and all its descendants. A run with no cost counts as 0. 10-decimal string." }),
        sumCostInUsdCents: z.string().openapi({ description: "Sum of the sampled runs' whole-subtree actual cost (avgCostInUsdCents x sampleSize). 10-decimal string." }),
        lastRunAt: z.string().datetime().openapi({ description: "startedAt of the task's most recent run." }),
      })
    ),
  })
  .openapi("TaskOutcomesResponse");

// --- Stats path registrations ---

registry.registerPath({
  method: "get",
  path: "/v1/stats/run-outcomes",
  summary: "How runs ended and how long they took, per group",
  description:
    "Per group (default one per campaignId): completed / failed / running counts, success rate and median duration of the completed runs, over the filtered runs of the calling org (x-org-id). By default counts ENTRY runs only (scope=entry): a run whose parent is not a run of the same campaign, i.e. one row per run the agent started, not one per service call. scope=all counts every matching run and reconciles status-for-status with GET /v1/runs under the same filters. Groups are ordered by runCount desc.",
  security: [{ apiKey: [] }],
  request: { query: StatsRunOutcomesQuerySchema },
  responses: {
    200: {
      description: "Run outcome groups",
      content: { "application/json": { schema: StatsRunOutcomesResponseSchema } },
    },
    400: {
      description: "Invalid groupBy, scope, campaignIds or date",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});


registry.registerPath({
  method: "get",
  path: "/internal/stats/task-outcomes",
  summary: "Fleet-wide outcome, duration and cost per task of one service (service-auth only)",
  description:
    "Fleet-wide (every org and org-less platform runs; no x-org-id), for ONE service: per normalized task (task_name with every UUID replaced by {id}), how its most recent `sample` runs ended (completed / failed / running, success rate), their mean duration, and the mean WHOLE-SUBTREE actual cost of one run (the run and all its descendants, every cost source, gross billed basis; cancelled / provisioned / refunded rows excluded). totalRunCount counts all runs of the task, all time. Tasks are ordered by totalRunCount desc; a service with no runs returns tasks: []. Slow by design (api-service at sample=200: 30-60 s, up to ~2 min on a busy box): cache it and refresh in the background.",
  security: [{ apiKey: [] }],
  request: { query: TaskOutcomesQuerySchema },
  responses: {
    200: { description: "Per-task outcomes", content: { "application/json": { schema: TaskOutcomesResponseSchema } } },
    400: { description: "Missing serviceName or sample out of range", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/stats/costs",
  summary: "Aggregate costs with GROUP BY",
  description:
    "Returns aggregated costs grouped by one or more dimensions (brandId, workflowSlug, campaignId, featureSlug, goal, brandProfileId, audienceId, workflowContext, serviceName, taskName, costName, workflowDynastySlug). The attribution dimensions are explicit stored tags only: runs/costs without audienceId or brandProfileId stay null and are never assigned by name/hash/workflow fallback. When costName is included in groupBy, the response includes totalQuantity and uses INNER JOIN. workflowDynastySlug re-groups versioned slugs under their dynasty. featureSlugs (comma-separated) lets callers that compute feature lineage themselves filter across many slugs in one call. Organization identified via x-org-id header.",
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
    "Returns aggregated cost groups for each requested (serviceName, taskName) pair in ONE SQL pass. Replaces N separate GET /v1/stats/costs calls when a caller (e.g. features-service stats registry) needs counts for K specific service+task combos under the same scoping (org, brand, feature lineage, goal, profile attribution, date window). Response is a list of buckets in input order. A bucket with no matching rows returns groups: []. Dynasty groupBy is NOT supported on POST — callers compute lineage client-side and pass featureSlugs / workflowSlugs explicitly. Organization identified via x-org-id header.",
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
    "Returns aggregated actual + provisioned costs across temporal windows. Organization identified via x-org-id header. Each window carries GROSS (list-price) total/actual/provisioned AND the frozen NET (post-usage-discount) equivalents (net*CostInUsdCents) so a consumer can pace / display budgets on what the org actually pays. Net is the sum of the per-row frozen net column (COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents) for pre-freeze rows) — no read-time discount math.",
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
    "Returns aggregated costs across all organizations, grouped by brandId, workflowSlug, campaignId, featureSlug, serviceName, costName, or workflowDynastySlug. Supports optional filters: orgId, brandId, campaignId, featureSlug, featureSlugs (comma-separated), workflowDynastySlug, taskName, and costSource (platform = spend the platform paid for and can bill; org = BYOK, paid by the org to its own provider key and never billed; omitted counts both, as it always has). Each group carries both GROSS (total/actual/provisioned) and frozen NET (netTotal/netActual/netProvisioned, post per-org usage-discount) cost fields; gross fields are unchanged, sum net for what the fleet actually collects. No authentication required.",
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
  path: "/v1/stats/public/costs/timeseries",
  summary: "Public cost time-series (no auth)",
  description:
    "Returns fleet-wide (cross-org) spend for a filter, split into dated buckets by run started_at (interval=day|week|month, default day; tz default UTC). Uses the SAME WHERE filters and cost aggregator as GET /v1/stats/public/costs, plus a time partition — so summing the buckets for a filter equals the untimed total from /v1/stats/public/costs for the same filter (reconciliation invariant). Supports filters: orgId, brandId, campaignId, featureSlug, featureSlugs (comma-separated), workflowDynastySlug, taskName, optional startedAfter/startedBefore window bounds, and costSource. costSource=platform counts ONLY spend the platform paid the provider for — i.e. what an org can actually be billed — excluding BYOK rows the org paid directly to its own provider key; combined with an orgId, a date window and netActualCostInUsdCents, that is the org's realized post-discount burn per day. Omitting costSource counts both payers, as this endpoint always has, and the filter never changes run_count or which buckets appear. Buckets are ordered ascending (oldest first); intervals with no runs are absent (never fabricated). Each bucket carries both GROSS (total/actual/provisioned) and frozen NET (netTotal/netActual/netProvisioned, post per-org usage-discount) cost fields; gross fields are unchanged, sum netActual for the fleet's realized post-discount revenue. Cost fields are 10-decimal strings preserving numeric(16,10) precision. No authentication required. Cross-tenant aggregate.",
  request: {
    query: PublicCostsTimeseriesQuerySchema.extend({
      hasCampaign: z
        .enum(["true", "false"])
        .optional()
        .openapi({
          description:
            "true = only runs carrying a campaign (a child run inherits its parent's at creation; a run's campaign never changes): the spend a customer is charged since billing stopped charging spend outside a campaign. false = only runs with no campaign. Omit for both (unchanged). Narrows runs, so run_count and the bucket set follow it.",
        }),
    }),
  },
  responses: {
    200: {
      description: "Dated cost buckets",
      content: { "application/json": { schema: PublicCostsTimeseriesResponseSchema } },
    },
    400: {
      description: "Invalid interval value",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const StatsCostsTimeseriesQuerySchema = z
  .object({
    interval: z.enum(["day", "week", "month"]).optional().openapi({ description: "Bucket granularity: DATE_TRUNC(interval, started_at AT TIME ZONE tz). Default day." }),
    tz: z.string().optional().openapi({ description: "IANA timezone the buckets are aligned to (e.g. Europe/Paris), so a day bucket is the caller's local day. Default UTC. An unknown name is a 400.", example: "Europe/Paris" }),
    groupBy: z.string().optional().openapi({ description: "Comma-separated, any of campaignId, serviceName, taskName (each at most once). campaignId splits every bucket per campaign; serviceName/taskName split it per task of the run (spend by ACTION) and add committedRunCount. One bucket per (period, keys...), ordered by period then the keys in this order: campaignId, serviceName, taskName. Summed over the split, a period's money fields and runCount equal the unsplit bucket. Omit for one bucket per period.", example: "serviceName,taskName" }),
    brandId: z.string().optional().openapi({ description: "Runs where this brand is in brandIds." }),
    campaignId: z.string().optional(),
    campaignIds: z.string().optional().openapi({ description: "Comma-separated campaign ids (at most 500): a campaign FAMILY in one request. ANDs with campaignId. Blank/duplicate ids dropped; empty or more than 500 is a 400." }),
    featureSlug: z.string().optional(),
    featureSlugs: z.string().optional().openapi({ description: "Comma-separated feature slugs. Takes precedence over featureSlug." }),
    workflowSlug: z.string().optional(),
    serviceName: z.string().optional(),
    taskName: z.string().optional(),
    startedAfter: z.string().datetime().optional().openapi({ description: "Only runs with started_at >= this ISO-8601 timestamp." }),
    startedBefore: z.string().datetime().optional().openapi({ description: "Only runs with started_at <= this ISO-8601 timestamp." }),
  })
  .openapi("StatsCostsTimeseriesQuery");

export const StatsCostsTimeseriesResponseSchema = z
  .object({
    interval: z.enum(["day", "week", "month"]),
    timezone: z.string(),
    buckets: z.array(
      z.object({
        period: z.string().openapi({ description: "Bucket start date YYYY-MM-DD, local to `timezone`. Buckets with no run are absent.", example: "2026-10-06" }),
        campaignId: z.string().nullable().optional().openapi({ description: "Present only with groupBy=campaignId (null for runs with no campaign)." }),
        serviceName: z.string().optional().openapi({ description: "Present only when groupBy includes serviceName: the service the runs belong to." }),
        taskName: z.string().optional().openapi({ description: "Present only when groupBy includes taskName: the task the runs ran.", example: "email-send-step-2" }),
        totalCostInUsdCents: z.string().openapi({ description: "Same field, same definition as GET /v1/stats/costs: cost rows of the bucket's runs, status IN ('actual','provisioned'). 10-decimal string." }),
        actualCostInUsdCents: z.string(),
        provisionedCostInUsdCents: z.string(),
        cancelledCostInUsdCents: z.string(),
        refundedCostInUsdCents: z.string(),
        netTotalCostInUsdCents: z.string(),
        netActualCostInUsdCents: z.string(),
        netProvisionedCostInUsdCents: z.string(),
        netRefundedCostInUsdCents: z.string(),
        runCount: z.number().openapi({ description: "Runs started in the bucket (each run lands in exactly one bucket)." }),
        minStartedAt: z.string().nullable(),
        maxStartedAt: z.string().nullable().openapi({ description: "Latest started_at in the bucket (ISO-8601)." }),
        committedRunCount: z.number().optional().openapi({ description: "Present only when groupBy includes serviceName or taskName: runs of the bucket carrying at least one actual or provisioned cost row (the ACTIONS that cost something). A run whose cost rows are all cancelled, or with no cost row, is not counted (it still is in runCount)." }),
      })
    ),
  })
  .openapi("StatsCostsTimeseriesResponse");

registry.registerPath({
  method: "get",
  path: "/v1/stats/costs/timeseries",
  summary: "Org-scoped run counts and spend per dated bucket",
  description:
    "The org's runs (x-org-id) split into dated buckets by started_at in the caller's timezone (interval=day|week|month, tz), optionally per campaign and/or per task (groupBy=campaignId,serviceName,taskName; the task split adds committedRunCount). One read for a week of daily figures instead of one GET /v1/stats/costs call per day: a bucket's figures equal GET /v1/stats/costs?groupBy=campaignId with startedAfter/startedBefore at that bucket's local bounds. Run-side filters only. Same money fields as GET /v1/stats/costs.",
  security: [{ apiKey: [] }],
  request: { query: StatsCostsTimeseriesQuerySchema },
  responses: {
    200: { description: "Dated buckets", content: { "application/json": { schema: StatsCostsTimeseriesResponseSchema } } },
    400: { description: "Invalid interval, tz, groupBy, date or campaignIds", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

export const VendorCostsTimeseriesResponseSchema = z
  .object({
    interval: z.enum(["day", "week", "month"]),
    timezone: z.string(),
    buckets: z.array(
      z.object({
        period: z.string().openapi({ description: "Bucket start date in YYYY-MM-DD, exactly as on GET /v1/stats/public/costs/timeseries.", example: "2026-09-21" }),
        campaignId: z.string().nullable().optional().openapi({ description: "Present only with groupBy=campaignId." }),
        totalCostInUsdCents: z.string().openapi({ description: "BILLED gross, status IN ('actual','provisioned') — byte-equal to the public twin's field for the same query." }),
        actualCostInUsdCents: z.string(),
        provisionedCostInUsdCents: z.string(),
        refundedCostInUsdCents: z.string(),
        vendorTotalCostInUsdCents: z.string().openapi({ description: "VENDOR cost (before our markup, per costs-service's statement for the price version in force) of the status IN ('actual','provisioned') rows whose vendor cost is known: SUM(quantity x vendor unit cost). Excludes unpriced rows — never approximated at the billed price." }),
        vendorActualCostInUsdCents: z.string(),
        vendorProvisionedCostInUsdCents: z.string(),
        vendorRefundedCostInUsdCents: z.string().openapi({ description: "Vendor cost of refunded rows — spend that happened and was not charged. Add to vendorActualCostInUsdCents for the real vendor spend." }),
        unpricedTotalCostInUsdCents: z.string().openapi({ description: "BILLED gross of the status IN ('actual','provisioned') rows with NO known vendor cost (costs-service states null, or no price version matches the row's billed unit price at its write time). totalCostInUsdCents - unpricedTotalCostInUsdCents is the billed amount of the priced rows." }),
        unpricedActualCostInUsdCents: z.string(),
        unpricedProvisionedCostInUsdCents: z.string(),
        unpricedRefundedCostInUsdCents: z.string(),
        unpricedCostNames: z.array(z.string()).openapi({ description: "Distinct cost names of the unpriced actual/provisioned rows in this bucket, sorted." }),
        runCount: z.number(),
      })
    ),
  })
  .openapi("VendorCostsTimeseriesResponse");

registry.registerPath({
  method: "get",
  path: "/internal/stats/costs/timeseries/vendor",
  summary: "Dated spend on the VENDOR-COST basis (service-auth only)",
  description:
    "The dated spend of GET /v1/stats/public/costs/timeseries — same query parameters, same row set, same buckets — on the vendor-cost basis: what the same cost rows cost us from the vendor before our markup. Each row is priced by the costs-service price version of its cost name whose billed unit price equals the one the row froze and which was in force when the row was written; that version's vendor unit cost x quantity. Rows whose vendor cost is unknown are reported as unpriced billed spend, never folded in. Service-auth only: the vendor cost reveals the margin and is never served on a public route. 502 when the costs-service vendor catalogue cannot be read.",
  security: [{ apiKey: [] }],
  request: { query: PublicCostsTimeseriesQuerySchema },
  responses: {
    200: { description: "Dated vendor-basis cost buckets", content: { "application/json": { schema: VendorCostsTimeseriesResponseSchema } } },
    400: { description: "Invalid query parameters", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "costs-service vendor catalogue unavailable or malformed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export const VendorCostsGroupedQuerySchema = z.object({
  groupBy: z.string().openapi({ description: "Comma-separated, required. Any of: brandId, workflowSlug, workflowDynastySlug, campaignId, featureSlug, audienceId, serviceName, taskName, costName. Same SQL expression per key as GET /v1/stats/costs (audienceId = COALESCE(cost row, run)). workflowSlug and workflowDynastySlug are exclusive.", example: "audienceId,workflowSlug" }),
  orgId: z.string().optional().openapi({ description: "Absent = the whole fleet (every org)." }),
  brandId: z.string().optional(),
  campaignId: z.string().optional(),
  campaignIds: z.string().optional().openapi({ description: "Comma-separated campaign FAMILY, at most 500." }),
  featureSlug: z.string().optional(),
  featureSlugs: z.string().optional().openapi({ description: "Comma-separated; wins over featureSlug." }),
  workflowSlug: z.string().optional(),
  workflowSlugs: z.string().optional().openapi({ description: "Comma-separated; wins over workflowSlug." }),
  workflowDynastySlug: z.string().optional().openapi({ description: "Resolved to its versioned slugs via workflow-service; wins over workflowSlugs." }),
  audienceId: z.string().optional().openapi({ description: "COALESCE(cost row audience, run audience) = value." }),
  serviceName: z.string().optional(),
  taskName: z.string().optional(),
  startedAfter: z.string().optional(),
  startedBefore: z.string().optional(),
  costSource: z.enum(["platform", "org"]).optional().openapi({ description: "Payer filter. Absent = both." }),
});

export const VendorCostsGroupedResponseSchema = z
  .object({
    groups: z.array(
      z.object({
        dimensions: z.record(z.string(), z.string().nullable()).openapi({ description: "One key per groupBy key (workflowDynastySlug replaces workflowSlug)." }),
        totalCostInUsdCents: z.string().openapi({ description: "BILLED gross, status IN ('actual','provisioned') — equal to totalCostInUsdCents of GET /v1/stats/costs / GET /v1/stats/public/costs for the same filters and group." }),
        actualCostInUsdCents: z.string(),
        provisionedCostInUsdCents: z.string(),
        refundedCostInUsdCents: z.string(),
        vendorTotalCostInUsdCents: z.string().openapi({ description: "VENDOR cost (before our markup) of the actual+provisioned rows whose vendor cost is known. Unpriced rows excluded, never approximated." }),
        vendorActualCostInUsdCents: z.string(),
        vendorProvisionedCostInUsdCents: z.string(),
        vendorRefundedCostInUsdCents: z.string().openapi({ description: "Vendor cost of refunded rows (happened, not charged). Not in vendorTotal." }),
        unpricedTotalCostInUsdCents: z.string().openapi({ description: "BILLED gross of the actual+provisioned rows with NO known vendor cost. Never folded into vendorTotal, never zeroed." }),
        unpricedActualCostInUsdCents: z.string(),
        unpricedProvisionedCostInUsdCents: z.string(),
        unpricedRefundedCostInUsdCents: z.string(),
        unpricedCostNames: z.array(z.string()).openapi({ description: "Distinct cost names of the unpriced actual/provisioned rows in this group, sorted." }),
      })
    ),
  })
  .openapi("VendorCostsGroupedResponse");

registry.registerPath({
  method: "get",
  path: "/internal/stats/costs/vendor",
  summary: "Undated grouped spend on the VENDOR-COST basis (service-auth only)",
  description:
    "The undated grouped cost aggregation (GET /v1/stats/costs org-scoped, GET /v1/stats/public/costs fleet) on the vendor-cost basis, priced exactly as GET /internal/stats/costs/timeseries/vendor prices a row. Groups carry only runs with at least one actual/provisioned/refunded cost row (a group whose rows are all cancelled or absent is omitted — its figures would all be 0). No runCount. Service-auth only: the vendor cost reveals the margin. 502 when the costs-service vendor catalogue cannot be read.",
  security: [{ apiKey: [] }],
  request: { query: VendorCostsGroupedQuerySchema },
  responses: {
    200: { description: "Grouped vendor-basis costs", content: { "application/json": { schema: VendorCostsGroupedResponseSchema } } },
    400: { description: "Invalid query parameters", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "costs-service vendor catalogue unavailable or malformed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const CostMarginFigures = {
  billedCostInUsdCents: z.string().openapi({ description: "BILLED gross of CHARGED platform rows (status 'actual', cost_source 'platform'). = pricedBilled + unpricedBilled." }),
  netBilledCostInUsdCents: z.string().openapi({ description: "billedCostInUsdCents net of the per-org usage discount frozen on each row." }),
  pricedBilledCostInUsdCents: z.string().openapi({ description: "Billed gross of the charged rows whose vendor cost is known." }),
  netPricedBilledCostInUsdCents: z.string(),
  vendorCostInUsdCents: z.string().openapi({ description: "What the vendor charged us (before our markup) for the PRICED charged rows." }),
  marginCostInUsdCents: z.string().openapi({ description: "pricedBilled - vendor, exactly. Priced rows only: unpriced spend is never counted at zero vendor cost." }),
  netMarginCostInUsdCents: z.string().openapi({ description: "netPricedBilled - vendor, exactly." }),
  unpricedBilledCostInUsdCents: z.string().openapi({ description: "Billed gross of charged rows with NO known vendor cost. Kept out of margin." }),
  netUnpricedBilledCostInUsdCents: z.string(),
  refundedCostInUsdCents: z.string().openapi({ description: "Billed gross of REFUNDED rows (spend that happened, not charged). In no other figure." }),
  vendorRefundedCostInUsdCents: z.string().openapi({ description: "Vendor cost of the priced refunded rows." }),
  unpricedRefundedCostInUsdCents: z.string(),
  unpricedCostNames: z.array(z.string()).openapi({ description: "Distinct cost names of this row's charged/refunded rows with no known vendor cost, sorted." }),
};

export const CostMarginQuerySchema = z.object({
  orgId: z.string().uuid().optional().openapi({ description: "One org (the run's org frozen on each cost row). Absent = the whole fleet." }),
});

export const CostMarginResponseSchema = z
  .object({
    total: z.object(CostMarginFigures),
    providers: z.array(z.object({ provider: z.string().nullable().openapi({ description: "Vendor per costs-service; null when costs-service never listed the cost name." }), ...CostMarginFigures })),
    costItems: z.array(z.object({ provider: z.string().nullable(), costName: z.string(), ...CostMarginFigures })),
  })
  .openapi("CostMarginResponse");

registry.registerPath({
  method: "get",
  path: "/internal/stats/costs/margin",
  summary: "Platform billed vs vendor cost and margin, per provider and cost item (service-auth only)",
  description:
    "Platform-billed spend since inception, fleet-wide (or one org): a total, one row per provider and one per (provider, cost item), each with billed gross/net, vendor cost, margin and the unpriced remainder. Billed = charged rows (status 'actual'); provisioned, cancelled and BYOK rows are in no figure; refunded rows are stated apart. Vendor cost per row is priced exactly as GET /internal/stats/costs/vendor prices it. Provider = the matched price version's provider (a cost name can change vendor over time); for an unpriced row, the provider of its name's version served when it was written. Invariants per row: margin + vendor == pricedBilled; netMargin + vendor == netPricedBilled; billed == pricedBilled + unpricedBilled. Rows ordered by billed desc. Service-auth only: reveals the margin. 502 when the costs-service vendor catalogue cannot be read.",
  security: [{ apiKey: [] }],
  request: { query: CostMarginQuerySchema },
  responses: {
    200: { description: "Margin by provider and cost item", content: { "application/json": { schema: CostMarginResponseSchema } } },
    400: { description: "Invalid orgId", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "costs-service vendor catalogue unavailable or malformed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export const CostMarginTimeseriesResponseSchema = z
  .object({
    interval: z.literal("month"),
    timezone: z.literal("UTC"),
    periods: z.array(z.string()).openapi({ description: "Every month (YYYY-MM-01, UTC) from the first cost row in scope through the current month, oldest first. Empty when no row is in scope." }),
    providers: z.array(
      z.object({
        provider: z.string().nullable().openapi({ description: "Same attribution as GET /internal/stats/costs/margin; null when costs-service never listed the cost name." }),
        buckets: z.array(
          z.object({
            period: z.string().openapi({ description: "Month start, YYYY-MM-01 (UTC), of the cost rows' created_at." }),
            complete: z.boolean().openapi({ description: "false for the current month, which is not over." }),
            ...CostMarginFigures,
          }),
        ).openapi({ description: "One bucket per entry of `periods`, same order; zeros where the provider had no row that month." }),
      }),
    ),
  })
  .openapi("CostMarginTimeseriesResponse");

registry.registerPath({
  method: "get",
  path: "/internal/stats/costs/margin/timeseries",
  summary: "Platform billed vs vendor cost and margin per provider, per UTC month since inception (service-auth only)",
  description:
    "GET /internal/stats/costs/margin split by provider and by UTC calendar month of each cost row's created_at, from the first row in scope through the current month, every provider carrying every month. Same rows, same provider attribution and same figures as the margin read: for each provider the sum of its months equals its row on the margin read, field by field (vendor months telescope from the rounded running sum so they add up to the 1e-10 cent). Providers ordered as the margin read. Service-auth only: reveals the margin. 502 when the costs-service vendor catalogue cannot be read.",
  security: [{ apiKey: [] }],
  request: { query: CostMarginQuerySchema },
  responses: {
    200: { description: "Monthly margin per provider", content: { "application/json": { schema: CostMarginTimeseriesResponseSchema } } },
    400: { description: "Invalid orgId", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "costs-service vendor catalogue unavailable or malformed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export const CostConsumptionQuerySchema = z
  .object({
    costNames: z.string().optional().openapi({ description: "Comma-separated cost names (blanks/duplicates dropped, max 500). Absent = every cost name." }),
    since: z.string().optional().openapi({ description: "YYYY-MM-DD: only rows created on or after this UTC day. Absent = since inception." }),
    orgId: z.string().uuid().optional().openapi({ description: "Only cost rows of this org (the RUN's org, frozen on the cost row). Absent = fleet-wide." }),
    brandId: z.string().optional().openapi({ description: "Only cost rows whose run carries this brand in brand_ids (solo or co-branded)." }),
    groupBy: z.string().optional().openapi({ description: "Comma-separated subset of orgId, brandId: adds that key to every day/total row. Grouped by brandId, a co-branded run's row counts under EACH of its brands (sums across brands then exceed the ungrouped figure); a run with no brand lands under brandId null. With a brandId filter, the only brand group is that brand. Absent = no grouping beyond day x costName x costSource." }),
  })
  .openapi("CostConsumptionQuery");

const CostConsumptionFiguresSchema = {
  costName: z.string(),
  costSource: z.enum(["platform", "org"]).openapi({ description: "Whose key the unit went through: 'platform' = our vendor account, 'org' = the customer's own key (BYOK). Never merged." }),
  quantity: z.string().openapi({ description: "Units consumed at the vendor: SUM(quantity) of rows with status 'actual' or 'refunded' (a refund is spend that happened and that we did not charge, so the unit was still consumed). Provisioned holds and cancelled rows are excluded. Decimal string, scale 6." }),
  refundedQuantity: z.string().openapi({ description: "The part of quantity carried by refunded rows (already inside quantity). Decimal string, scale 6." }),
  billedCostInUsdCents: z.string().openapi({ description: "Gross billed: SUM(total_cost_in_usd_cents) of 'actual' rows (the margin read's billed). Scale 10." }),
  netBilledCostInUsdCents: z.string().openapi({ description: "Billed net of the per-org usage discount frozen on each row (gross when the row predates the freeze). Scale 10." }),
  refundedCostInUsdCents: z.string().openapi({ description: "Gross of refunded rows: spend that happened and that we did not charge. Not inside billed. Scale 10." }),
  netRefundedCostInUsdCents: z.string().openapi({ description: "Net of refunded rows. Scale 10." }),
};
const CostConsumptionGroupKeysSchema = {
  orgId: z.string().nullable().optional().openapi({ description: "Present only with groupBy containing orgId; null for org-less platform runs." }),
  brandId: z.string().nullable().optional().openapi({ description: "Present only with groupBy containing brandId; null for runs with no brand." }),
};

export const CostConsumptionResponseSchema = z
  .object({
    timezone: z.literal("UTC"),
    since: z.string().nullable(),
    statuses: z.array(z.string()).openapi({ description: "Row statuses counted as consumption: ['actual','refunded']." }),
    groupBy: z.array(z.enum(["orgId", "brandId"])).openapi({ description: "Grouping keys applied, in canonical order (orgId, brandId); [] when none." }),
    days: z
      .array(z.object({ day: z.string().openapi({ description: "UTC day of the cost row's created_at, YYYY-MM-DD." }), ...CostConsumptionGroupKeysSchema, ...CostConsumptionFiguresSchema }))
      .openapi({ description: "SPARSE: one entry per (day, group keys, costName, costSource) with at least one counted row. Ordered by day, orgId, brandId, costName, costSource." }),
    totals: z
      .array(z.object({ ...CostConsumptionGroupKeysSchema, ...CostConsumptionFiguresSchema }))
      .openapi({ description: "Per (group keys, costName, costSource), the sum of its days exactly. Ordered by orgId, brandId, costName, costSource." }),
  })
  .openapi("CostConsumptionResponse");

registry.registerPath({
  method: "get",
  path: "/internal/stats/costs/consumption",
  summary: "Units consumed and money billed per UTC day per cost name, fleet-wide or per org / brand, platform vs org key apart (service-auth only)",
  description:
    "Quantity consumed and money billed per UTC day of each cost row's created_at, per cost name and per cost source (platform key vs the org's own key, never merged): fleet-wide (every org, and org-less platform runs) by default, narrowed by orgId / brandId and optionally grouped by orgId and/or brandId. Counts rows with status 'actual' or 'refunded' — the same rows the margin read counts as spend that really happened; provisioned holds and cancelled rows are excluded. Billed = 'actual' rows (gross and net), refunded stated apart, as in the margin read. Filter by costNames and a since day. Sparse days. Service-auth only.",
  security: [{ apiKey: [] }],
  request: { query: CostConsumptionQuerySchema },
  responses: {
    200: { description: "Daily consumption per cost name and source", content: { "application/json": { schema: CostConsumptionResponseSchema } } },
    400: { description: "Invalid costNames, since, orgId, brandId or groupBy", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/runs/vendor",
  summary: "Run list with each run's own cost on the VENDOR-COST basis (service-auth only)",
  description:
    "The run list of GET /v1/runs — same query parameters, same runs, same order, same page — for the org given by the REQUIRED `orgId` query parameter (not x-org-id: a staff caller reads any org). Each run carries GET /v1/runs' billed own-cost fields byte-for-byte, plus its own cost (`vendorOwn*`) and its whole subtree's cost (`total*` billed = GET /v1/runs/{id}'s total, `vendorTotal*`) on the vendor-cost basis — an execute-workflow run's cost is its subtree, it has no own rows — each cost row priced by the costs-service price version of its cost name whose billed unit price equals the one the row froze and which was in force when the row was written (the same pricing as GET /internal/stats/costs/timeseries/vendor). Rows with no known vendor cost are reported as unpriced billed spend with their cost names, never folded in or zeroed. Service-auth only: the vendor cost reveals the margin. 502 when the costs-service vendor catalogue cannot be read.",
  security: [{ apiKey: [] }],
  request: { query: ListRunsQuerySchema.extend({ orgId: z.string().uuid() }) },
  responses: {
    200: { description: "Runs with billed and vendor-basis own cost", content: { "application/json": { schema: VendorRunsResponseSchema } } },
    400: { description: "Missing/invalid orgId or invalid query parameters", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "costs-service vendor catalogue unavailable or malformed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export const RunSubtreeCostsResponseSchema = z
  .object({
    runs: z.array(
      z.object({
        id: z.string().uuid(),
        audienceId: z.string().nullable(),
        campaignId: z.string().nullable(),
        actualCostInUsdCents: z.string().openapi({ description: "BILLED committed (status 'actual') cost of the run's whole subtree (its own rows + every descendant's). Equals GET /internal/runs/vendor's actualCostInUsdCents for the run." }),
        netActualCostInUsdCents: z.string().openapi({ description: "Same rows on the frozen NET basis (COALESCE(net, gross) per row). Equals GET /v1/runs?include=subtreeCost's netActualCostInUsdCents." }),
        vendorActualCostInUsdCents: z.string().openapi({ description: "Same rows on the VENDOR basis, rows whose vendor cost is known only. Equals GET /internal/runs/vendor's vendorActualCostInUsdCents." }),
        unpricedActualCostInUsdCents: z.string().openapi({ description: "BILLED amount of the same rows with no known vendor cost. Equals GET /internal/runs/vendor's unpricedActualCostInUsdCents." }),
      }),
    ),
  })
  .openapi("RunSubtreeCostsResponse");

registry.registerPath({
  method: "get",
  path: "/internal/runs/subtree-costs",
  summary: "Every matching run with its subtree's committed cost on the billed, net and vendor bases (service-auth only)",
  description:
    "EVERY run of the org (REQUIRED `orgId` query parameter) matching the filters, newest first, no paging, read in one statement: each run's whole-subtree committed (status 'actual') cost on the billed, frozen-net and vendor bases, plus the billed amount with no known vendor cost. A run whose subtree has no committed cost row reads 0 on every basis. Per run the figures equal GET /internal/runs/vendor (billed, vendor, unpriced) and GET /v1/runs?include=subtreeCost (net). Requires `brandId` or `campaignId`. Service-auth only: the vendor cost reveals the margin. 502 when the costs-service vendor catalogue cannot be read.",
  security: [{ apiKey: [] }],
  request: {
    query: z.object({
      orgId: z.string().uuid(),
      brandId: z.string().optional().openapi({ description: "Runs whose brand_ids contain this brand. brandId or campaignId is required." }),
      campaignId: z.string().optional(),
      serviceName: z.string().optional(),
      taskName: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Every matching run with its subtree committed cost", content: { "application/json": { schema: RunSubtreeCostsResponseSchema } } },
    400: { description: "Missing/invalid orgId, no brandId nor campaignId, or an empty filter", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "costs-service vendor catalogue unavailable or malformed", content: { "application/json": { schema: ErrorSchema } } },
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
    "Creates a run originating from a system-level caller (cron job, webhook handler, internal worker). Optional body.parentRunId opens it as the CHILD of a caller's run (its cost then counts in that run's subtree), inheriting nothing from it. Requires x-service-name. Accepts optional x-org-id and x-user-id headers — when provided, the values are stored on the row so the run can be attributed to an organization (e.g. a Stripe webhook charging a specific org's account). Both default to null when absent. Idempotency: pass body.idempotencyKey for safe retries (Stripe webhook redelivery, queue replay, etc.). Repeated calls return the original run with HTTP 200. The key is globally unique across the runs table — callers MUST self-namespace (e.g. `stripe:<txn_id>`). A mismatched (serviceName, taskName) on the same key returns 409.",
  security: [{ apiKey: [] }],
  request: {
    headers: WorkflowTrackingHeadersSchema,
    body: {
      content: { "application/json": { schema: CreatePlatformRunRequestSchema } },
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
      description: "idempotencyKey collides with a run of different (serviceName, taskName), or `parent_org_mismatch`: x-org-id names another org than the parent run's",
      content: { "application/json": { schema: ValidationErrorSchema } },
    },
    422: {
      description: "`parent_run_not_found`: body.parentRunId names no existing run (never created as a root instead)",
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

// --- Charged runs / orgs / units of one service's tasks, fleet-wide (migration 0049) ---

export const TaskUnitsQuerySchema = z
  .object({
    serviceName: z.string().openapi({ description: "REQUIRED. The service whose runs are counted (the run's own service_name), e.g. 'chat-service'." }),
    taskNames: z.string().optional().openapi({ description: "Comma-separated task names of those runs (max 100), e.g. 'judgments,platform-judgments'. Absent = every task of the service." }),
    costNames: z.string().optional().openapi({ description: "Comma-separated cost names counted (max 100), e.g. 'apollo-credit'. Absent (and no costNamePrefix) = every cost name." }),
    costNamePrefix: z.string().optional().openapi({ description: "Only cost names starting with this prefix, e.g. 'typesafe-jev-' (every Jev version). Not with costNames." }),
    costSource: z.enum(["platform", "org"]).optional().openapi({ description: "'platform' = paid through our vendor account (billed to the customer), 'org' = the customer's own key. Absent = both." }),
    since: z.string().optional().openapi({ description: "YYYY-MM-DD: only runs STARTED on or after this UTC day. Absent = since inception." }),
    groupBy: z.string().optional().openapi({ description: "Comma-separated subset of month, taskName, parentServiceName, costName, costSource. month = UTC month (YYYY-MM) of the run's start. parentServiceName = the service of the PARENT run, i.e. the service that asked for the run (null for a root run). Absent = only the total." }),
  })
  .openapi("TaskUnitsQuery");

const TaskUnitsFiguresSchema = {
  runCount: z.number().int().openapi({ description: "Runs that were CHARGED: runs holding at least one 'actual' cost row matching the filters. Exact per cost name; summed over several cost names, a run charged under two of them counts once per name." }),
  orgCount: z.number().int().openapi({ description: "DISTINCT orgs (the run's org) among those runs. Org-less platform runs are not counted. Not additive: the total's orgCount is distinct over the whole scope, never the sum of the groups'." }),
  costRowCount: z.number().int().openapi({ description: "'actual' cost rows counted." }),
  quantity: z.string().openapi({ description: "SUM(quantity) of those rows, in the cost name's unit (input tokens for a 'typesafe-jev-*-tokens-input' name, credits for 'apollo-credit'). Decimal string, scale 6." }),
  billedCostInUsdCents: z.string().openapi({ description: "Gross billed: SUM(total_cost_in_usd_cents) of those rows, as charged before the per-org usage discount. Decimal string, scale 10." }),
  netBilledCostInUsdCents: z.string().openapi({ description: "Billed net of the per-org usage discount frozen on each row (gross when the row predates the freeze). Decimal string, scale 10." }),
};

export const TaskUnitsResponseSchema = z
  .object({
    serviceName: z.string(),
    since: z.string().nullable(),
    statuses: z.array(z.string()).openapi({ description: "Cost row statuses counted: ['actual'] (charged). Holds, cancels and refunds are in no figure." }),
    groupBy: z.array(z.enum(["month", "taskName", "parentServiceName", "costName", "costSource"])).openapi({ description: "Grouping keys applied, canonical order; [] when none." }),
    groups: z
      .array(
        z.object({
          month: z.string().optional().openapi({ description: "With groupBy month: YYYY-MM, UTC month of the run's start." }),
          taskName: z.string().optional(),
          parentServiceName: z.string().nullable().optional().openapi({ description: "With groupBy parentServiceName: the asking service; null for a root run." }),
          costName: z.string().optional(),
          costSource: z.enum(["platform", "org"]).optional(),
          ...TaskUnitsFiguresSchema,
        }),
      )
      .openapi({ description: "SPARSE: one entry per group with at least one charged row, ordered by the groupBy keys (null last). [] without groupBy." }),
    total: z.object(TaskUnitsFiguresSchema).openapi({ description: "The whole scope. runCount / costRowCount / quantity / money equal the sums of the groups; orgCount is distinct over the scope." }),
  })
  .openapi("TaskUnitsResponse");

registry.registerPath({
  method: "get",
  path: "/internal/stats/costs/task-units",
  summary: "Charged runs, distinct orgs, units and cents of one service's tasks, fleet-wide since inception, by month / task / asking service / cost name (service-auth only)",
  description:
    "Fleet-wide (every org and org-less platform runs): for the runs of `serviceName` (optionally only `taskNames`), what they were CHARGED — 'actual' cost rows only — under the matching cost names: number of runs charged, distinct orgs, cost rows, summed quantity (tokens, credits…) and billed cents gross + net. Groupable by UTC month of the run's start, task, asking service (the parent run's service), cost name and cost source. Examples: typed judgments = serviceName=chat-service&taskNames=judgments,platform-judgments&costNamePrefix=typesafe-jev-&groupBy=month,taskName,parentServiceName; one Apollo reveal as billed = serviceName=apollo-service&taskNames=enrichment&costNames=apollo-credit&costSource=platform&since=2026-09-28 (billedCostInUsdCents / quantity = cents per credit). Served from a write-maintained rollup (migration 0049), O(groups). 503 until that rollup is built on the database. Service-auth only, no identity headers; no org, brand or person is named on the wire.",
  security: [{ apiKey: [] }],
  request: { query: TaskUnitsQuerySchema },
  responses: {
    200: { description: "Charged runs, orgs, units and cents", content: { "application/json": { schema: TaskUnitsResponseSchema } } },
    400: { description: "Missing serviceName, or invalid taskNames, costNames, costNamePrefix, costSource, since or groupBy", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    503: { description: "The rollup is not built on this database yet", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- Outcome occurrences: the production-cost ledger (COST-ACCOUNTING-1023) ---
//
// A run is a PRODUCTION ORDER. It may state the outcome occurrences it PRODUCED
// and CONSUMED; runs-service then serves what each produced occurrence cost to
// make, proves the ledger to the cent per org per day, and stores the coverage
// series. See CLAUDE.md "Outcome occurrences — the production-cost ledger".

export const OUTCOME_KEY_RE = /^[a-z][a-z0-9_]{1,63}$/;
export const SUBJECT_SERVICE_RE = /^[a-z][a-z0-9-]{1,63}$/;
const DECIMAL_STRING_RE = /^\d+(\.\d{1,6})?$/;
const UUID_STRING_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OutcomeOccurrenceInputSchema = z
  .object({
    outcomeKey: z.string().regex(OUTCOME_KEY_RE).openapi({
      description:
        "Outcome (step) key from the features-service catalogue (`GET /public/catalogue/steps`): lead_identified, email_found, phone_found, email_checked, lead_found, company_researched, message_written, message_sent, audience_built, creative_made, post_published, ad_shown, conversation (= Positive reply), meeting_booked… Checked against that catalogue on every call: an unknown key is a 400 `unknown_outcome_key`, an unreadable catalogue a 502. Legacy `email_sent` is accepted and stored as `message_sent`.",
      example: "email_checked",
    }),
    subjectService: z.string().regex(SUBJECT_SERVICE_RE).openapi({
      description: "The service whose database holds the subject (a person: lead-service; an object: the channel's service).",
      example: "lead-service",
    }),
    subjectId: z.string().min(1).max(256).openapi({ description: "The subject's id in that service (a lead id, a post id, an audience id…).", example: "8c1f0b7e-2f43-4c3e-9a51-6f7b1f2d9e10" }),
    quantity: z
      .union([z.number().positive().max(1e12), z.string().regex(DECIMAL_STRING_RE)])
      .optional()
      .openapi({
        description:
          "PRODUCED only: this occurrence's weight in its run's cost split (default 1 = equal shares). State it only when one output really costs more than another (e.g. tokens written per message). Up to 6 decimals.",
        example: 1,
      }),
  })
  .openapi("OutcomeOccurrenceInput");

export const OccurredAtSchema = z
  .union([z.literal("run_started_at"), z.string().datetime({ offset: true })])
  .openapi({ description: "BACKFILL (declaring the outcomes of a PAST run): the occurrences' effective declaration time. Absent = now (on time, unchanged). `run_started_at` = the run's own start (the usual backfill value), or an ISO instant between the run's start and now (e.g. the producer's own row timestamp); out of bounds = 400. Every rule keys on this effective time, never on when the call arrives: consumption resolution (a backfilled `lead_found` of August is the input of an August `message_sent` consumption: declare BOTH sides with their past time, the producer first or in the same call), which consumption of an occurrence is the first (paid) one and which are reuses, and the UTC day an occurrence is counted on in the stored series. The cost an occurrence carries always lands on the UTC days of its run's cost rows. Every stored day the declaration moves (ledger check, coverage, outcome cost totals) is recomputed by the refresher (every 15 min, a 10-min budget per tick, recent days first, then days never computed, then moved ones; `daysMissing` / `complete` say when a range is not stored yet); a recompute with the same declarations gives the same figures (allocation v1 unchanged). Days are stored back to the first day of spend (2026-02-02 in prod). Idempotent like any declaration: re-running a backfill returns `already_recorded` and writes nothing (an occurrence already recorded keeps its stored time). For volume: POST /v1/platform-runs/outcomes/batch (up to 500 runs, 1000 occurrences per call).", example: "run_started_at" });

const declareRunOutcomesShape = {
  produced: z.array(OutcomeOccurrenceInputSchema).optional().openapi({
    description:
      "The outcome occurrences this run MADE: the run's whole cost (its own cost rows + those of descendants that declare nothing) is split over them. Declare only what was KEPT (a rejected email is not an output: the kept ones carry its cost) and only the run's DECLARED output (a by-product it also caused is not declared: $0).",
  }),
  consumed: z.array(OutcomeOccurrenceInputSchema.omit({ quantity: true })).optional().openapi({
    description: "The outcome occurrences this run USED as inputs (e.g. the `email_checked` a `message_sent` run sent to). STANDARD COST ON REUSE: each consumption is charged the producing occurrence's production cost; the first consumption of an occurrence is the one its spend paid for, every later one (a lead found for org 1 reused by org 2) is a reuse charged the same price with no new spend (the reuse gain). Resolution: the latest produced occurrence of the same (outcomeKey, subjectService, subjectId) declared at or before the consumption, else the earliest declared later, among those declared before the end of the consumption's UTC day; none = unknown provenance (never $0). Declare the producer first.",
  }),
  occurredAt: OccurredAtSchema.optional(),
};

const occurrenceCount = (b: { produced?: unknown[]; consumed?: unknown[] }) => (b.produced?.length ?? 0) + (b.consumed?.length ?? 0);

export const DeclareRunOutcomesRequestSchema = z
  .object(declareRunOutcomesShape)
  .refine((b) => occurrenceCount(b) >= 1, { message: "state at least one produced or consumed occurrence" })
  .refine((b) => occurrenceCount(b) <= 1000, { message: "at most 1000 occurrences per call" })
  .openapi("DeclareRunOutcomesRequest");

export const OUTCOMES_BATCH_MAX_RUNS = 500;

export const DeclareOutcomesBatchRequestSchema = z
  .object({
    runs: z
      .array(
        z.object({
          runId: z.string().regex(UUID_STRING_RE).openapi({ description: "The run (production order) these occurrences are declared on; each run at most once per call." }),
          ...declareRunOutcomesShape,
          redate: z.boolean().optional().openapi({
            description:
              "RE-DATE (requires occurredAt; x-service-name must be the run's own service, else 422 not_run_owner): an occurrence of this run ALREADY recorded with a LATER effective time (declared through today's door before occurredAt existed) moves EARLIER to occurredAt (status `redated`). Never later: an occurrence already at or before occurredAt stays `already_recorded`. Occurrences not yet recorded are recorded at occurredAt as usual. Same quantity rule (another quantity = 409). One bronze `outcomes.redated` event per run keeps the previous time; the refresher recomputes every stored day the move touches. Idempotent: a replay finds nothing to move.",
          }),
        }),
      )
      .min(1)
      .max(OUTCOMES_BATCH_MAX_RUNS),
  })
  .refine((b) => b.runs.every((r) => occurrenceCount(r) >= 1), { message: "each run states at least one produced or consumed occurrence" })
  .refine((b) => b.runs.reduce((n, r) => n + occurrenceCount(r), 0) <= 1000, { message: "at most 1000 occurrences per call" })
  .refine((b) => new Set(b.runs.map((r) => r.runId.toLowerCase())).size === b.runs.length, { message: "a run stated twice in the batch" })
  .refine((b) => b.runs.every((r) => !r.redate || r.occurredAt !== undefined), { message: "redate needs occurredAt" })
  .openapi("DeclareOutcomesBatchRequest");

export const OutcomeDirectionEnum = z.enum(["produced", "consumed"]).openapi("OutcomeDirection");

export const DeclaredOutcomeOccurrenceSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Occurrence id (stable: a replay returns the same id)." }),
    direction: OutcomeDirectionEnum,
    outcomeKey: z.string().openapi({ description: "Stored key (legacy keys normalized)." }),
    subjectService: z.string(),
    subjectId: z.string(),
    quantity: z.string().openapi({ description: "6-decimal string." }),
    declaredAt: z.string().datetime().openapi({ description: "Effective declaration time: what every rule keys on (= recordedAt on time; the stated past instant for a backfill)." }),
    recordedAt: z.string().datetime().openapi({ description: "When runs-service recorded it." }),
    status: z.enum(["recorded", "redated", "already_recorded"]).openapi({ description: "recorded = written by this call; redated = already recorded with a later effective time, moved earlier to occurredAt (batch `redate` only); already_recorded = the same (run, direction, outcome, subject) was stated before (nothing written)." }),
  })
  .openapi("DeclaredOutcomeOccurrence");

export const DeclareRunOutcomesResponseSchema = z
  .object({
    runId: z.string().uuid(),
    allocationVersion: z.number().int(),
    recordedCount: z.number().int(),
    alreadyRecordedCount: z.number().int(),
    occurrences: z.array(DeclaredOutcomeOccurrenceSchema),
  })
  .openapi("DeclareRunOutcomesResponse");

export const OutcomeConflictResponseSchema = z
  .object({
    error: z.string(),
    conflicts: z.array(
      z.object({
        runId: z.string().uuid(),
        direction: OutcomeDirectionEnum,
        outcomeKey: z.string(),
        subjectService: z.string(),
        subjectId: z.string(),
        storedQuantity: z.string(),
        statedQuantity: z.string(),
      }),
    ),
  })
  .openapi("OutcomeConflictResponse");

export const ProductionCostSchema = z
  .object({
    grossCents: z.string().openapi({ description: "Billed gross share, USD cents, 10-decimal string." }),
    netCents: z.string().openapi({ description: "Frozen net (usage discount at cost-write time) share, USD cents." }),
    vendorCents: z.string().openapi({ description: "Vendor actual share (what the vendor charged us, costs-service catalogue), USD cents. Excludes unpricedGrossCents." }),
    unpricedGrossCents: z.string().openapi({ description: "Billed gross share of cost rows the vendor catalogue cannot price (not in vendorCents). 0 = the vendor figure is complete." }),
  })
  .openapi("ProductionCost");

const declarationDescription =
  "Declares the outcome occurrences this run PRODUCED and CONSUMED (a run is a production order). Optional: a run that states nothing behaves exactly as before; its spend reads 'produced none'. Call it once the outputs are known (at the end of the run, or in several calls: occurrences accumulate). Idempotent per (run, direction, outcomeKey, subjectService, subjectId): a replay is `already_recorded` (200); the same occurrence with ANOTHER quantity is 409; a key twice in one body is 400; a run whose declaration was taken back (`POST …/outcomes/void`) is 409 `run_outcomes_voided`. Immutable item by item; the owning service can take the whole declaration back. Cost rule v1: the run's cost (own rows + descendants that declare nothing, actual + refunded, whoever pays) is split over its produced occurrences in proportion to quantity (default equal shares), exact to 10 decimals, same split on billed gross, net and vendor actual. Max 1000 occurrences per call. BACKFILL: a past run's outcomes are declared with `occurredAt` (`run_started_at` or an ISO instant between the run's start and now) and then behave, for consumption resolution, reuse ranking and every stored day series, as if declared at that time (see the field). Example body: {\"produced\":[{\"outcomeKey\":\"email_checked\",\"subjectService\":\"lead-service\",\"subjectId\":\"<lead id>\"}],\"consumed\":[{\"outcomeKey\":\"email_found\",\"subjectService\":\"lead-service\",\"subjectId\":\"<lead id>\"}]}.";

for (const [path, auth] of [
  ["/v1/runs/{id}/outcomes", "x-org-id required (must be the run's org)"],
  ["/v1/platform-runs/{id}/outcomes", "x-service-name required; x-org-id optional (when given, must be the run's org)"],
] as const) {
  registry.registerPath({
    method: "post",
    path,
    summary: "Declare the outcome occurrences a run produced and consumed",
    description: `${declarationDescription} Auth: ${auth}.`,
    security: [{ apiKey: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: { content: { "application/json": { schema: DeclareRunOutcomesRequestSchema } } },
    },
    responses: {
      201: { description: "At least one occurrence recorded", content: { "application/json": { schema: DeclareRunOutcomesResponseSchema } } },
      200: { description: "Every occurrence was already recorded (replay)", content: { "application/json": { schema: DeclareRunOutcomesResponseSchema } } },
      400: { description: "Invalid body (key format, empty, > 1000, duplicate in body), run id, `occurredAt` out of bounds (`invalid_occurred_at`: before the run started, or in the future), or `unknown_outcome_key` (details.unknownKeys: keys features-service's step catalogue does not hold)", content: { "application/json": { schema: ValidationErrorSchema } } },
      401: { description: "Unauthorized" },
      404: { description: "Run not found", content: { "application/json": { schema: ErrorSchema } } },
      409: { description: "run_org_mismatch, run_outcomes_voided (declaration taken back: declare on a new run), or an occurrence already recorded with another quantity", content: { "application/json": { schema: OutcomeConflictResponseSchema } } },
      502: { description: "outcome_catalogue_unavailable: features-service's step catalogue could not be read (nothing written, retry)", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
}

// --- Taking a declaration back (RUNS-VOID-1023) ---

export const VoidRunOutcomesRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000).openapi({ description: "Why the declaration was wrong (kept in the audit log).", example: "one run declared several produced outcome keys; re-declared one key per run" }),
    voidedBy: z.string().trim().min(1).max(256).openapi({ description: "Who decided it (a person, a ticket, a release).", example: "lead-service COST-ACCOUNTING-1023-LEAD-FIX" }),
  })
  .openapi("VoidRunOutcomesRequest");

export const VoidRunOutcomesResponseSchema = z
  .object({
    runId: z.string().uuid(),
    allocationVersion: z.number().int(),
    status: z.enum(["voided", "already_voided"]),
    voidedCount: z.number().int().openapi({ description: "Occurrences taken back by this call (0 on a replay)." }),
    voidedAt: z.string().datetime(),
  })
  .openapi("VoidRunOutcomesResponse");

const voidDescription =
  "Takes back EVERY outcome occurrence this run declared (produced and consumed), when the declaration was made in error. Only the service that owns the run may (x-service-name must equal the run's serviceName, else 403 `not_run_owner`). From then on they count in no figure (cost per occurrence, outcome-cost totals, ledger check, coverage): the run's spend reads 'produced none', and stored days are recomputed by the next ledger refresh. The run then accepts no new declaration (409 `run_outcomes_voided`): re-declare the right facts on a NEW run. Audit: reason, voidedBy and the removed rows stay in the bronze log. Idempotent: a second call is 200 `already_voided`, nothing written.";

for (const [path, auth] of [
  ["/v1/runs/{id}/outcomes/void", "x-org-id required (must be the run's org) + x-service-name required"],
  ["/v1/platform-runs/{id}/outcomes/void", "x-service-name required; x-org-id optional (when given, must be the run's org)"],
] as const) {
  registry.registerPath({
    method: "post",
    path,
    summary: "Take back the outcome occurrences a run declared in error",
    description: `${voidDescription} Auth: ${auth}.`,
    security: [{ apiKey: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: { content: { "application/json": { schema: VoidRunOutcomesRequestSchema } } },
    },
    responses: {
      201: { description: "Declaration taken back", content: { "application/json": { schema: VoidRunOutcomesResponseSchema } } },
      200: { description: "Already taken back (replay, nothing written)", content: { "application/json": { schema: VoidRunOutcomesResponseSchema } } },
      400: { description: "Invalid body or run id, or missing x-service-name", content: { "application/json": { schema: ValidationErrorSchema } } },
      401: { description: "Unauthorized" },
      403: { description: "not_run_owner: the run belongs to another service", content: { "application/json": { schema: ErrorSchema } } },
      404: { description: "Run not found", content: { "application/json": { schema: ErrorSchema } } },
      409: { description: "run_org_mismatch", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
}

export const DeclareOutcomesBatchResponseSchema = z
  .object({
    allocationVersion: z.number().int(),
    recordedCount: z.number().int(),
    alreadyRecordedCount: z.number().int(),
    redatedCount: z.number().int(),
    runs: z.array(DeclareRunOutcomesResponseSchema.omit({ allocationVersion: true }).extend({ redatedCount: z.number().int() })),
  })
  .openapi("DeclareOutcomesBatchResponse");

export const OutcomesBatchInvalidResponseSchema = z
  .object({
    error: z.literal("invalid_runs"),
    details: z.object({
      invalid: z.array(
        z.object({
          runId: z.string(),
          reason: z.enum(["run_not_found", "run_org_mismatch", "run_outcomes_voided", "invalid_occurred_at", "not_run_owner"]),
          message: z.string().optional(),
        }),
      ),
    }),
  })
  .openapi("OutcomesBatchInvalidResponse");

registry.registerPath({
  method: "post",
  path: "/v1/platform-runs/outcomes/batch",
  summary: "Declare the outcome occurrences of many runs in one call (the backfill door)",
  description:
    "Same contract as POST /v1/platform-runs/{id}/outcomes, for up to 500 runs and 1000 occurrences per call, each run with its own `produced`, `consumed` and `occurredAt`. Made for BACKFILL: a producer re-reads its own history (each past run and the rows it produced) and declares those outcomes on the past runs that paid for them with `occurredAt: \"run_started_at\"` (or its row's own instant, between the run's start and now); they then count as declared at that time for consumption resolution, reuse ranking and every stored day series, and the refresher recomputes each stored day they move. All or nothing: any invalid run (unknown, voided, org mismatch with a stated x-org-id, occurredAt out of bounds) = 422 with the per-run list and NOTHING is written. Idempotent: re-running the same batch returns 200 with every occurrence `already_recorded` and writes nothing, so a backfill can be resumed or replayed safely. An occurrence declared earlier through today's door (stamped with that day) is moved back to its real time with `redate: true` on its run (owner service only, earlier only). Auth: x-service-name required (recorded as the declaring service); x-org-id optional (when given, every run must be in that org).",
  security: [{ apiKey: [] }],
  request: { body: { content: { "application/json": { schema: DeclareOutcomesBatchRequestSchema } } } },
  responses: {
    201: { description: "At least one occurrence recorded or re-dated", content: { "application/json": { schema: DeclareOutcomesBatchResponseSchema } } },
    200: { description: "Every occurrence was already recorded (replay)", content: { "application/json": { schema: DeclareOutcomesBatchResponseSchema } } },
    400: { description: "Invalid body (shape, > 500 runs, > 1000 occurrences, a run or an occurrence stated twice, redate without occurredAt) or `unknown_outcome_key`", content: { "application/json": { schema: ValidationErrorSchema } } },
    401: { description: "Unauthorized" },
    409: { description: "An occurrence already recorded with another quantity (conflicts[].runId), or a run voided while the call ran (run_outcomes_voided). Nothing written.", content: { "application/json": { schema: OutcomeConflictResponseSchema } } },
    422: { description: "invalid_runs: per-run reasons; nothing written", content: { "application/json": { schema: OutcomesBatchInvalidResponseSchema } } },
    502: { description: "outcome_catalogue_unavailable (nothing written, retry)", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export const MarkRunsSupportRequestSchema = z
  .object({
    runIds: z.array(z.string().regex(UUID_STRING_RE)).min(1).max(5000).openapi({ description: "Runs to mark (<= 5000 per call). Marking a run covers its whole subtree: its descendants' cost stops at it too." }),
    kind: z.enum(["staff_experiment", "support"]).openapi({ description: "staff_experiment = a staff probe / test; support = any other support function (cost-accounting: reported apart, never an outcome)." }),
    reason: z.string().min(1).max(2000),
    markedBy: z.string().min(1).max(200).openapi({ description: "Who decided (session, person, ticket)." }),
  })
  .openapi("MarkRunsSupportRequest");

registry.registerPath({
  method: "post",
  path: "/internal/runs/support-marks",
  summary: "Mark runs as SUPPORT (staff experiment / probe): their cost never rides an outcome (staff, service-auth)",
  description:
    "Production-cost ledger (allocation v1): a child run that declares nothing rides its nearest ancestor that declared a produced occurrence. A run marked here STOPS that walk: its own cost and its whole subtree's stay 'produced none' (reported apart), never on an ancestor's outcomes, whatever its parent link says (first case 2026-10-23: 3,052 apollo/chat probe runs parented to postmark newsletter sends through a reused x-run-id). A marked run produces no outcome (a produced declaration on it = 409 run_marked_support); a run that already declared a produced occurrence cannot be marked (void it first). One bronze run.support_marked event per run (kind, reason, markedBy); final, idempotent (an already marked run writes nothing). The refresher recomputes every stored day from the run's start; the ledger check stays balanced (the spend moves from an outcome to produced none). Spend, billing and the run tree are untouched. All or nothing: any invalid run = 422 with the list, nothing written.",
  security: [{ apiKey: [] }],
  request: { body: { content: { "application/json": { schema: MarkRunsSupportRequestSchema } } } },
  responses: {
    200: {
      description: "Marked",
      content: { "application/json": { schema: z.object({ markedCount: z.number().int(), alreadyMarkedCount: z.number().int() }) } },
    },
    400: { description: "Invalid body", content: { "application/json": { schema: ValidationErrorSchema } } },
    401: { description: "Unauthorized" },
    422: {
      description: "invalid_runs: run_not_found, or run_declares_outcomes (void its declaration first); nothing written",
      content: { "application/json": { schema: z.object({ error: z.literal("invalid_runs"), details: z.object({ invalid: z.array(z.object({ runId: z.string(), reason: z.enum(["run_not_found", "run_declares_outcomes"]) })) }) }) } },
    },
  },
});

export const ListOutcomeOccurrencesQuerySchema = z.object({
  runIds: z.string().optional().openapi({ description: "Comma-separated run ids (<= 500)." }),
  subjectService: z.string().optional(),
  subjectIds: z.string().optional().openapi({ description: "Comma-separated subject ids (<= 500); requires subjectService." }),
  outcomeKey: z.string().optional(),
  orgId: z.string().uuid().optional().openapi({ description: "The declaring run's org." }),
  direction: OutcomeDirectionEnum.optional(),
  declaredAfter: z.string().datetime({ offset: true }).optional().openapi({ description: "Inclusive." }),
  declaredBefore: z.string().datetime({ offset: true }).optional().openapi({ description: "Exclusive." }),
  cursor: z.string().uuid().optional().openapi({ description: "nextCursor of the previous page." }),
  limit: z.string().optional().openapi({ description: "1..1000, default 500." }),
});

export const OutcomeOccurrenceWithCostSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid().openapi({ description: "The run that declared it (the production order)." }),
    organizationId: z.string().uuid().nullable(),
    serviceName: z.string(),
    taskName: z.string(),
    direction: OutcomeDirectionEnum,
    outcomeKey: z.string(),
    subjectService: z.string(),
    subjectId: z.string(),
    quantity: z.string(),
    declaredAt: z.string().datetime().openapi({ description: "Effective declaration time (a backfill states it in the past): what every rule keys on." }),
    recordedAt: z.string().datetime().openapi({ description: "When runs-service recorded it (= declaredAt for an on-time declaration)." }),
    tags: z
      .object({
        brandIds: z.array(z.string()),
        campaignId: z.string().nullable(),
        workflowSlug: z.string().nullable(),
        featureSlug: z.string().nullable(),
        audienceId: z.string().nullable(),
      })
      .openapi({ description: "The declaring run's tags (for a produced occurrence: the production tags). Offer = the campaign's (campaign-service). Any customer scope is an exact sum of occurrences over these tags." }),
    cost: ProductionCostSchema.nullable().openapi({ description: "PRODUCED: what this occurrence cost to make (its standard cost), under allocation v1, as of now (a cost row written later on its run moves it). CONSUMED: null (see consumption)." }),
    costSlices: z
      .array(
        z.object({
          day: z.string().openapi({ description: "UTC day of the cost rows, YYYY-MM-DD." }),
          costOrganizationId: z.string().uuid().nullable().openapi({ description: "Org of the cost rows (the ledger check's org; null = platform-billed spend made for this run)." }),
          cost: ProductionCostSchema,
        }),
      )
      .nullable()
      .openapi({ description: "PRODUCED: `cost` per (UTC day, cost org) of the spend it carries; sums exactly to cost. Empty when its run spent nothing. CONSUMED: null." }),
    consumption: z
      .object({
        sourceOccurrenceId: z.string().uuid().nullable().openapi({ description: "The produced occurrence this consumption resolved to. Null = unknown provenance." }),
        sourceRunId: z.string().uuid().nullable(),
        reuse: z.boolean().openapi({ description: "true = an earlier consumption already used that occurrence: charged at standard cost with no new spend (reuse gain)." }),
        provenance: z.enum(["known", "unknown"]),
        standardCost: ProductionCostSchema.nullable().openapi({ description: "The standard cost charged to this consumption = the source occurrence's production cost. Null when provenance is unknown." }),
        consumingOutcomes: z
          .array(
            z.object({
              outcomeKey: z.string().nullable().openapi({ description: "An outcome the consuming production order makes (the produced key of its run, or of the nearest ancestor declaring one). Null = it produced nothing." }),
              weight: z.string().openapi({ description: "This consumption's share of that outcome, 10 decimals: 1 for a single-outcome order, quantity-weighted (cumulative rounding) otherwise; weights sum to exactly 1." }),
              standardCost: ProductionCostSchema.nullable().openapi({ description: "standardCost x weight (cumulative rounding: sums exactly to standardCost). Null when provenance is unknown." }),
            }),
          )
          .openapi({ description: "What the consumption was an input OF: the rows /internal/stats/outcome-costs sums per (consumingOutcomeKey, consumedOutcomeKey)." }),
      })
      .nullable()
      .openapi({ description: "CONSUMED only (null for produced)." }),
  })
  .openapi("OutcomeOccurrenceWithCost");

export const ListOutcomeOccurrencesResponseSchema = z
  .object({
    allocationVersion: z.number().int(),
    allocationRule: z.string(),
    occurrences: z.array(OutcomeOccurrenceWithCostSchema),
    nextCursor: z.string().uuid().nullable(),
  })
  .openapi("ListOutcomeOccurrencesResponse");

registry.registerPath({
  method: "get",
  path: "/internal/outcome-occurrences",
  summary: "Outcome occurrences with what each produced one cost to make (service-auth)",
  description:
    "The production cost of each outcome occurrence: ordered by id, paged by cursor. At least one of runIds, subjectIds (+subjectService), outcomeKey, orgId is required. Each produced occurrence carries its v1 share of its run's cost (the run's own actual + refunded rows and those of descendants that declare nothing, split per (UTC day, org) group in proportion to quantity, cumulative rounding at 10 decimals: a run's occurrences sum exactly to its cost). The same groups feed /internal/outcome-costs/ledger-check, so Σ occurrences of a day = that day's allocated. Each consumed occurrence carries `consumption`: the produced occurrence it resolved to, whether it is a reuse, and the standard cost charged (that occurrence's production cost: a past figure never moves when a new reuse happens). Every row carries the declaring run's tags (org, brands, campaign, workflow, feature, audience), so a customer scope is an exact sum. Production cost only: what the client PAID is billing-service's. Fail loud: vendor catalogue unreadable = 502.",
  security: [{ apiKey: [] }],
  request: { query: ListOutcomeOccurrencesQuerySchema },
  responses: {
    200: { description: "Occurrences", content: { "application/json": { schema: ListOutcomeOccurrencesResponseSchema } } },
    400: { description: "No filter, or invalid filter", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "costs-service vendor catalogue unavailable", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const LedgerMoneySchema = z.object({
  grossCents: z.string(),
  netCents: z.string(),
  vendorCents: z.string(),
  unpricedGrossCents: z.string(),
});

export const LedgerCheckRowSchema = z
  .object({
    day: z.string().openapi({ description: "UTC day of the cost rows, YYYY-MM-DD." }),
    organizationId: z.string().uuid().nullable().openapi({ description: "The cost rows' org (null = org-less platform runs)." }),
    ledger: LedgerMoneySchema.openapi({ description: "Every actual + refunded cost row of the day, summed straight from the ledger." }),
    allocated: LedgerMoneySchema.openapi({ description: "Σ of the per-occurrence shares (the cost spread on produced occurrences)." }),
    producedNone: LedgerMoneySchema.openapi({ description: "Spend of runs with no declaring run at or above them." }),
    standard: LedgerMoneySchema.openapi({ description: "Σ standard cost charged on occurrences: allocated + the standard charges of the day's reuses (consuming org, consumption's UTC day)." }),
    reuseGain: LedgerMoneySchema.openapi({ description: "Standard charges with no spend behind them (consumptions after the first of an occurrence). standard - actual spread." }),
    differences: LedgerMoneySchema.openapi({ description: "standard - reuseGain + producedNone - ledger per basis. Zero when balanced." }),
    balanced: z.boolean(),
    costRows: z.number().int(),
    occurrences: z.number().int().openapi({ description: "Produced occurrences receiving a share of the day's spend." }),
    reuseCount: z.number().int().openapi({ description: "Reuse consumptions declared that day by this org." }),
    unknownProvenanceCount: z.number().int().openapi({ description: "Consumptions declared that day by this org whose occurrence no run declared producing." }),
  })
  .openapi("LedgerCheckRow");

export const LedgerCheckResponseSchema = z
  .object({
    allocationVersion: z.number().int(),
    allocationRule: z.string(),
    since: z.string(),
    until: z.string(),
    balanced: z.boolean().openapi({ description: "Every stored (day, org) row balances EXACTLY on gross, net, vendor and unpriced gross (no tolerance)." }),
    complete: z.boolean().openapi({ description: "Every day of the range is computed (daysMissing empty)." }),
    daysMissing: z.array(z.string()),
    totals: z.object({ ledger: LedgerMoneySchema, standard: LedgerMoneySchema, reuseGain: LedgerMoneySchema, allocated: LedgerMoneySchema, producedNone: LedgerMoneySchema }),
    mismatches: z.array(LedgerCheckRowSchema),
    rows: z.array(LedgerCheckRowSchema).openapi({ description: "Every (day, org) row, day ascending. Omitted when rows=false." }),
  })
  .openapi("LedgerCheckResponse");

registry.registerPath({
  method: "get",
  path: "/internal/outcome-costs/ledger-check",
  summary: "To-the-cent check: standard cost on occurrences - reuse gain + spend that produced none = the ledger, per org per day (service-auth)",
  description:
    "Reads the stored daily computation (refreshed in-process every 15 min: the last 3 days always, every missing day of the last 60, and any day a late declaration moved) and checks, in exact decimals, standard - reuseGain + producedNone == ledger per (UTC day, org) on billed gross, frozen net, vendor actual and unpriced gross. standard = the spend spread on the produced occurrences (allocated) + the standard charges of reuses; reuseGain = those reuse charges, served as its own line. Default range: the 60 days ending yesterday. `rows=false` returns only totals + mismatches.",
  security: [{ apiKey: [] }],
  request: {
    query: z.object({
      since: z.string().optional().openapi({ description: "YYYY-MM-DD (default: until - 59 days)." }),
      until: z.string().optional().openapi({ description: "YYYY-MM-DD inclusive (default: yesterday UTC)." }),
      rows: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: { description: "Check", content: { "application/json": { schema: LedgerCheckResponseSchema } } },
    400: { description: "Invalid range (bad date, since > until, > 400 days)", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

const CoveragePointSchema = z.object({
  day: z.string(),
  complete: z.boolean().openapi({ description: "false for today (UTC): the day is still running." }),
  spendGrossCents: z.string(),
  coveredGrossCents: z.string().openapi({ description: "Spend whose run (or an ancestor) states its produced outputs." }),
  spendNetCents: z.string(),
  coveredNetCents: z.string(),
  coveragePct: z.string().nullable().openapi({ description: "coveredGross / spendGross x 100, 2 decimals. Null when the day spent nothing." }),
});

export const OutcomeCoverageResponseSchema = z
  .object({
    allocationVersion: z.number().int(),
    since: z.string(),
    until: z.string(),
    daysMissing: z.array(z.string()),
    fleet: z.array(CoveragePointSchema).openapi({ description: "One point per computed day." }),
    services: z.array(CoveragePointSchema.extend({ serviceName: z.string() })),
    tasks: z.array(CoveragePointSchema.extend({ serviceName: z.string(), taskName: z.string() })),
  })
  .openapi("OutcomeCoverageResponse");

registry.registerPath({
  method: "get",
  path: "/internal/stats/outcome-coverage",
  summary: "Stored daily series: share of spend whose run states its outputs, fleet / per service / per task (service-auth)",
  description:
    "The monitor of the production-cost ledger: per UTC day of the cost rows (actual + refunded), the spend and the part of it spread on a declared produced occurrence. Bad = low: every spending service is expected to declare its outputs. Stored by the same refresh as the ledger check. Filters: serviceName, taskName. Default range: the 60 days ending today.",
  security: [{ apiKey: [] }],
  request: {
    query: z.object({
      since: z.string().optional(),
      until: z.string().optional(),
      serviceName: z.string().optional(),
      taskName: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Coverage series", content: { "application/json": { schema: OutcomeCoverageResponseSchema } } },
    400: { description: "Invalid range", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

const OutcomeCostDimensionsSchema = z.record(z.string(), z.string().nullable()).openapi({
  description: "The group's value of each requested dimension (null = none: an org-less run, a run with no campaign...).",
});

export const OutcomeCostTotalsResponseSchema = z
  .object({
    allocationVersion: z.number().int(),
    allocationRule: z.string(),
    since: z.string(),
    until: z.string(),
    groupBy: z.array(z.string()),
    maxGroups: z.number().int().openapi({ description: "Per-section cap. Above it the read is a 422 `too_many_groups`, never a truncated list." }),
    complete: z.boolean().openapi({ description: "Every day of the range holds stored totals (daysMissing empty)." }),
    daysMissing: z.array(z.string()),
    produced: z.array(
      z.object({
        dimensions: OutcomeCostDimensionsSchema,
        occurrences: z.number().int().openapi({ description: "Produced occurrences DECLARED in the range (day = their declaration's UTC day), under the declaring run's tags." }),
        quantity: z.string().openapi({ description: "Σ quantity of those occurrences (6 decimals)." }),
        cost: ProductionCostSchema.openapi({ description: "Σ own production cost (allocation v1 shares) of the spend in the range (day = the cost row's UTC day), under the declaring run's tags. = Σ costSlices of /internal/outcome-occurrences." }),
      }),
    ),
    consumed: z.array(
      z.object({
        dimensions: OutcomeCostDimensionsSchema.openapi({ description: "Always consumingOutcomeKey + consumedOutcomeKey (the requested outcomeKey dimension reads as consumingOutcomeKey), plus the other requested dimensions, under the consuming run's tags; day = the consumption's UTC day." }),
        consumptions: z.string().openapi({ description: "Σ weights (10 decimals): a whole number unless a production order makes several outcomes." }),
        reuses: z.string().openapi({ description: "Of which reuses (an earlier consumption already used the occurrence)." }),
        unknownProvenance: z.string().openapi({ description: "Of which no run declared producing the occurrence (no standard cost)." }),
        standardCost: ProductionCostSchema.openapi({ description: "Σ standard cost charged (each consumption = its source occurrence's production cost)." }),
        reuseGain: ProductionCostSchema.openapi({ description: "Of which charged on reuses (no spend behind it)." }),
      }),
    ),
    scope: z.array(
      z.object({
        dimensions: OutcomeCostDimensionsSchema.openapi({ description: "The requested dimensions except outcomeKey." }),
        spend: ProductionCostSchema.openapi({ description: "Every actual + refunded cost row of the scope in the range = producedCost + producedNone." }),
        producedCost: ProductionCostSchema.openapi({ description: "Part spread on produced occurrences (Σ produced[].cost of the scope)." }),
        producedNone: ProductionCostSchema.openapi({ description: "Part of runs with no declaring run at or above them, under the spending run's tags." }),
        coverageShare: z.object({ gross: z.string().nullable(), net: z.string().nullable() }).openapi({ description: "producedCost / spend, 10 decimals (0..1). Null when the scope spent nothing." }),
      }),
    ),
  })
  .openapi("OutcomeCostTotalsResponse");

registry.registerPath({
  method: "get",
  path: "/internal/stats/outcome-costs",
  summary: "The outcome ledger as totals: produced, consumed and produced-none per outcome x day x org x brand x campaign x workflow x feature (service-auth)",
  description:
    "The per-outcome cost rollup's input (features-service): unit cost of an outcome = own cost per occurrence + Σ over inputs (consumptions per occurrence x the input's unit cost). Read from the per-day rows the ledger refresher stores (every 15 min, same computation as /internal/outcome-costs/ledger-check), never a ledger scan. Exact decimals on billed gross, frozen net and vendor actual (+ unpriced gross). Every figure equals the sum of the matching /internal/outcome-occurrences rows (produced: costSlices; consumed: consumption.consumingOutcomes). Grouped by org (costOrgId) and day, produced cost + producedNone = the ledger check's ledger for that org-day. Dimensions (groupBy, comma list, any subset): outcomeKey, day (UTC), orgId (the declaring / consuming / spending run's org), costOrgId (the cost row's org = the ledger check's org; differs from orgId only for platform-billed spend made for an org's run), brandId (a co-branded run counts under each brand), campaignId, workflowSlug, featureSlug. Filters: the same names (outcomeKey filters produced and consumed by the consuming outcome, not scope). Default range: since the first stored day until today (UTC), <= 400 days. Each section holds at most maxGroups groups: above, 422 `too_many_groups`.",
  security: [{ apiKey: [] }],
  request: {
    query: z.object({
      groupBy: z.string().optional().openapi({ description: "Comma list of outcomeKey, day, orgId, costOrgId, brandId, campaignId, workflowSlug, featureSlug. Empty = one group per section." }),
      since: z.string().optional().openapi({ description: "YYYY-MM-DD (default: the first stored day)." }),
      until: z.string().optional().openapi({ description: "YYYY-MM-DD inclusive (default: today UTC)." }),
      outcomeKey: z.string().optional(),
      orgId: z.string().uuid().optional(),
      costOrgId: z.string().uuid().optional(),
      brandId: z.string().optional(),
      campaignId: z.string().optional(),
      workflowSlug: z.string().optional(),
      featureSlug: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Totals", content: { "application/json": { schema: OutcomeCostTotalsResponseSchema } } },
    400: { description: "Invalid groupBy, filter or range", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    422: { description: "too_many_groups: a section exceeds maxGroups (narrow groupBy, filters or range)", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export { UUID_STRING_RE as OUTCOME_UUID_RE };
