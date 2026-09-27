// POST /internal/transfer-brand — move every run of a brand from one org to another,
// with its costs and telemetry events, and record what moved.
//
// WHICH RUNS BELONG TO THE BRAND (the rule, stated once):
//   1. every run of the source org whose brand_ids CONTAINS the brand — solo AND
//      co-branded. A run carries one org, so a co-branded run cannot be split: it
//      follows the first of its brands to leave the org. The client must see its
//      whole history, and "the old org holds nothing of the brand" leaves no other
//      answer. (Prod, 2026-09-27: zero co-branded runs carry Doc Dinners or Living
//      Vital, so no run shared with another client moves today.)
//   2. every UNTAGGED run of the source org (brand_ids NULL/empty) whose campaign_id
//      is one of the brand's campaigns — a campaign being the brand's when a run
//      tagged with the brand carries it. Postmark sends and campaign lifecycle
//      emails are written untagged but belong to the brand's campaigns.
//   Untagged runs with no campaign (dashboard reads by agency staff) stay: nothing
//   ties them to one brand.
//
// WHAT MOVES WITH A RUN: runs.organization_id; runs_costs.organization_id (the
// denormalized org of migration 0029) for rows still on the source org;
// run_events.org_id for rows still on the source org. org_actual_totals and the
// campaign-day rollup follow by trigger, in the same transaction.
// With targetBrandId, the brand id is rewritten inside brand_ids (array_replace,
// solo and co-branded) and inside run_events.brand_ids of moved runs; other orgs'
// runs referencing the brand are rewritten too (the brand id itself changed).
//
// CHUNKED + IDEMPOTENT + CONCURRENCY-SAFE: candidates are collected once, then
// moved CHUNK_SIZE at a time, each chunk its own transaction. The UPDATE re-checks
// organization_id = source under the row lock, so a concurrent call (or a re-run)
// skips rows another call already moved, and every figure below is computed from
// the rows THIS chunk's UPDATE returned. A re-run moves nothing and writes nothing.
// Chunking keeps each org_actual_totals row lock short: the source org is the
// agency's, and its other brands keep writing costs during the move.
//
// MONEY: a transfer moves history, not money. The chunk's moved spend is frozen
// into brand_transfer_moves in the same transaction, so billing-service can offset
// it and leave both orgs' balances unchanged.

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export const TRANSFER_CHUNK_SIZE = 2000;

export type BrandTransferInput = {
  sourceBrandId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetBrandId?: string;
};

export type BrandTransferResult = {
  runsMoved: number;
  runsBrandRewrittenElsewhere: number;
  costsMoved: number;
  eventsMoved: number;
};

function uuidArray(ids: string[]) {
  return sql`${"{" + ids.join(",") + "}"}::uuid[]`;
}

async function collectCandidates(input: BrandTransferInput): Promise<string[]> {
  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = input;
  const brands = targetBrandId ? [sourceBrandId, targetBrandId] : [sourceBrandId];
  const brandArray = sql`${"{" + brands.join(",") + "}"}::text[]`;

  const rows = await db.execute(sql`
    WITH brand_campaigns AS (
      SELECT DISTINCT campaign_id
        FROM runs
       WHERE brand_ids && ${brandArray}
         AND organization_id IN (${sourceOrgId}::uuid, ${targetOrgId}::uuid)
         AND campaign_id IS NOT NULL
    )
    SELECT id FROM runs
     WHERE organization_id = ${sourceOrgId}::uuid
       AND brand_ids && ARRAY[${sourceBrandId}]::text[]
    UNION
    SELECT r.id FROM runs r
     WHERE r.organization_id = ${sourceOrgId}::uuid
       AND (r.brand_ids IS NULL OR cardinality(r.brand_ids) = 0)
       AND r.campaign_id IN (SELECT campaign_id FROM brand_campaigns)
  `);
  return (rows as unknown as { id: string }[]).map((r) => r.id);
}

async function moveChunk(input: BrandTransferInput, ids: string[]) {
  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = input;

  return db.transaction(async (tx) => {
    const brandSet = targetBrandId
      ? sql`array_replace(brand_ids, ${sourceBrandId}, ${targetBrandId})`
      : sql`brand_ids`;

    const moved = (await tx.execute(sql`
      UPDATE runs
         SET organization_id = ${targetOrgId}::uuid,
             brand_ids = ${brandSet},
             updated_at = now()
       WHERE id = ANY(${uuidArray(ids)})
         AND organization_id = ${sourceOrgId}::uuid
      RETURNING id
    `)) as unknown as { id: string }[];

    if (moved.length === 0) {
      return { runsMoved: 0, costsMoved: 0, eventsMoved: 0 };
    }
    const movedIds = uuidArray(moved.map((r) => r.id));

    // Frozen BEFORE the cost org moves. projected = what org-usage-total counts
    // (keyed on the cost row's own org); actual = what org_actual_totals counts
    // (committed rows of settled runs, keyed on the run's org, which just moved).
    const [sums] = (await tx.execute(sql`
      SELECT
        COALESCE(SUM(rc.total_cost_in_usd_cents)
          FILTER (WHERE rc.is_platform_projected AND rc.organization_id = ${sourceOrgId}::uuid), 0)::text AS projected_gross,
        COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents))
          FILTER (WHERE rc.is_platform_projected AND rc.organization_id = ${sourceOrgId}::uuid), 0)::text AS projected_net,
        COALESCE(SUM(rc.total_cost_in_usd_cents)
          FILTER (WHERE rc.is_platform_committed AND r.status IN ('completed', 'failed')), 0)::text AS actual_gross,
        COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents))
          FILTER (WHERE rc.is_platform_committed AND r.status IN ('completed', 'failed')), 0)::text AS actual_net
        FROM runs_costs rc
        JOIN runs r ON r.id = rc.run_id
       WHERE rc.run_id = ANY(${movedIds})
    `)) as unknown as {
      projected_gross: string;
      projected_net: string;
      actual_gross: string;
      actual_net: string;
    }[];

    const costs = (await tx.execute(sql`
      UPDATE runs_costs
         SET organization_id = ${targetOrgId}::uuid
       WHERE run_id = ANY(${movedIds})
         AND organization_id = ${sourceOrgId}::uuid
      RETURNING id
    `)) as unknown as unknown[];

    const eventBrands = targetBrandId
      ? sql`CASE WHEN brand_ids IS NULL THEN NULL
                 ELSE array_to_string(array_replace(string_to_array(brand_ids, ','), ${sourceBrandId}, ${targetBrandId}), ',') END`
      : sql`brand_ids`;
    const events = (await tx.execute(sql`
      UPDATE run_events
         SET org_id = ${targetOrgId}::uuid,
             brand_ids = ${eventBrands}
       WHERE run_id = ANY(${movedIds})
         AND org_id = ${sourceOrgId}::uuid
      RETURNING id
    `)) as unknown as unknown[];

    await tx.execute(sql`
      INSERT INTO brand_transfer_moves (
        source_org_id, source_brand_id, target_org_id, target_brand_id,
        runs_moved, costs_moved, events_moved,
        projected_gross_cents, projected_net_cents, actual_gross_cents, actual_net_cents
      ) VALUES (
        ${sourceOrgId}::uuid, ${sourceBrandId}, ${targetOrgId}::uuid, ${targetBrandId ?? null},
        ${moved.length}, ${costs.length}, ${events.length},
        ${sums.projected_gross}::numeric, ${sums.projected_net}::numeric,
        ${sums.actual_gross}::numeric, ${sums.actual_net}::numeric
      )
    `);

    return { runsMoved: moved.length, costsMoved: costs.length, eventsMoved: events.length };
  });
}

export async function transferBrand(input: BrandTransferInput): Promise<BrandTransferResult> {
  const candidates = await collectCandidates(input);

  const result: BrandTransferResult = {
    runsMoved: 0,
    runsBrandRewrittenElsewhere: 0,
    costsMoved: 0,
    eventsMoved: 0,
  };

  for (let i = 0; i < candidates.length; i += TRANSFER_CHUNK_SIZE) {
    const chunk = await moveChunk(input, candidates.slice(i, i + TRANSFER_CHUNK_SIZE));
    result.runsMoved += chunk.runsMoved;
    result.costsMoved += chunk.costsMoved;
    result.eventsMoved += chunk.eventsMoved;
  }

  // The brand id itself changed: rewrite the remaining references (other orgs,
  // or a run already moved by an earlier call without targetBrandId).
  if (input.targetBrandId) {
    for (;;) {
      const rewritten = (await db.execute(sql`
        UPDATE runs
           SET brand_ids = array_replace(brand_ids, ${input.sourceBrandId}, ${input.targetBrandId}),
               updated_at = now()
         WHERE id IN (
           SELECT id FROM runs
            WHERE brand_ids && ARRAY[${input.sourceBrandId}]::text[]
            LIMIT ${TRANSFER_CHUNK_SIZE}
         )
           AND brand_ids && ARRAY[${input.sourceBrandId}]::text[]
        RETURNING id
      `)) as unknown as unknown[];
      result.runsBrandRewrittenElsewhere += rewritten.length;
      if (rewritten.length === 0) break;
    }
  }

  return result;
}

export type MovedUsage = {
  sourceOrgId: string;
  sourceBrandId: string;
  targetOrgId: string;
  runsMoved: number;
  costsMoved: number;
  projectedGrossCents: string;
  projectedNetCents: string;
  actualGrossCents: string;
  actualNetCents: string;
  firstMovedAt: string | null;
  lastMovedAt: string | null;
};

export async function movedUsage(sourceOrgId: string, sourceBrandId: string, targetOrgId: string): Promise<MovedUsage> {
  const [row] = (await db.execute(sql`
    SELECT COALESCE(SUM(runs_moved), 0)::int AS runs_moved,
           COALESCE(SUM(costs_moved), 0)::int AS costs_moved,
           COALESCE(SUM(projected_gross_cents), 0)::text AS projected_gross,
           COALESCE(SUM(projected_net_cents), 0)::text AS projected_net,
           COALESCE(SUM(actual_gross_cents), 0)::text AS actual_gross,
           COALESCE(SUM(actual_net_cents), 0)::text AS actual_net,
           MIN(created_at) AS first_at,
           MAX(created_at) AS last_at
      FROM brand_transfer_moves
     WHERE source_org_id = ${sourceOrgId}::uuid
       AND source_brand_id = ${sourceBrandId}
       AND target_org_id = ${targetOrgId}::uuid
  `)) as unknown as {
    runs_moved: number;
    costs_moved: number;
    projected_gross: string;
    projected_net: string;
    actual_gross: string;
    actual_net: string;
    first_at: Date | string | null;
    last_at: Date | string | null;
  }[];

  const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
  return {
    sourceOrgId,
    sourceBrandId,
    targetOrgId,
    runsMoved: row.runs_moved,
    costsMoved: row.costs_moved,
    projectedGrossCents: row.projected_gross,
    projectedNetCents: row.projected_net,
    actualGrossCents: row.actual_gross,
    actualNetCents: row.actual_net,
    firstMovedAt: iso(row.first_at),
    lastMovedAt: iso(row.last_at),
  };
}
