// Backfill side of `run_campaign_entries` (migration 0040): the entry runs of
// every campaign — a run carrying a campaign whose parent is not a run of that
// same campaign. Triggers keep it current from the migration on; this fills in
// the runs that existed before, then stamps `campaign_entry` so
// GET /v1/stats/run-outcomes (scope=entry, with a campaign filter) reads it.
//
// No lock. One short transaction per started_at window, `ON CONFLICT DO NOTHING`:
// a row a trigger wrote meanwhile carries the run's newer values and is kept; a
// trigger that fires while a window is in flight waits on its uncommitted row and
// then overwrites it with its own values. Membership never depends on timing:
// a run's campaign and its parent's never change in practice, and when one does
// the trigger recomputes the run and its children. Re-runnable at any time.

import postgres from "postgres";

export const CAMPAIGN_ENTRY_ROLLUP_NAME = "campaign_entry";

const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function backfillRunCampaignEntries(
  url: string,
  log: (line: string) => void = () => undefined,
): Promise<{ inserted: number; windows: number }> {
  const db = postgres(url, { max: 1, connect_timeout: 10, connection: { jit: "off" } });
  try {
    const [{ min, max }] = await db`SELECT MIN(started_at) AS min, MAX(started_at) AS max FROM runs`;
    let inserted = 0;
    let windows = 0;
    if (min) {
      const end = new Date(max).getTime();
      for (let from = new Date(min).getTime(); from <= end; from += WINDOW_MS) {
        const lo = new Date(from).toISOString();
        const hi = new Date(from + WINDOW_MS).toISOString();
        const res = await db`
          INSERT INTO run_campaign_entries (
            run_id, campaign_id, organization_id, brand_ids, feature_slug, workflow_slug,
            service_name, task_name, status, started_at, completed_at
          )
          SELECT r.id, r.campaign_id, r.organization_id, r.brand_ids, r.feature_slug, r.workflow_slug,
            r.service_name, r.task_name, r.status, r.started_at, r.completed_at
          FROM runs r
          WHERE r.started_at >= ${lo}::timestamptz AND r.started_at < ${hi}::timestamptz
            AND r.campaign_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM runs p WHERE p.id = r.parent_run_id AND p.campaign_id = r.campaign_id
            )
          ON CONFLICT (run_id) DO NOTHING
        `;
        inserted += res.count;
        windows += 1;
        if (res.count > 0) log(`${lo.slice(0, 10)}: +${res.count}`);
      }
    }
    await db`
      INSERT INTO stats_rollups (name, ready_at) VALUES (${CAMPAIGN_ENTRY_ROLLUP_NAME}, now())
      ON CONFLICT (name) DO UPDATE SET ready_at = EXCLUDED.ready_at
    `;
    return { inserted, windows };
  } finally {
    await db.end();
  }
}
