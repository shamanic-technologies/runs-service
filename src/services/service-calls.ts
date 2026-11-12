// Every run of ONE service, fleet-wide, whole history, readable incrementally, with
// the cost lines it was charged and the decision it was part of
// (LLM-RATING-PER-ENGINE-1112-RUNS).
//
// First consumer: features-service's GTM Factory Rating, which rates each LLM per
// Engine from every chat-service call the fleet ever made. Nothing here knows what an
// LLM, a model or a channel is: the caller names the service (`chat-service`) and reads
// the cost NAMES; mapping a name to a model is chat-service's.
//
// Two phases behind one opaque cursor:
// - HISTORY: silver `runs` of the service started up to H0 (the instant the first
//   page was served), in (started_at, id) order. Silver, because bronze lifecycle
//   rows older than ~90-120 days live in R2 (lifecycle archive).
// - CHANGES: from H0 on, every run of the service that a bronze lifecycle fact
//   touched (run.created / completed / failed, cost.added / materialized /
//   cancelled / refunded / repriced, a support mark on the run), window by window,
//   each run served WHOLE again (upsert semantics). A window ends LAG_MS before
//   now, so a write still in flight (its bronze row is dated at its transaction's
//   start) has committed before its window is read.
// Not re-served: a support mark later stated on an ANCESTOR, a brand transfer
// (silver-only, no bronze fact). Both re-appear if the run itself changes.

import { sql, type SQL } from "drizzle-orm";
import { statsDb } from "../db/index.js";
import { versionWindowsSql } from "../routes/vendor-costs.js";
import type { VendorCostVersion } from "./vendor-costs.js";

export const SERVICE_CALLS_MAX_LIMIT = 5000;
export const SERVICE_CALLS_DEFAULT_LIMIT = 1000;
/** Longest stretch of run starts one history page scans (a rare service must not walk the whole fleet per page). */
const HISTORY_WINDOW_MS = 24 * 3600_000;
/** Longest stretch of bronze facts one changes page reads (fleet: ~30k run facts an hour). */
const CHANGES_WINDOW_MS = 3600_000;
/** How far up an ancestor walk goes (a dead 13,741-deep scheduler chain exists, 2026-04-01). */
export const MAX_ANCESTOR_DEPTH = 64;
/** A change cursor older than this may name facts already archived to R2: restart from scratch. */
const CURSOR_MAX_AGE_MS = 30 * 24 * 3600_000;
const MAX_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

export const changesLagMs = () => Number(process.env.SERVICE_CALLS_LAG_MS ?? 120_000);

export interface ServiceCallsFilter {
  serviceName: string;
  taskNames: string[] | null;
}

interface CursorV1 {
  v: 1;
  /** Filter fingerprint: a cursor is only valid for the filter that made it. */
  f: string;
  /** H0: history covers runs started at or before it; changes start after it. */
  h0: string;
  phase: "history" | "changes";
  /** history: last (started_at, id) served. changes: window (a, b] and last id served in it. */
  s?: string;
  id?: string;
  a?: string;
  b?: string;
}

export class CursorError extends Error {
  constructor(message: string, readonly expired = false) {
    super(message);
  }
}

const fingerprint = (f: ServiceCallsFilter) => JSON.stringify([f.serviceName, f.taskNames ? [...f.taskNames].sort() : null]);
const encode = (c: CursorV1) => Buffer.from(JSON.stringify(c)).toString("base64url");

function decode(raw: string, f: ServiceCallsFilter): CursorV1 {
  let c: CursorV1;
  try {
    c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new CursorError("cursor is not a cursor this read served");
  }
  if (c?.v !== 1 || typeof c.h0 !== "string" || (c.phase !== "history" && c.phase !== "changes")) {
    throw new CursorError("cursor is not a cursor this read served");
  }
  if (c.f !== fingerprint(f)) throw new CursorError("cursor was served for another serviceName / taskNames");
  const since = c.phase === "changes" ? c.a! : c.h0;
  if (Date.now() - Date.parse(since) > CURSOR_MAX_AGE_MS) {
    throw new CursorError("cursor is older than 30 days: its facts may be archived; restart without a cursor", true);
  }
  return c;
}

export interface CallCostLine {
  costId: string;
  costName: string;
  costSource: string;
  status: string;
  quantity: string;
  unitCostInUsdCents: string;
  totalCostInUsdCents: string;
  netCostInUsdCents: string;
  vendorUnitCostInUsdCents: string | null;
  vendorTotalCostInUsdCents: string | null;
  createdAt: string;
}

export interface ServiceCall {
  runId: string;
  parentRunId: string | null;
  serviceName: string;
  taskName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  orgId: string | null;
  brandIds: string[] | null;
  campaignId: string | null;
  featureSlug: string | null;
  workflowSlug: string | null;
  scriptSlug: string | null;
  rootRunId: string | null;
  decisionRunId: string | null;
  decisionBasis: "script" | "workflow" | "root" | null;
  supportFunction: string | null;
  costs: CallCostLine[];
}

export interface ServiceCallsPage {
  calls: ServiceCall[];
  nextCursor: string;
  phase: "history" | "changes";
  caughtUp: boolean;
  /** The last instant this page covers: history = H0, changes = its window end. */
  coveredUntil: string;
}

export interface ChainNode {
  id: string;
  parent: string | null;
  script: string | null;
  workflow: string | null;
  mark: string | null;
}

/**
 * The decision a run was part of, from its chain (itself first, then each ancestor):
 * - the nearest run naming a script, extended up while the parent names the SAME script
 *   (the script run that opened it: a chat call inherits its script run's slug);
 * - else the nearest run naming a workflow (no script), extended up the same way;
 * - else the top-level run.
 * null when the walk was cut before it could tell (deeper than MAX_ANCESTOR_DEPTH).
 */
export function decisionOf(chain: ChainNode[], complete: boolean): { id: string | null; basis: ServiceCall["decisionBasis"] } {
  const extend = (i: number, same: (n: ChainNode) => boolean) => {
    let j = i;
    while (j + 1 < chain.length && same(chain[j + 1])) j++;
    if (j === chain.length - 1 && !complete && chain[j].parent !== null) return null;
    return chain[j].id;
  };
  const s = chain.findIndex((n) => n.script !== null);
  if (s >= 0) {
    const slug = chain[s].script;
    return { id: extend(s, (n) => n.script === slug), basis: "script" };
  }
  const w = chain.findIndex((n) => n.workflow !== null);
  if (w >= 0) {
    const slug = chain[w].workflow;
    return { id: extend(w, (n) => n.script === null && n.workflow === slug), basis: "workflow" };
  }
  const top = chain[chain.length - 1];
  return top.parent === null ? { id: top.id, basis: "root" } : { id: null, basis: null };
}

type Exec = { execute: (q: SQL) => Promise<unknown> };

/** Each run's chain: itself, then each ancestor up to the top (or MAX_ANCESTOR_DEPTH), with its own support mark. */
export async function readChains(tx: Exec, runIds: string[]): Promise<Map<string, ChainNode[]>> {
  const chains = new Map<string, ChainNode[]>();
  if (runIds.length === 0) return chains;
  const chainRows = (await tx.execute(sql`
    WITH RECURSIVE up(start_id, id, parent_run_id, script_slug, workflow_slug, depth) AS (
      SELECT r.id, r.id, r.parent_run_id, r.script_slug, r.workflow_slug, 0
      FROM unnest(${`{${[...new Set(runIds)].join(",")}}`}::uuid[]) AS i(id)
      CROSS JOIN LATERAL (SELECT id, parent_run_id, script_slug, workflow_slug FROM runs WHERE id = i.id OFFSET 0) r
      UNION ALL
      SELECT up.start_id, p.id, p.parent_run_id, p.script_slug, p.workflow_slug, up.depth + 1
      FROM up
      CROSS JOIN LATERAL (SELECT id, parent_run_id, script_slug, workflow_slug FROM runs WHERE id = up.parent_run_id OFFSET 0) p
      WHERE up.parent_run_id IS NOT NULL AND up.depth < ${MAX_ANCESTOR_DEPTH}
    )
    SELECT up.start_id, up.id, up.parent_run_id, up.script_slug, up.workflow_slug, up.depth, m.kind
    FROM up LEFT JOIN run_support_marks m ON m.run_id = up.id
    ORDER BY up.start_id, up.depth
  `)) as any[];
  for (const r of chainRows) {
    const list = chains.get(r.start_id) ?? [];
    list.push({ id: r.id, parent: r.parent_run_id ?? null, script: r.script_slug ?? null, workflow: r.workflow_slug ?? null, mark: r.kind ?? null });
    chains.set(r.start_id, list);
  }
  return chains;
}

/** The decision of each run (null when its chain was cut before it could tell). */
export function decisionOfChain(chain: ChainNode[] | undefined): { id: string | null; basis: ServiceCall["decisionBasis"]; rootRunId: string | null } {
  if (!chain || chain.length === 0) return { id: null, basis: null, rootRunId: null };
  const top = chain[chain.length - 1];
  const complete = top.parent === null;
  const d = decisionOf(chain, complete);
  return { id: d.id, basis: d.id ? d.basis : null, rootRunId: complete ? top.id : null };
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());

/** The page's runs, served whole: chain, decision, support mark, every cost line. */
async function enrich(tx: Exec, runs: any[], versions: VendorCostVersion[]): Promise<ServiceCall[]> {
  if (runs.length === 0) return [];
  const ids = `{${runs.map((r) => r.id).join(",")}}`;
  const chains = await readChains(tx, runs.map((r) => r.id));

  const costRows = (await tx.execute(sql`
    WITH v AS MATERIALIZED (${versionWindowsSql(versions)})
    SELECT c.id, c.run_id, c.cost_name, c.cost_source, c.status, c.quantity::text AS quantity,
           c.unit_cost_in_usd_cents::text AS unit, c.total_cost_in_usd_cents::text AS total,
           COALESCE(c.net_cost_in_usd_cents, c.total_cost_in_usd_cents)::text AS net,
           v.vendor::text AS vendor_unit,
           CASE WHEN v.vendor IS NOT NULL THEN round(c.quantity * v.vendor, 10)::text END AS vendor_total,
           c.created_at
    FROM unnest(${ids}::uuid[]) AS i(id)
    CROSS JOIN LATERAL (SELECT * FROM runs_costs c WHERE c.run_id = i.id OFFSET 0) c
    LEFT JOIN v ON v.cost_name = c.cost_name AND v.billed = c.unit_cost_in_usd_cents
               AND c.created_at >= v.valid_from AND (v.valid_to IS NULL OR c.created_at < v.valid_to)
    ORDER BY c.run_id, c.created_at, c.id
  `)) as any[];
  const costs = new Map<string, CallCostLine[]>();
  for (const c of costRows) {
    const list = costs.get(c.run_id) ?? [];
    list.push({
      costId: c.id,
      costName: c.cost_name,
      costSource: c.cost_source,
      status: c.status,
      quantity: c.quantity,
      unitCostInUsdCents: c.unit,
      totalCostInUsdCents: c.total,
      netCostInUsdCents: c.net,
      vendorUnitCostInUsdCents: c.vendor_unit ?? null,
      vendorTotalCostInUsdCents: c.vendor_total ?? null,
      createdAt: iso(c.created_at)!,
    });
    costs.set(c.run_id, list);
  }

  return runs.map((r) => {
    const chain = chains.get(r.id) ?? [];
    const decision = decisionOfChain(chain);
    return {
      runId: r.id,
      parentRunId: r.parent_run_id ?? null,
      serviceName: r.service_name,
      taskName: r.task_name,
      status: r.status,
      startedAt: iso(r.started_at)!,
      completedAt: iso(r.completed_at),
      orgId: r.organization_id ?? null,
      brandIds: r.brand_ids ?? null,
      campaignId: r.campaign_id ?? null,
      featureSlug: r.feature_slug ?? null,
      workflowSlug: r.workflow_slug ?? null,
      scriptSlug: r.script_slug ?? null,
      rootRunId: decision.rootRunId,
      decisionRunId: decision.id,
      decisionBasis: decision.basis,
      supportFunction: chain.find((n) => n.mark !== null)?.mark ?? null,
      costs: costs.get(r.id) ?? [],
    };
  });
}

const RUN_COLUMNS = sql`r.id, r.parent_run_id, r.service_name, r.task_name, r.status, r.started_at, r.completed_at,
  r.organization_id, r.brand_ids, r.campaign_id, r.feature_slug, r.workflow_slug, r.script_slug`;

function filterSql(f: ServiceCallsFilter): SQL {
  const parts = [sql`r.service_name = ${f.serviceName}`];
  if (f.taskNames) parts.push(sql`r.task_name IN (${sql.join(f.taskNames.map((t) => sql`${t}`), sql`, `)})`);
  return sql.join(parts, sql` AND `);
}

/**
 * One page of the feed. Cursor absent = the first history page (H0 = now - lag).
 * A page may hold fewer calls than `limit` (a window with fewer runs); follow
 * `nextCursor` until `caughtUp`, then keep calling it later for what changed.
 */
export async function readServiceCalls(
  f: ServiceCallsFilter,
  rawCursor: string | undefined,
  limit: number,
  versions: VendorCostVersion[],
  now = new Date(),
): Promise<ServiceCallsPage> {
  const lagEnd = new Date(now.getTime() - changesLagMs());
  const c: CursorV1 = rawCursor
    ? decode(rawCursor, f)
    : { v: 1, f: fingerprint(f), h0: lagEnd.toISOString(), phase: "history" };

  return statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '100s'`);

    if (c.phase === "history") {
      const fromS = c.s ?? null;
      const fromId = c.id ?? null;
      // A run started at the very first instant has no predecessor: the first page starts at the first start.
      let lo = fromS;
      if (lo === null) {
        const [first] = (await tx.execute(sql`
          SELECT min(r.started_at) AS s FROM runs r WHERE ${filterSql(f)} AND r.started_at <= ${c.h0}::timestamptz
        `)) as any[];
        if (!first?.s) {
          const next: CursorV1 = { ...c, phase: "changes", a: c.h0, b: c.h0, s: undefined, id: undefined };
          return { calls: [], nextCursor: encode(next), phase: "history" as const, caughtUp: false, coveredUntil: c.h0 };
        }
        lo = new Date(first.s).toISOString();
      }
      const hi = new Date(Math.min(Date.parse(lo) + HISTORY_WINDOW_MS, Date.parse(c.h0))).toISOString();
      const after = fromS === null ? sql`r.started_at >= ${lo}::timestamptz` : sql`(r.started_at, r.id) > (${fromS}::timestamptz, ${fromId}::uuid)`;
      const runs = (await tx.execute(sql`
        SELECT ${RUN_COLUMNS} FROM runs r
        WHERE ${filterSql(f)} AND ${after} AND r.started_at <= ${hi}::timestamptz
        ORDER BY r.started_at, r.id
        LIMIT ${limit}
      `)) as any[];
      const calls = await enrich(tx, runs, versions);
      let next: CursorV1;
      if (runs.length === limit) {
        const last = runs[runs.length - 1];
        next = { ...c, s: new Date(last.started_at).toISOString(), id: last.id };
        // started_at holds µs; a cursor at ms would re-serve or skip a run started in the same ms.
        const [exact] = (await tx.execute(sql`SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS s FROM runs WHERE id = ${last.id}::uuid`)) as any[];
        next.s = exact.s;
      } else if (hi < c.h0) {
        next = { ...c, s: hi, id: MAX_ID };
      } else {
        next = { v: 1, f: c.f, h0: c.h0, phase: "changes", a: c.h0, b: c.h0 };
      }
      return { calls, nextCursor: encode(next), phase: "history" as const, caughtUp: false, coveredUntil: c.h0 };
    }

    // CHANGES: window (a, b]. A fresh window starts where the last one ended.
    let a = c.a!;
    let b = c.b!;
    let fromId = c.id ?? null;
    if (fromId === null && a === b) {
      const end = Math.min(Date.parse(a) + CHANGES_WINDOW_MS, lagEnd.getTime());
      if (end <= Date.parse(a)) {
        return { calls: [], nextCursor: encode(c), phase: "changes" as const, caughtUp: true, coveredUntil: a };
      }
      b = new Date(end).toISOString();
    }
    const runs = (await tx.execute(sql`
      WITH touched AS MATERIALIZED (
        SELECT run_id FROM run_lifecycle_events WHERE occurred_at > ${a}::timestamptz AND occurred_at <= ${b}::timestamptz
        UNION
        SELECT run_id FROM cost_lifecycle_events WHERE occurred_at > ${a}::timestamptz AND occurred_at <= ${b}::timestamptz
        UNION
        SELECT run_id FROM outcome_declaration_events
        WHERE event_type IN ('run.support_marked', 'run.support_unmarked')
          AND occurred_at > ${a}::timestamptz AND occurred_at <= ${b}::timestamptz
      )
      SELECT ${RUN_COLUMNS}
      FROM touched t
      CROSS JOIN LATERAL (SELECT * FROM runs WHERE id = t.run_id OFFSET 0) r
      WHERE ${filterSql(f)} ${fromId ? sql`AND r.id > ${fromId}::uuid` : sql``}
      ORDER BY r.id
      LIMIT ${limit}
    `)) as any[];
    const calls = await enrich(tx, runs, versions);
    const windowDone = runs.length < limit;
    const next: CursorV1 = windowDone
      ? { v: 1, f: c.f, h0: c.h0, phase: "changes", a: b, b }
      : { v: 1, f: c.f, h0: c.h0, phase: "changes", a, b, id: runs[runs.length - 1].id };
    return {
      calls,
      nextCursor: encode(next),
      phase: "changes" as const,
      caughtUp: windowDone && Date.parse(b) >= lagEnd.getTime(),
      coveredUntil: windowDone ? b : a,
    };
  });
}
