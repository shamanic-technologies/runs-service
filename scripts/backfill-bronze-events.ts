// Phase 3 of B/S/G substrate (γ migration plan).
// Synthesize bronze-layer domain events from existing silver rows.
// Idempotent: re-running this script produces zero new rows (WHERE NOT EXISTS).
//
// Invoke manually after Phase 2/5 deploy (NOT via Railway boot — O(N) workload
// would block port-bind per CLAUDE.md "Boot-window hazards"):
//
//   RUNS_SERVICE_DATABASE_URL=postgres://... npx tsx scripts/backfill-bronze-events.ts
//
// What it does:
//   - For each runs row → INSERT run.created event with occurred_at = created_at
//   - For each runs row with status IN ('completed','failed') → INSERT
//     corresponding run.completed / run.failed event with occurred_at = completed_at
//   - For each runs_costs row → INSERT cost.added event with occurred_at = created_at
//   - For each runs_costs row with status IN ('actual', 'cancelled') → also
//     INSERT cost.materialized / cost.cancelled event at created_at (best-effort
//     timing — silver never tracked transition timestamps)
//
// payload->>'backfilled' = true marks these as synthesized (not original HTTP
// captures). Use `WHERE (payload->>'backfilled')::boolean IS TRUE` to identify
// in audits.
//
// IMPORTANT: this script DISABLES the silver-projection triggers during
// execution because the silver rows already exist — re-projecting from synthetic
// events would attempt to re-INSERT, hit ON CONFLICT DO NOTHING for creations,
// but UPDATE the silver status/timestamps on transition events, which we DON'T
// want during backfill (silver is authoritative for pre-cutover rows).

import postgres from "postgres";

const url = process.env.RUNS_SERVICE_DATABASE_URL;
if (!url) {
  console.error("[backfill] RUNS_SERVICE_DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10 });

async function main() {
  console.log("[backfill] starting bronze-event synthesis");

  // Temporarily disable projection triggers so backfill doesn't re-mutate silver.
  await sql`ALTER TABLE run_lifecycle_events DISABLE TRIGGER trg_project_run_lifecycle`;
  await sql`ALTER TABLE cost_lifecycle_events DISABLE TRIGGER trg_project_cost_lifecycle`;

  try {
    // run.created — synthesize from existing runs rows
    const runCreatedRes = await sql`
      INSERT INTO run_lifecycle_events (run_id, event_type, payload, occurred_at)
      SELECT
        r.id,
        'run.created',
        jsonb_build_object(
          'runId', r.id::text,
          'parentRunId', r.parent_run_id::text,
          'organizationId', r.organization_id::text,
          'userId', r.user_id::text,
          'brandIds', to_jsonb(r.brand_ids),
          'campaignId', r.campaign_id,
          'workflowSlug', r.workflow_slug,
          'featureSlug', r.feature_slug,
          'serviceName', r.service_name,
          'taskName', r.task_name,
          'idempotencyKey', r.idempotency_key,
          'backfilled', true
        ),
        r.created_at
      FROM runs r
      WHERE NOT EXISTS (
        SELECT 1 FROM run_lifecycle_events e
        WHERE e.run_id = r.id AND e.event_type = 'run.created'
      )
    `;
    console.log(`[backfill] inserted ${runCreatedRes.count} run.created events`);

    // run.completed / run.failed — synthesize for terminal-status rows
    const runTerminalRes = await sql`
      INSERT INTO run_lifecycle_events (run_id, event_type, payload, occurred_at)
      SELECT
        r.id,
        CASE r.status WHEN 'completed' THEN 'run.completed' ELSE 'run.failed' END,
        jsonb_build_object('from', 'running', 'to', r.status, 'backfilled', true),
        COALESCE(r.completed_at, r.created_at)
      FROM runs r
      WHERE r.status IN ('completed', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM run_lifecycle_events e
          WHERE e.run_id = r.id
            AND e.event_type IN ('run.completed', 'run.failed')
        )
    `;
    console.log(`[backfill] inserted ${runTerminalRes.count} run.completed/failed events`);

    // cost.added — synthesize from existing runs_costs rows
    const costAddedRes = await sql`
      INSERT INTO cost_lifecycle_events (cost_id, run_id, event_type, payload, occurred_at)
      SELECT
        rc.id,
        rc.run_id,
        'cost.added',
        jsonb_build_object(
          'costId', rc.id::text,
          'costName', rc.cost_name,
          'costSource', rc.cost_source,
          'quantity', rc.quantity::text,
          'unitCostInUsdCents', rc.unit_cost_in_usd_cents::text,
          'totalCostInUsdCents', rc.total_cost_in_usd_cents::text,
          'status', 'actual',
          'idempotencyKey', rc.idempotency_key,
          'backfilled', true
        ),
        rc.created_at
      FROM runs_costs rc
      WHERE NOT EXISTS (
        SELECT 1 FROM cost_lifecycle_events e
        WHERE e.cost_id = rc.id AND e.event_type = 'cost.added'
      )
    `;
    console.log(`[backfill] inserted ${costAddedRes.count} cost.added events`);

    // cost.materialized / cost.cancelled — synthesize for non-default-status rows
    const costTransitionRes = await sql`
      INSERT INTO cost_lifecycle_events (cost_id, run_id, event_type, payload, occurred_at)
      SELECT
        rc.id,
        rc.run_id,
        CASE rc.status WHEN 'cancelled' THEN 'cost.cancelled' ELSE 'cost.materialized' END,
        jsonb_build_object('from', 'provisioned', 'to', rc.status, 'backfilled', true),
        rc.created_at
      FROM runs_costs rc
      WHERE rc.status IN ('actual', 'cancelled')
        AND NOT EXISTS (
          SELECT 1 FROM cost_lifecycle_events e
          WHERE e.cost_id = rc.id
            AND e.event_type IN ('cost.materialized', 'cost.cancelled')
        )
    `;
    console.log(`[backfill] inserted ${costTransitionRes.count} cost.materialized/cancelled events`);

    console.log("[backfill] complete");
  } finally {
    await sql`ALTER TABLE run_lifecycle_events ENABLE TRIGGER trg_project_run_lifecycle`;
    await sql`ALTER TABLE cost_lifecycle_events ENABLE TRIGGER trg_project_cost_lifecycle`;
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});
