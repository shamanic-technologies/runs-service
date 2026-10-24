// The ledger reconciliation (LEDGER-HISTORY-1024-RUNS): GET /internal/outcome-costs/reconciliation.
//
// One read features-service gates on before it prices anything on the ledger
// (owner 2026-10-24: every reader switches at once, the day the ledger
// reconciles). Per UTC day since the first day of spend, fleet-wide:
//
//   spend = declared production + normal loss + unpooled loss + undeclared + support
//
// to the cent on every basis, from the stored days (cost_ledger_days for the
// money, outcome_cost_days for the produced-none split and the consumptions),
// with the share of spend each part holds, which services still spend without
// declaring, and which consumptions still resolve to no producer.
//
//  - declared production: spend carried by the run that declared the outcome (its
//    own subtree's cost, rules 1-3);
//  - normal loss: spend of a run that produced nothing, carried by the units its
//    pipe produced in its campaign that day (rule 2, allocation v3);
//  - unpooled loss: spend of a run of a pipe (workflow slug) whose campaign produced
//    nothing on that pipe that day: stays produced-none under its own campaign,
//    features pools it on the pipe's output;
//  - undeclared: spend of a run with no outcome, no support mark and no pipe: a
//    producer that has not declared yet (the gap the backfills close);
//  - support: spend named apart by its owner (support functions, 0064).
//
// Nothing here is an estimate: every figure is a sum of stored rows.

import { sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { statsDb } from "../db/index.js";
import { ALLOCATION_VERSION, addDays, checkLedgerRow, ledgerCheckInputOf, type Money } from "./outcome-ledger.js";

const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
const BASES = ["gross", "net", "vendor", "unpricedGross"] as const;
type Acc = Record<(typeof BASES)[number], Decimal>;

const acc = (): Acc => ({ gross: new D(0), net: new D(0), vendor: new D(0), unpricedGross: new D(0) });
const addInto = (a: Acc, m: { gross: unknown; net: unknown; vendor: unknown; unpricedGross: unknown }) => {
  for (const k of BASES) a[k] = a[k].plus(new D((m[k] as string | null) ?? "0"));
};
const minus = (a: Acc, b: Acc): Acc => ({ gross: a.gross.minus(b.gross), net: a.net.minus(b.net), vendor: a.vendor.minus(b.vendor), unpricedGross: a.unpricedGross.minus(b.unpricedGross) });
const sumOf = (...xs: Acc[]): Acc => xs.reduce((s, x) => ({ gross: s.gross.plus(x.gross), net: s.net.plus(x.net), vendor: s.vendor.plus(x.vendor), unpricedGross: s.unpricedGross.plus(x.unpricedGross) }), acc());
/** The wire shape of every ledger read (LedgerMoneySchema). */
export interface WireMoney {
  grossCents: string;
  netCents: string;
  vendorCents: string;
  unpricedGrossCents: string;
}
const wire = (a: Acc): WireMoney => ({ grossCents: a.gross.toFixed(10), netCents: a.net.toFixed(10), vendorCents: a.vendor.toFixed(10), unpricedGrossCents: a.unpricedGross.toFixed(10) });
const money = (a: Acc): Money => ({ gross: a.gross.toFixed(10), net: a.net.toFixed(10), vendor: a.vendor.toFixed(10), unpricedGross: a.unpricedGross.toFixed(10) });
const isZero = (a: Acc) => BASES.every((k) => a[k].isZero());
const frac = (part: Decimal, whole: Decimal) => (whole.isZero() ? null : part.div(whole).toDecimalPlaces(10, Decimal.ROUND_HALF_UP).toFixed(10));
const shareOf = (part: Acc, spend: Acc) => ({ gross: frac(part.gross, spend.gross), net: frac(part.net, spend.net) });

export interface ReconciliationParts {
  spend: WireMoney;
  declaredProduction: WireMoney;
  normalLoss: WireMoney;
  unpooledLoss: WireMoney;
  undeclared: WireMoney;
  support: WireMoney;
  /** Standard charges of the day's reuses (no spend behind them; never part of spend). */
  reuseGain: WireMoney;
  /** Σ parts − spend per basis: "0.0000000000" when the day reconciles. */
  differences: WireMoney;
  shares: Record<"declaredProduction" | "normalLoss" | "unpooledLoss" | "undeclared" | "support", { gross: string | null; net: string | null }>;
  consumptions: string;
  unknownProvenance: string;
}

interface DayAcc {
  ledger: Acc;
  allocated: Acc;
  loss: Acc;
  none: Acc;
  reuse: Acc;
  support: Acc;
  unpooled: Acc;
  undeclared: Acc;
  noneFromRows: Acc;
  orgsBalanced: boolean;
  consumptions: Decimal;
  unknown: Decimal;
}

const dayAcc = (): DayAcc => ({
  ledger: acc(), allocated: acc(), loss: acc(), none: acc(), reuse: acc(), support: acc(), unpooled: acc(), undeclared: acc(),
  noneFromRows: acc(), orgsBalanced: true, consumptions: new D(0), unknown: new D(0),
});

function partsOf(a: DayAcc): ReconciliationParts & { balanced: boolean; splitConsistent: boolean } {
  const declared = minus(a.allocated, a.loss);
  const differences = minus(sumOf(declared, a.loss, a.unpooled, a.undeclared, a.support), a.ledger);
  // The two stored sources of produced-none (per-org rows vs per-tag rows) must agree.
  const splitConsistent = isZero(minus(a.noneFromRows, a.none));
  return {
    spend: wire(a.ledger),
    declaredProduction: wire(declared),
    normalLoss: wire(a.loss),
    unpooledLoss: wire(a.unpooled),
    undeclared: wire(a.undeclared),
    support: wire(a.support),
    reuseGain: wire(a.reuse),
    differences: wire(differences),
    shares: {
      declaredProduction: shareOf(declared, a.ledger),
      normalLoss: shareOf(a.loss, a.ledger),
      unpooledLoss: shareOf(a.unpooled, a.ledger),
      undeclared: shareOf(a.undeclared, a.ledger),
      support: shareOf(a.support, a.ledger),
    },
    consumptions: a.consumptions.toFixed(10),
    unknownProvenance: a.unknown.toFixed(10),
    balanced: a.orgsBalanced && isZero(differences) && splitConsistent,
    splitConsistent,
  };
}

export interface DayStatus {
  daysMissing: string[];
  daysStale: string[];
  supportDaysMissing: string[];
}

export async function readReconciliation(since: string, until: string, status: DayStatus) {
  const ledgerRows = (await statsDb.execute(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day,
           ledger_gross::text, ledger_net::text, ledger_vendor::text, ledger_unpriced_gross::text,
           allocated_gross::text, allocated_net::text, allocated_vendor::text, allocated_unpriced_gross::text,
           none_gross::text, none_net::text, none_vendor::text, none_unpriced_gross::text,
           reuse_gross::text, reuse_net::text, reuse_vendor::text, reuse_unpriced_gross::text,
           loss_gross::text, loss_net::text, loss_vendor::text, loss_unpriced_gross::text,
           support_by_function
    FROM cost_ledger_days
    WHERE allocation_version = ${ALLOCATION_VERSION} AND day BETWEEN ${since}::date AND ${until}::date
  `)) as any[];
  // Produced-none split by the spending run's tags: support (named), unpooled loss
  // (a pipe), undeclared (neither), per day and per spending service.
  const noneRows = (await statsDb.execute(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, service_name,
           CASE WHEN support_function IS NOT NULL THEN 'support' WHEN workflow_slug IS NOT NULL THEN 'unpooled' ELSE 'undeclared' END AS part,
           SUM(gross)::text AS gross, SUM(net)::text AS net, SUM(vendor)::text AS vendor, SUM(unpriced_gross)::text AS unpriced, SUM(n)::text AS runs
    FROM outcome_cost_days
    WHERE allocation_version = ${ALLOCATION_VERSION} AND kind = 'none' AND day BETWEEN ${since}::date AND ${until}::date
    GROUP BY 1, 2, 3
  `)) as any[];
  const consumedRows = (await statsDb.execute(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, consumed_outcome_key, service_name,
           SUM(n)::text AS n, SUM(unknown_provenance)::text AS unknown
    FROM outcome_cost_days
    WHERE allocation_version = ${ALLOCATION_VERSION} AND kind = 'consumed' AND day BETWEEN ${since}::date AND ${until}::date
    GROUP BY 1, 2, 3
  `)) as any[];

  const days = new Map<string, DayAcc>();
  const dayOf = (d: string) => days.get(d) ?? days.set(d, dayAcc()).get(d)!;
  const m = (r: any, p: string) => ({ gross: r[`${p}_gross`], net: r[`${p}_net`], vendor: r[`${p}_vendor`], unpricedGross: r[`${p}_unpriced_gross`] });
  for (const r of ledgerRows) {
    const a = dayOf(r.day);
    addInto(a.ledger, m(r, "ledger"));
    addInto(a.allocated, m(r, "allocated"));
    addInto(a.none, m(r, "none"));
    addInto(a.reuse, m(r, "reuse"));
    addInto(a.loss, m(r, "loss"));
    for (const v of Object.values((r.support_by_function ?? {}) as Record<string, any>)) addInto(a.support, v);
    const check = checkLedgerRow(
      ledgerCheckInputOf({
        ledger: money(fromRow(m(r, "ledger"))),
        allocated: money(fromRow(m(r, "allocated"))),
        producedNone: money(fromRow(m(r, "none"))),
        reuse: money(fromRow(m(r, "reuse"))),
      }),
    );
    if (!check.balanced) a.orgsBalanced = false;
  }
  type Svc = { unpooled: Acc; undeclared: Acc; support: Acc; undeclaredRuns: Decimal; unpooledRuns: Decimal };
  const services = new Map<string, Svc>();
  for (const r of noneRows) {
    const a = dayOf(r.day);
    const money = { gross: r.gross, net: r.net, vendor: r.vendor, unpricedGross: r.unpriced };
    addInto(a.noneFromRows, money);
    if (r.part === "unpooled") addInto(a.unpooled, money);
    if (r.part === "undeclared") addInto(a.undeclared, money);
    const name = (r.service_name as string | null) ?? "";
    const s = services.get(name) ?? services.set(name, { unpooled: acc(), undeclared: acc(), support: acc(), undeclaredRuns: new D(0), unpooledRuns: new D(0) }).get(name)!;
    if (r.part === "unpooled") {
      addInto(s.unpooled, money);
      s.unpooledRuns = s.unpooledRuns.plus(r.runs);
    } else if (r.part === "undeclared") {
      addInto(s.undeclared, money);
      s.undeclaredRuns = s.undeclaredRuns.plus(r.runs);
    } else addInto(s.support, money);
  }
  const provenance = new Map<string, { consumedOutcomeKey: string; serviceName: string | null; consumptions: Decimal; unknown: Decimal }>();
  for (const r of consumedRows) {
    const a = dayOf(r.day);
    a.consumptions = a.consumptions.plus(r.n);
    a.unknown = a.unknown.plus(r.unknown);
    const k = JSON.stringify([r.consumed_outcome_key, r.service_name]);
    const p = provenance.get(k) ?? provenance.set(k, { consumedOutcomeKey: r.consumed_outcome_key, serviceName: r.service_name ?? null, consumptions: new D(0), unknown: new D(0) }).get(k)!;
    p.consumptions = p.consumptions.plus(r.n);
    p.unknown = p.unknown.plus(r.unknown);
  }

  const missing = new Set(status.daysMissing);
  const total = dayAcc();
  const dayRows = [];
  for (let d = since; d <= until; d = addDays(d, 1)) {
    const a = days.get(d) ?? dayAcc();
    if (!missing.has(d)) {
      for (const k of ["ledger", "allocated", "loss", "none", "reuse", "support", "unpooled", "undeclared", "noneFromRows"] as const) total[k] = sumOf(total[k], a[k]);
      total.orgsBalanced &&= a.orgsBalanced;
      total.consumptions = total.consumptions.plus(a.consumptions);
      total.unknown = total.unknown.plus(a.unknown);
    }
    const p = partsOf(a);
    dayRows.push({ day: d, stored: !missing.has(d), stale: status.daysStale.includes(d), ...p });
  }
  const totals = partsOf(total);
  const stored = dayRows.filter((r) => r.stored);
  const balanced = stored.every((r) => r.balanced);
  const complete = status.daysMissing.length === 0 && status.supportDaysMissing.length === 0;
  const unknownTotal = new D(totals.unknownProvenance);
  const declarationsComplete = new D(totals.undeclared.grossCents).isZero() && unknownTotal.isZero();
  return {
    allocationVersion: ALLOCATION_VERSION,
    since,
    until,
    reconciled: balanced && complete && declarationsComplete,
    balanced,
    complete,
    declarationsComplete,
    daysMissing: status.daysMissing,
    daysStale: status.daysStale,
    supportDaysMissing: status.supportDaysMissing,
    unbalancedDays: stored.filter((r) => !r.balanced).map((r) => r.day),
    totals: { ...totals, unknownProvenanceShare: frac(unknownTotal, new D(totals.consumptions)) },
    services: [...services.entries()]
      .map(([name, s]) => ({
        serviceName: name === "" ? null : name,
        undeclared: wire(s.undeclared),
        undeclaredRuns: s.undeclaredRuns.toNumber(),
        unpooledLoss: wire(s.unpooled),
        unpooledLossRuns: s.unpooledRuns.toNumber(),
        support: wire(s.support),
        undeclaredShareOfSpend: frac(s.undeclared.gross, new D(totals.spend.grossCents)),
      }))
      .sort((a, b) => new D(b.undeclared.grossCents).cmp(a.undeclared.grossCents) || (a.serviceName ?? "").localeCompare(b.serviceName ?? "")),
    provenance: [...provenance.values()]
      .map((p) => ({
        consumedOutcomeKey: p.consumedOutcomeKey,
        consumingServiceName: p.serviceName,
        consumptions: p.consumptions.toFixed(10),
        unknownProvenance: p.unknown.toFixed(10),
        unknownShare: frac(p.unknown, p.consumptions),
      }))
      .sort((a, b) => new D(b.unknownProvenance).cmp(a.unknownProvenance) || a.consumedOutcomeKey.localeCompare(b.consumedOutcomeKey)),
    days: dayRows,
  };
}

const fromRow = (m: { gross: unknown; net: unknown; vendor: unknown; unpricedGross: unknown }): Acc => {
  const a = acc();
  addInto(a, m);
  return a;
};
