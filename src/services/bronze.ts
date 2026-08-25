// Bronze-layer write helpers. Phase 2 of γ migration plan.
//
// Every mutating runs-service handler logs a domain event to the bronze layer
// BEFORE applying the silver write, inside the same transaction. If silver
// fails, bronze rolls back — atomic. If bronze fails, silver also rolls back —
// fail-loud per CLAUDE.md doctrine.
//
// Doctrine guardrails (Greg Young / Kleppmann / Richardson):
//   - Event names are domain-meaningful (`run.completed`, `cost.materialized`),
//     NOT field-level (`status_changed(field=status,value=...)`).
//   - Payload carries delta + reason — never the full aggregate.
//   - Idempotent HTTP replays (200 path) do NOT call these helpers — bronze
//     captures state changes, not HTTP traffic.

import { randomUUID } from "node:crypto";
import { runLifecycleEvents, costLifecycleEvents } from "../db/schema.js";

export type Tx = Parameters<Parameters<typeof import("../db/index.js").db.transaction>[0]>[0];

export type RunLifecycleEventType = "run.created" | "run.completed" | "run.failed" | "run.org_deleted";
export type CostLifecycleEventType = "cost.added" | "cost.materialized" | "cost.cancelled" | "cost.refunded";

export type Identity = {
  orgId?: string | null;
  userId?: string | null;
  brandIds?: string[] | null;
  campaignId?: string | null;
  workflowSlug?: string | null;
  featureSlug?: string | null;
  goal?: string | null;
  brandProfileId?: string | null;
  audienceId?: string | null;
  workflowContext?: string | null;
};

type LogRunArgs = {
  runId: string;
  eventType: RunLifecycleEventType;
  payload: Record<string, unknown>;
  identity?: Identity | null;
  sourceService?: string | null;
  idempotencyKey?: string | null;
  correlationId?: string | null;
};

export async function logRunLifecycle(tx: Tx, args: LogRunArgs): Promise<void> {
  await tx.insert(runLifecycleEvents).values({
    runId: args.runId,
    eventType: args.eventType,
    payload: args.payload,
    identity: args.identity ?? null,
    sourceService: args.sourceService ?? null,
    idempotencyKey: args.idempotencyKey ?? null,
    correlationId: args.correlationId ?? null,
  });
}

type LogCostArgs = {
  runId: string;
  costId?: string | null;
  eventType: CostLifecycleEventType;
  payload: Record<string, unknown>;
  identity?: Identity | null;
  idempotencyKey?: string | null;
  correlationId?: string | null;
};

export async function logCostLifecycle(tx: Tx, args: LogCostArgs): Promise<void> {
  await tx.insert(costLifecycleEvents).values({
    runId: args.runId,
    costId: args.costId ?? null,
    eventType: args.eventType,
    payload: args.payload,
    identity: args.identity ?? null,
    idempotencyKey: args.idempotencyKey ?? null,
    correlationId: args.correlationId ?? null,
  });
}

// Pre-generate UUIDs so bronze + silver can reference the same id.
// Phase 5 trigger uses payload.runId / payload.costId for silver projection.
export const newRunId = (): string => randomUUID();
export const newCostId = (): string => randomUUID();
