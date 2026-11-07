import { describe, it, expect } from "vitest";
import { breakCostTiesByDimensions } from "../../src/services/stats-group-order.js";

const g = (total: string, dimensions: Record<string, string | null>) => ({ totalCostInUsdCents: total, dimensions });

describe("breakCostTiesByDimensions", () => {
  it("keeps the primary order and sorts each tie by dimensions, null last", () => {
    const groups = [
      g("9.0000000000", { serviceName: "z" }),
      g("0.0000000000", { serviceName: null, taskName: "a" }),
      g("0.0000000000", { serviceName: "b", taskName: "x" }),
      g("0.0000000000", { serviceName: "b", taskName: "a" }),
      g("0.0000000000", { serviceName: "a", taskName: null }),
    ];
    const out = breakCostTiesByDimensions(groups).map((x) => [x.totalCostInUsdCents, x.dimensions.serviceName, x.dimensions.taskName]);
    expect(out).toEqual([
      ["9.0000000000", "z", undefined],
      ["0.0000000000", "a", null],
      ["0.0000000000", "b", "a"],
      ["0.0000000000", "b", "x"],
      ["0.0000000000", null, "a"],
    ]);
  });

  it("is independent of the input order of tied groups", () => {
    const a = [g("1.0000000000", { c: "x" }), g("1.0000000000", { c: "y" }), g("1.0000000000", { c: null })];
    const b = [a[2], a[0], a[1]];
    expect(breakCostTiesByDimensions([...b])).toEqual(breakCostTiesByDimensions([...a]));
  });

  it("never reorders across different totals", () => {
    const groups = [g("2.0000000000", { c: "z" }), g("1.0000000000", { c: "a" })];
    expect(breakCostTiesByDimensions([...groups])).toEqual(groups);
  });
});
