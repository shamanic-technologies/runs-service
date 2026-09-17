export type DatabaseStatus = "ok" | "slow" | "unreachable";

/**
 * Health must never queue behind the pool.
 *
 * `/health` runs `SELECT 1` through the same postgres.js pool as every other
 * query, so when the pool is saturated by the org-spend aggregations the probe
 * waits for a free connection instead of answering. The health watchdog's own
 * probe times out at 10s and reports `ERR` — a hang, not a 503 — so a busy pool
 * is indistinguishable from a dead service and nothing in the response says
 * which one it is.
 *
 * Racing the query against a short budget makes the busy case say so: the
 * route answers `slow` in ~2s instead of hanging. The abandoned query keeps
 * running on its own connection; its rejection is caught so it cannot surface
 * as an unhandled rejection after the race is decided.
 */
export async function probeDatabase(
  query: () => Promise<unknown>,
  timeoutMs: number,
): Promise<DatabaseStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const probe = query().then(
    (): DatabaseStatus => "ok",
    (err): DatabaseStatus => {
      console.error("[runs-service] health probe failed:", err);
      return "unreachable";
    },
  );

  const budget = new Promise<DatabaseStatus>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `[runs-service] health probe exceeded ${timeoutMs}ms — connection pool is saturated`,
      );
      resolve("slow");
    }, timeoutMs);
  });

  try {
    return await Promise.race([probe, budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
