import { describe, it, expect } from "vitest";
import {
  archiveBoundary,
  decodeRows,
  encodeRows,
  objectKey,
  toNdjson,
} from "../../src/services/lifecycle-archive.js";

describe("lifecycle archive helpers (BOX-DISK-1101)", () => {
  it("boundary = UTC midnight of the month's first day minus 90 days (moves monthly)", () => {
    expect(archiveBoundary(new Date("2026-11-02T10:00:00Z")).toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(archiveBoundary(new Date("2026-11-30T23:59:59Z")).toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(archiveBoundary(new Date("2026-12-01T00:00:00Z")).toISOString()).toBe("2026-09-02T00:00:00.000Z");
  });

  it("names objects runs-archive/<table>/<yyyy>/<mm>/<dd>[-partN].ndjson.gz", () => {
    expect(objectKey("run_lifecycle_events", "2026-05-04", 0)).toBe("runs-archive/run_lifecycle_events/2026/05/04.ndjson.gz");
    expect(objectKey("cost_lifecycle_events", "2026-05-04", 2)).toBe("runs-archive/cost_lifecycle_events/2026/05/04-part2.ndjson.gz");
  });

  it("round-trips rows through gzip NDJSON, text and nulls kept exactly", async () => {
    const rows = [
      { id: "a", payload: '{"k": "é\\n\\"x\\""}', occurred_at: "2026-02-02 12:32:23.562899+00", identity: null },
      { id: "b", payload: "{}", occurred_at: "2026-02-02 12:32:23+00", identity: '{"orgId": "o"}' },
    ];
    expect(toNdjson(rows).split("\n")).toHaveLength(3);
    expect(await decodeRows(await encodeRows(rows))).toEqual(rows);
    expect(await decodeRows(await encodeRows([]))).toEqual([]);
  });
});
