import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The live-day LATERAL of the brand rollup read must stay an optimisation fence.
// Without `OFFSET 0` Postgres pulled it up and joined the brand's whole bounded
// history to runs_costs before seeing that live_days was empty: 11-21 s for brand
// f4d73dab (25 feature slugs + startedBefore), statement timeouts in prod
// (2026-10-21). Fenced: 0.05-0.2 s, same rows (md5-equal on prod).
describe("brand rollup live-day LATERAL fence", () => {
  const src = readFileSync(new URL("../../src/services/stats-rollup-brand.ts", import.meta.url), "utf8");
  const at = src.indexOf("const liveRuns = ");
  const block = src.slice(at, src.indexOf(") x`;", at) + 5);

  it("keeps OFFSET 0 inside the per-day subquery", () => {
    expect(at).toBeGreaterThan(-1);
    expect(block).toContain("CROSS JOIN LATERAL (");
    expect(block).toMatch(/OFFSET 0\s*\n\s*\) x`;$/);
  });
});
