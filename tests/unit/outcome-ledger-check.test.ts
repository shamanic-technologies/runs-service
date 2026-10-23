import { describe, it, expect } from "vitest";
import { checkLedgerRow, normalizeOutcomeKey, addDays } from "../../src/services/outcome-ledger.js";

// The to-the-cent check is EXACT: no tolerance, every basis.
const m = (gross: string, net = gross, vendor = gross, unpricedGross = "0") => ({ gross, net, vendor, unpricedGross });

describe("checkLedgerRow", () => {
  it("balances when standard - reuse gain + produced none = ledger on every basis", () => {
    const r = checkLedgerRow({
      ledger: m("314.0000000001", "300.5", "62", "4"),
      standard: m("320.0000000001", "296.5", "61", "4"),
      reuseGain: m("20", "6", "1", "0"),
      producedNone: m("14", "10", "2", "0"),
    });
    expect(r.balanced).toBe(true);
    expect(r.differences).toEqual({ gross: "0.0000000000", net: "0.0000000000", vendor: "0.0000000000", unpricedGross: "0.0000000000" });
  });

  it("FAILS on a hand-built fixture one cent off (gross)", () => {
    const r = checkLedgerRow({ ledger: m("100"), standard: m("60"), reuseGain: m("0"), producedNone: { ...m("40"), gross: "41" } });
    expect(r.balanced).toBe(false);
    expect(r.differences.gross).toBe("1.0000000000");
  });

  it("FAILS when only the vendor basis is one cent off", () => {
    const r = checkLedgerRow({ ledger: m("100"), standard: { ...m("70"), vendor: "69" }, reuseGain: m("10"), producedNone: m("40") });
    expect(r.balanced).toBe(false);
    expect(r.differences.vendor).toBe("-1.0000000000");
  });

  it("FAILS on a 1e-10 cent drift (no tolerance)", () => {
    const r = checkLedgerRow({ ledger: m("100"), standard: m("60.0000000001"), reuseGain: m("0"), producedNone: m("40") });
    expect(r.balanced).toBe(false);
  });
});

describe("outcome keys and days", () => {
  it("accepts legacy email_sent and stores message_sent", () => {
    expect(normalizeOutcomeKey("email_sent")).toBe("message_sent");
    expect(normalizeOutcomeKey("email_checked")).toBe("email_checked");
  });
  it("adds UTC days", () => {
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
