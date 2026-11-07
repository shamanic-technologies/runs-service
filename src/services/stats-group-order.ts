// Served order of GET /v1/stats/costs and GET /v1/stats/public/costs groups.
//
// Primary order stays what each SQL path already emits: `ORDER BY total_cost
// DESC` (on the TEXT money, see routes/stats.ts). Groups tied on that total came
// back in hash-aggregate order, which differs between the rollup and the live
// query and between two calls (ROLLUP-TIE-FLAKE-1107: the org-task parity test
// flaked on the order of its $0 groups). Consumers render the list as served
// (dashboard / admin cost breakdowns, Sophie's spend per campaign), so the order
// is part of the contract.
//
// TIE-BREAKER: within a run of consecutive groups with the same
// `totalCostInUsdCents`, order by the dimension values, keys in sorted order,
// each compared by UTF-16 code unit, a null dimension last.

export interface OrderedGroup {
  dimensions: Record<string, string | null>;
  totalCostInUsdCents: string;
}

function compareDimensions(a: Record<string, string | null>, b: Record<string, string | null>): number {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) {
    const x = a[k] ?? null;
    const y = b[k] ?? null;
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Sorts each run of equal-total consecutive groups by its dimensions, in place; returns the array. */
export function breakCostTiesByDimensions<T extends OrderedGroup>(groups: T[]): T[] {
  let start = 0;
  while (start < groups.length) {
    let end = start + 1;
    while (end < groups.length && groups[end].totalCostInUsdCents === groups[start].totalCostInUsdCents) end++;
    if (end - start > 1) {
      const tied = groups.slice(start, end).sort((x, y) => compareDimensions(x.dimensions, y.dimensions));
      groups.splice(start, tied.length, ...tied);
    }
    start = end;
  }
  return groups;
}
