import { pgTable, uuid, text, timestamp, numeric, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentRunId: uuid("parent_run_id").references((): any => runs.id),
    organizationId: uuid("organization_id"),
    userId: uuid("user_id"),
    brandIds: text("brand_ids").array(),
    campaignId: text("campaign_id"),
    workflowSlug: text("workflow_slug"),
    featureSlug: text("feature_slug"),
    goal: text("goal"),
    brandProfileId: text("brand_profile_id"),
    audienceId: text("audience_id"),
    workflowContext: text("workflow_context"),
    serviceName: text("service_name").notNull(),
    taskName: text("task_name").notNull(),
    status: text("status").notNull().default("running"),
    idempotencyKey: text("idempotency_key"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_runs_org_service").on(table.organizationId, table.serviceName),
    index("idx_runs_parent").on(table.parentRunId),
    index("idx_runs_brand_ids").using("gin", table.brandIds),
    index("idx_runs_campaign").on(table.campaignId),
    index("idx_runs_feature_slug").on(table.featureSlug),
    index("idx_runs_feature_org").on(table.featureSlug, table.organizationId),
    index("idx_runs_goal_org").on(table.goal, table.organizationId),
    index("idx_runs_brand_profile").on(table.brandProfileId),
    index("idx_runs_audience").on(table.audienceId),
    uniqueIndex("idx_runs_idempotency_key")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ]
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;

export const runsCosts = pgTable(
  "runs_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    costName: text("cost_name").notNull(),
    costSource: text("cost_source").notNull(),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    unitCostInUsdCents: numeric("unit_cost_in_usd_cents", { precision: 16, scale: 10 }).notNull(),
    totalCostInUsdCents: numeric("total_cost_in_usd_cents", { precision: 16, scale: 10 }).notNull(),
    // Frozen net = gross reduced by the org usage discount in effect at write
    // time (migration 0028). NULL for historical rows (predate the feature);
    // readers COALESCE(net, total) so those rows correctly read net == gross.
    netCostInUsdCents: numeric("net_cost_in_usd_cents", { precision: 16, scale: 10 }),
    // Frozen usage-discount fraction in [0,1] applied to produce the net.
    // NULL when no discount was applied. Provenance only — never recomputed.
    usageDiscountPct: numeric("usage_discount_pct", { precision: 9, scale: 8 }),
    status: text("status").notNull().default("actual"),
    goal: text("goal"),
    brandProfileId: text("brand_profile_id"),
    audienceId: text("audience_id"),
    workflowContext: text("workflow_context"),
    // Denormalized from the owning run at cost-write time (migration 0029), so
    // org-level platform-spend SUMs read a single indexed table instead of
    // joining runs. NULL for rows written before the freeze / out-of-band
    // backfill. Frozen from run.organization_id — never recomputed.
    organizationId: uuid("organization_id"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_runs_costs_run_agg").on(table.runId, table.status, table.totalCostInUsdCents, table.quantity),
    index("idx_runs_costs_status").on(table.runId, table.status),
    index("idx_runs_costs_created_at").on(table.createdAt),
    index("idx_runs_costs_goal").on(table.goal),
    index("idx_runs_costs_brand_profile").on(table.brandProfileId),
    index("idx_runs_costs_audience").on(table.audienceId),
    // Partial covering index for org-level platform-spend SUMs (migration 0029).
    // INCLUDE (total/net cost) is applied in the hand-authored migration; drizzle's
    // index builder can't express INCLUDE, so it is intentionally omitted here.
    index("idx_runs_costs_org_projected")
      .on(table.organizationId)
      .where(sql`is_platform_projected`),
    uniqueIndex("idx_runs_costs_idempotency_key")
      .on(table.runId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ]
);

export type RunCost = typeof runsCosts.$inferSelect;
export type NewRunCost = typeof runsCosts.$inferInsert;

export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    service: text("service").notNull(),
    event: text("event").notNull(),
    detail: text("detail"),
    level: text("level").notNull().default("info"),
    data: jsonb("data"),
    orgId: uuid("org_id"),
    userId: uuid("user_id"),
    brandIds: text("brand_ids"),
    campaignId: uuid("campaign_id"),
    workflowSlug: text("workflow_slug"),
    featureSlug: text("feature_slug"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_run_events_run_created").on(table.runId, table.createdAt),
    index("idx_run_events_service_created").on(table.service, table.createdAt),
    // Serves the dashboard launch-progress poll: GET /v1/events?campaignId=X
    // ORDER BY created_at DESC. Without it, the campaignId filter falls back to a
    // seq scan + sort over the full bronze log (millions of rows) — the slow read
    // that saturated the pool and starved trace-event writes (lead-service 5s aborts).
    index("idx_run_events_campaign_created").on(table.campaignId, table.createdAt.desc()),
  ]
);

export type RunEvent = typeof runEvents.$inferSelect;
export type NewRunEvent = typeof runEvents.$inferInsert;

// Bronze layer (γ-migration Phase 1) — append-only domain event logs.
// No FK to runs / runs_costs: bronze must survive even if silver is cascade-deleted.
// Phase 2 will wire handlers to dual-write into these tables. Phase 4 will swap reads.
// See CLAUDE.md "Data layering" section.

export const runLifecycleEvents = pgTable(
  "run_lifecycle_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    sourceService: text("source_service"),
    identity: jsonb("identity"),
    idempotencyKey: text("idempotency_key"),
    correlationId: text("correlation_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_rle_run_occurred").on(table.runId, table.occurredAt),
    index("idx_rle_event_type").on(table.eventType, table.occurredAt),
  ]
);

export type RunLifecycleEvent = typeof runLifecycleEvents.$inferSelect;
export type NewRunLifecycleEvent = typeof runLifecycleEvents.$inferInsert;

export const costLifecycleEvents = pgTable(
  "cost_lifecycle_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    costId: uuid("cost_id"),
    runId: uuid("run_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    identity: jsonb("identity"),
    idempotencyKey: text("idempotency_key"),
    correlationId: text("correlation_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_cle_run_occurred").on(table.runId, table.occurredAt),
    index("idx_cle_event_type").on(table.eventType, table.occurredAt),
  ]
);

export type CostLifecycleEvent = typeof costLifecycleEvents.$inferSelect;
export type NewCostLifecycleEvent = typeof costLifecycleEvents.$inferInsert;
