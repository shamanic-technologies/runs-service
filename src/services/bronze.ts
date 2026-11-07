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

/**
 * Anything that can insert: a transaction, or the pool itself for a LONE write
 * (one autocommit statement). BOX-LOAD-1107-RUNS: the projection triggers behind a
 * bronze insert row-lock shared rollup rows (today's run-day counter, the
 * feature/workflow and campaign-day groups) until COMMIT. A route that also reads
 * its row back inside the transaction keeps those locks across two more round
 * trips while the busy event loop gets to them, and every other writer of the
 * same rows queues (`Lock: transactionid`, ~45 % of insert samples, 2026-11-07).
 * Write alone (or the writes that must be atomic, together), read back after.
 */
export type BronzeWriter = Pick<Tx, "insert">;

export type RunLifecycleEventType =
  | "run.created"
  | "run.completed"
  | "run.failed"
  | "run.org_deleted"
  | "run.feature_slug_corrected";
export type CostLifecycleEventType = "cost.added" | "cost.materialized" | "cost.cancelled" | "cost.refunded" | "cost.repriced";

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

export async function logRunLifecycle(tx: BronzeWriter, args: LogRunArgs): Promise<void> {
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

export async function logCostLifecycle(tx: BronzeWriter, args: LogCostArgs): Promise<void> {
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
