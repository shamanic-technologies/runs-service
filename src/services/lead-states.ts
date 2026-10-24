// LEAD-STATES-1024-RUNS: the inputs of allocation v5 (doctrine rules 2 and 3,
// owner 2026-10-24). Three facts runs-service does not own, each read from its
// owner and never re-typed here:
//
//  1. WHICH steps are lead STATES: features-service's step catalogue states, per
//     step key, the state it reaches (`leadState`), its family (`leadStateFamily`:
//     interest | visit) and its rank in the family (`leadStateRank`: interest
//     1..4, visit 1). A step with no state (lead_found, message_sent...) is
//     production toward a state.
//  2. WHICH state a run's PIPE targets: the pipe = the run's channel (feature
//     slug) x the leg its workflow dynasty is assigned to (features-service
//     /internal/workflow-leg-assignments, the dynasty from workflow-service
//     /public/workflows, a merged dynasty read on its survivor's leg); the
//     leg's `to` step (the channel's stepTransitions on /public/channels) mapped to
//     its state by (1). Never a per-channel or per-pipe rule.
//  3. WHEN each lead first reached each state at a brand: lead-service
//     GET /internal/lead-states (real instants), synced into lead_state_reaches
//     by the ledger refresher. A changed or removed reach stamps changed_at, so
//     the refresher recomputes every stored day it can move.

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { OutcomeCatalogueError } from "./outcome-catalogue.js";

const FETCH_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 5 * 60_000;

export type StateFamily = "interest" | "visit";
export const STATE_FAMILIES: readonly StateFamily[] = ["interest", "visit"];

export interface StepState {
  stepKey: string;
  state: string;
  family: StateFamily;
  rank: number;
}

export interface PipeTarget {
  workflowSlug: string;
  featureSlug: string;
  /** The pipe's leg `to` step (catalogue key). */
  toStep: string;
  state: string;
  family: StateFamily;
  rank: number;
}

export interface AllocationInputs {
  /** Every catalogue step that reaches a state (state keys themselves included). */
  stepStates: StepState[];
  /** Every (workflow version slug, channel) whose pipe targets a state. */
  pipeTargets: PipeTarget[];
}

export class AllocationInputsError extends Error {}

async function getJson<T>(url: string, apiKey?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: apiKey ? { "x-api-key": apiKey } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AllocationInputsError(`${url} unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) throw new AllocationInputsError(`${url} returned ${res.status}`);
  return (await res.json()) as T;
}

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new AllocationInputsError(`${name} not configured`);
  return v;
};

/** (1) Step key -> state, from the served catalogue. A catalogue serving no state at all fails loud. */
export async function fetchStepStates(): Promise<StepState[]> {
  const body = await getJson<{ rows?: Array<Record<string, unknown>> }>(`${env("FEATURES_SERVICE_URL")}/public/catalogue/steps`);
  if (!body || !Array.isArray(body.rows) || body.rows.length === 0) throw new OutcomeCatalogueError("features-service step catalogue returned no rows");
  const out: StepState[] = [];
  for (const r of body.rows) {
    if (typeof r.key !== "string" || r.leadState == null) continue;
    if (typeof r.leadState !== "string" || (r.leadStateFamily !== "interest" && r.leadStateFamily !== "visit") || typeof r.leadStateRank !== "number") {
      throw new AllocationInputsError(`catalogue step ${r.key}: malformed lead state (${JSON.stringify([r.leadState, r.leadStateFamily, r.leadStateRank])})`);
    }
    out.push({ stepKey: r.key, state: r.leadState, family: r.leadStateFamily, rank: r.leadStateRank });
  }
  if (!out.some((s) => s.stepKey === s.state)) {
    throw new AllocationInputsError("features-service step catalogue serves no lead state (leadState): allocation v5 cannot run");
  }
  return out;
}

interface Assignment {
  featureSlug: string;
  legKey: string;
  workflowDynastySlug: string;
  state: string;
  decidedAt?: string | null;
}

/**
 * (2) The state each workflow version x channel targets. A dynasty is ACTIVE on one
 * leg per channel at a time; one only deprecated is read on its latest decision (a
 * past run of a dynasty moved off its leg). A leg the channel does not publish, or a
 * `to` step with no state (lead_found, booking calls...), targets nothing: the run
 * keeps allocation v4.
 */
export async function fetchPipeTargets(stepStates: StepState[]): Promise<PipeTarget[]> {
  const [assign, channels] = await Promise.all([
    getJson<{ assignments: Assignment[] }>(`${env("FEATURES_SERVICE_URL")}/internal/workflow-leg-assignments`, process.env.FEATURES_SERVICE_API_KEY),
    getJson<{ channels: Array<{ slug: string; stepTransitions?: Array<{ legKey: string; to?: { key?: string } | null }> }> }>(
      `${env("FEATURES_SERVICE_URL")}/public/channels`,
    ),
  ]);
  if (!Array.isArray(assign?.assignments) || !Array.isArray(channels?.channels)) {
    throw new AllocationInputsError("pipe target inputs malformed (assignments / channels)");
  }
  const featureSlugs = [...new Set(assign.assignments.map((a) => a.featureSlug))].sort();
  const wf = featureSlugs.length === 0
    ? { workflows: [] }
    : await getJson<{ workflows: Array<{ workflowSlug: string; workflowDynastySlug: string; featureSlug: string; mergedIntoDynastySlug?: string | null }> }>(
        `${env("WORKFLOW_SERVICE_URL")}/public/workflows?status=all&featureSlugs=${encodeURIComponent(featureSlugs.join(","))}`,
        process.env.WORKFLOW_SERVICE_API_KEY,
      );
  if (!Array.isArray(wf?.workflows)) throw new AllocationInputsError("workflow-service /public/workflows returned no workflows[]");
  const stateOf = new Map(stepStates.map((s) => [s.stepKey, s]));
  const toStep = new Map<string, string>();
  for (const c of channels.channels) {
    for (const t of c.stepTransitions ?? []) if (t.to?.key) toStep.set(`${c.slug}|${t.legKey}`, t.to.key);
  }
  // Per (dynasty, channel): the active leg, else the latest decided.
  const legOf = new Map<string, Assignment>();
  const order = (a: Assignment) => [a.state === "active" ? 1 : 0, a.decidedAt ?? ""] as const;
  for (const a of assign.assignments) {
    const k = `${a.workflowDynastySlug}|${a.featureSlug}`;
    const prev = legOf.get(k);
    const [pa, pd] = prev ? order(prev) : [-1, ""];
    const [na, nd] = order(a);
    if (!prev || na > pa || (na === pa && nd > pd)) legOf.set(k, a);
  }
  const out: PipeTarget[] = [];
  const seen = new Set<string>();
  for (const w of wf.workflows) {
    // A merged dynasty's versions run on the survivor's leg when their own has none.
    const a = legOf.get(`${w.workflowDynastySlug}|${w.featureSlug}`) ?? (w.mergedIntoDynastySlug ? legOf.get(`${w.mergedIntoDynastySlug}|${w.featureSlug}`) : undefined);
    const to = a ? toStep.get(`${a.featureSlug}|${a.legKey}`) : undefined;
    const st = to ? stateOf.get(to) : undefined;
    if (!a || !to || !st) continue;
    const k = `${w.workflowSlug}|${w.featureSlug}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ workflowSlug: w.workflowSlug, featureSlug: w.featureSlug, toStep: to, state: st.state, family: st.family, rank: st.rank });
  }
  return out;
}

let cache: { at: number; inputs: AllocationInputs } | null = null;

/** Test hook. */
export function setAllocationInputsForTests(inputs: AllocationInputs | null): void {
  cache = inputs ? { at: Number.POSITIVE_INFINITY, inputs } : null;
}

/** Both catalogue inputs, cached 5 min. Unreadable = throws (a day is never computed on a guess). */
export async function fetchAllocationInputs(): Promise<AllocationInputs> {
  const now = Date.now();
  if (cache && (cache.at === Number.POSITIVE_INFINITY || now - cache.at < CACHE_TTL_MS)) return cache.inputs;
  const stepStates = await fetchStepStates();
  const pipeTargets = await fetchPipeTargets(stepStates);
  cache = { at: now, inputs: { stepStates, pipeTargets } };
  return cache.inputs;
}

// ---------------------------------------------------------------------------
// (3) lead-service first reaches -> lead_state_reaches
// ---------------------------------------------------------------------------

export interface LeadStateRow {
  orgId: string | null;
  brandId: string;
  leadId: string;
  states: Record<string, { reachedAt: string | null; basis?: string | null; impliedBy?: string | null } | null>;
}

export interface ReachInput {
  organizationId: string | null;
  brandId: string;
  leadId: string;
  state: string;
  family: StateFamily;
  rank: number;
  reachedAt: string | null;
  basis: string | null;
  impliedBy: string | null;
}

/** Flattens lead-service rows to one reach per (brand, lead, reached state). An unknown state key fails loud. */
export function reachesOf(rows: LeadStateRow[], stepStates: StepState[]): ReachInput[] {
  const states = new Map(stepStates.filter((s) => s.stepKey === s.state).map((s) => [s.state, s]));
  const out: ReachInput[] = [];
  for (const r of rows) {
    for (const [state, v] of Object.entries(r.states ?? {})) {
      if (v == null) continue;
      const s = states.get(state);
      if (!s) throw new AllocationInputsError(`lead-service state ${state} is not a catalogue lead state`);
      out.push({
        organizationId: r.orgId ?? null,
        brandId: r.brandId,
        leadId: r.leadId,
        state,
        family: s.family,
        rank: s.rank,
        reachedAt: v.reachedAt ?? null,
        basis: v.basis ?? null,
        impliedBy: v.impliedBy ?? null,
      });
    }
  }
  return out;
}

let testSource: LeadStateRow[] | null = null;

/** Test hook: the rows lead-service "serves" (null = the real route). */
export function setLeadStatesSourceForTests(rows: LeadStateRow[] | null): void {
  testSource = rows;
}

/** Every lead x brand row lead-service serves, walked page by page. */
export async function fetchLeadStates(): Promise<LeadStateRow[]> {
  if (testSource) return testSource;
  const base = env("LEAD_SERVICE_URL");
  const key = env("LEAD_SERVICE_API_KEY");
  const out: LeadStateRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10_000; page++) {
    const q: string = `limit=5000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const body: { leads?: LeadStateRow[]; nextCursor?: string | null } = await getJson(`${base}/internal/lead-states?${q}`, key);
    if (!Array.isArray(body?.leads)) throw new AllocationInputsError("lead-service /internal/lead-states returned no leads[]");
    out.push(...body.leads);
    cursor = body.nextCursor ?? null;
    if (!cursor) return out;
  }
  throw new AllocationInputsError("lead-service /internal/lead-states: too many pages");
}

/**
 * Writes the served reaches into lead_state_reaches: a new or changed reach (date,
 * basis, family/rank) stamps changed_at; a reach no longer served gets removed_at
 * (and changed_at). One transaction; returns the counts.
 */
export async function storeLeadStateReaches(reaches: ReachInput[]): Promise<{ upserted: number; changed: number; removed: number }> {
  return db.transaction(async (tx) => {
    const payload = JSON.stringify(
      reaches.map((r) => ({
        org: r.organizationId, b: r.brandId, l: r.leadId, s: r.state, f: r.family, k: r.rank,
        at: r.reachedAt, basis: r.basis, imp: r.impliedBy,
      })),
    );
    const changed = (await tx.execute(sql`
      WITH x AS (
        SELECT * FROM jsonb_to_recordset(${payload}::jsonb)
          AS x(org uuid, b text, l text, s text, f text, k integer, at timestamptz, basis text, imp text)
      )
      INSERT INTO lead_state_reaches AS t (organization_id, brand_id, lead_id, state, family, rank, reached_at, basis, implied_by)
      SELECT org, b, l, s, f, k, at, basis, imp FROM x
      ON CONFLICT (brand_id, lead_id, state) DO UPDATE SET
        organization_id = EXCLUDED.organization_id, family = EXCLUDED.family, rank = EXCLUDED.rank,
        reached_at = EXCLUDED.reached_at, basis = EXCLUDED.basis, implied_by = EXCLUDED.implied_by,
        synced_at = now(),
        changed_at = CASE WHEN t.removed_at IS NOT NULL
                            OR t.reached_at IS DISTINCT FROM EXCLUDED.reached_at
                            OR t.family IS DISTINCT FROM EXCLUDED.family OR t.rank IS DISTINCT FROM EXCLUDED.rank
                          THEN now() ELSE t.changed_at END,
        removed_at = NULL
      RETURNING (xmax = 0) AS inserted, changed_at = now() AS changed
    `)) as any[];
    const removed = (await tx.execute(sql`
      WITH x AS (
        SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS x(b text, l text, s text)
      )
      UPDATE lead_state_reaches t SET removed_at = now(), changed_at = now()
      WHERE t.removed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM x WHERE x.b = t.brand_id AND x.l = t.lead_id AND x.s = t.state)
      RETURNING t.id
    `)) as any[];
    return { upserted: changed.length, changed: changed.filter((r) => r.changed).length, removed: removed.length };
  });
}

/** One sync pass (the refresher's tick, before any day is computed). */
export async function syncLeadStates(stepStates: StepState[]): Promise<{ upserted: number; changed: number; removed: number }> {
  const rows = await fetchLeadStates();
  if (rows.length === 0) {
    const [held] = (await db.execute(sql`SELECT 1 AS x FROM lead_state_reaches WHERE removed_at IS NULL LIMIT 1`)) as any[];
    if (held) throw new AllocationInputsError("lead-service served no lead state at all: refusing to remove every reach");
  }
  return storeLeadStateReaches(reachesOf(rows, stepStates));
}
