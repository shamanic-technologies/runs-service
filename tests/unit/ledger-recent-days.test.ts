import { describe, it, expect } from "vitest";
import { recentDaysDue } from "../../src/services/outcome-ledger.js";

describe("recentDaysDue", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  it("today always; yesterday and the day before only when missing or older than an hour", () => {
    expect(recentDaysDue("2026-10-24", new Map(), now)).toEqual(["2026-10-24", "2026-10-23", "2026-10-22"]);
    const fresh = new Map([["2026-10-24", ago(1)], ["2026-10-23", ago(10)], ["2026-10-22", ago(59)]]);
    expect(recentDaysDue("2026-10-24", fresh, now)).toEqual(["2026-10-24"]);
    const old = new Map([["2026-10-23", ago(61)], ["2026-10-22", ago(10)]]);
    expect(recentDaysDue("2026-10-24", old, now)).toEqual(["2026-10-24", "2026-10-23"]);
  });
});
