import { pgTable, uuid, text, timestamp, numeric, index, jsonb } from "drizzle-orm/pg-core";

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
    serviceName: text("service_name").notNull(),
    taskName: text("task_name").notNull(),
    status: text("status").notNull().default("running"),
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
    unitCostInUsdCents: numeric("unit_cost_in_usd_cents", { precision: 12, scale: 10 }).notNull(),
    totalCostInUsdCents: numeric("total_cost_in_usd_cents", { precision: 16, scale: 10 }).notNull(),
    status: text("status").notNull().default("actual"),
    billingTransactionId: text("billing_transaction_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_runs_costs_run_agg").on(table.runId, table.status, table.totalCostInUsdCents, table.quantity),
    index("idx_runs_costs_status").on(table.runId, table.status),
    index("idx_runs_costs_created_at").on(table.createdAt),
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
  ]
);

export type RunEvent = typeof runEvents.$inferSelect;
export type NewRunEvent = typeof runEvents.$inferInsert;
