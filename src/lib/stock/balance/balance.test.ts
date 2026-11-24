import { describe, it, expect } from "vitest";
import { Money } from "./money";
import {
  computeVendorBalance,
  auditStatements,
  balanceHistory,
  type LedgerEntryInput,
  type LedgerType,
  type LedgerSource,
} from "./balance";

let seq = 0;
function entry(
  type: LedgerType,
  date: string,
  amount: number,
  extra: Partial<LedgerEntryInput> = {},
): LedgerEntryInput {
  return {
    id: `e${++seq}`,
    type,
    entryDate: new Date(`${date}T00:00:00Z`),
    amount: new Money(amount),
    statedBalance: null,
    reference: null,
    description: null,
    source: "KARIDA_EMAIL" as LedgerSource,
    needsReview: false,
    supersededById: null,
    ...extra,
  };
}

function statement(date: string, balance: number): LedgerEntryInput {
  return entry("STATEMENT", date, balance, { statedBalance: new Money(balance) });
}

const ASOF = new Date("2026-07-08T00:00:00Z");

describe("computeVendorBalance", () => {
  // A July 8 2026 Kestrel statement, reproduced exactly:
  // $21,871.38 (May 21 anchor) − $28,000 payments + $18,649.40 invoices = $12,520.78
  it("reproduces Kestrel's stated July 8 balance from the May 21 anchor", () => {
    const entries = [
      statement("2026-05-21", 21871.38),
      entry("PAYMENT", "2026-06-03", 10000),
      entry("PAYMENT", "2026-06-17", 10000),
      entry("PAYMENT", "2026-07-03", 8000),
      entry("INVOICE", "2026-07-08", 3592.8, { reference: "KA-202607-YARN" }),
      entry("INVOICE", "2026-07-08", 11848.0, { reference: "KA-835CB5" }),
      entry("INVOICE", "2026-07-08", 936.6, { reference: "KST260612" }),
      entry("INVOICE", "2026-07-08", 2272.0, { reference: "KST260702" }),
    ];
    const r = computeVendorBalance(entries, ASOF);
    expect(r.anchor?.statedBalance).toBe("21871.38");
    expect(r.paymentsSince).toBe("28000.00");
    expect(r.invoicesSince).toBe("18649.40");
    expect(r.estimatedBalance).toBe("12520.78");
    expect(r.daysSinceStatement).toBe(48);
  });

  it("uses the most recent statement as the anchor and ignores older ones", () => {
    const entries = [
      statement("2026-04-15", 16786.38),
      statement("2026-05-21", 21871.38),
      entry("PAYMENT", "2026-06-03", 10000),
    ];
    const r = computeVendorBalance(entries, ASOF);
    expect(r.anchor?.date).toBe("2026-05-21T00:00:00.000Z");
    expect(r.estimatedBalance).toBe("11871.38");
  });

  it("sums invoices minus payments when there is no statement yet", () => {
    const entries = [
      entry("INVOICE", "2026-06-01", 5000),
      entry("INVOICE", "2026-06-10", 2500),
      entry("PAYMENT", "2026-06-20", 3000),
    ];
    const r = computeVendorBalance(entries, ASOF);
    expect(r.anchor).toBeNull();
    expect(r.estimatedBalance).toBe("4500.00");
    expect(r.daysSinceStatement).toBeNull();
  });

  it("excludes superseded entries (the Nov 7 -> Nov 20 invoice correction)", () => {
    // Kestrel first billed $1,566.00 for KST251021-8, then corrected it to $546.00.
    const wrong = entry("INVOICE", "2025-10-21", 1566.0, {
      reference: "KST251021-8",
      supersededById: "corrected",
    });
    const right = entry("INVOICE", "2025-10-21", 546.0, { reference: "KST251021-8" });
    const r = computeVendorBalance([wrong, right], ASOF);
    expect(r.estimatedBalance).toBe("546.00");
    expect(r.entriesSince).toHaveLength(1);
  });

  it("ignores activity dated after asOf", () => {
    const entries = [
      statement("2026-05-21", 21871.38),
      entry("INVOICE", "2026-08-01", 5000), // after asOf
    ];
    const r = computeVendorBalance(entries, ASOF);
    expect(r.estimatedBalance).toBe("21871.38");
    expect(r.entriesSince).toHaveLength(0);
  });

  it("treats a negative ADJUSTMENT as a credit against the balance", () => {
    const entries = [
      statement("2026-05-21", 21871.38),
      entry("ADJUSTMENT", "2026-06-01", -3338.36, { description: "credit balance" }),
    ];
    const r = computeVendorBalance(entries, ASOF);
    expect(r.adjustmentsSince).toBe("-3338.36");
    expect(r.estimatedBalance).toBe("18533.02");
  });

  it("flags a wire sent just before the statement that the vendor hasn't recorded", () => {
    // Wired 7/31; statement written 8/01 before Kestrel logged receipt on 8/03.
    const entries = [
      entry("PAYMENT", "2026-07-31", 8000, { source: "WELLS_FARGO_EMAIL" }),
      statement("2026-08-01", 20000),
    ];
    const r = computeVendorBalance(entries, new Date("2026-08-05T00:00:00Z"));
    expect(r.paymentsPossiblyUnreflected).toHaveLength(1);
    expect(r.paymentsPossiblyUnreflected[0]!.amount).toBe("8000.00");
    // Not silently subtracted — the stated balance stands until the vendor confirms.
    expect(r.estimatedBalance).toBe("20000.00");
  });

  it("does not flag a wire the vendor already reported receiving", () => {
    const entries = [
      entry("PAYMENT", "2026-07-31", 8000, { source: "WELLS_FARGO_EMAIL" }),
      entry("PAYMENT", "2026-08-03", 8000, { source: "KARIDA_EMAIL" }),
      statement("2026-08-06", 20000),
    ];
    const r = computeVendorBalance(entries, new Date("2026-08-10T00:00:00Z"));
    expect(r.paymentsPossiblyUnreflected).toHaveLength(0);
  });

  it("counts a vendor-confirmed wire once, not once per source", () => {
    // Wired 08/07 ($15,000); Kestrel's statement records it received on 08/10.
    const entries = [
      statement("2026-08-06", 18803.5),
      entry("PAYMENT", "2026-08-07", 15000, { source: "WELLS_FARGO_EMAIL" }),
      entry("PAYMENT", "2026-08-10", 15000, { source: "KARIDA_EMAIL" }),
    ];
    const r = computeVendorBalance(entries, new Date("2026-08-20T00:00:00Z"));
    expect(r.paymentsSince).toBe("15000.00");
    expect(r.estimatedBalance).toBe("3803.50");
  });

  it("keeps two genuinely separate wires of the same amount", () => {
    const entries = [
      statement("2026-08-06", 30000),
      entry("PAYMENT", "2026-08-07", 5000, { source: "WELLS_FARGO_EMAIL" }),
      entry("PAYMENT", "2026-08-08", 5000, { source: "WELLS_FARGO_EMAIL" }),
      entry("PAYMENT", "2026-08-10", 5000, { source: "KARIDA_EMAIL" }),
    ];
    // One bank row is absorbed by the vendor's record; the other still counts.
    const r = computeVendorBalance(entries, new Date("2026-08-20T00:00:00Z"));
    expect(r.paymentsSince).toBe("10000.00");
  });

  it("counts entries needing review", () => {
    const entries = [
      statement("2026-05-21", 21871.38),
      entry("INVOICE", "2026-06-01", 900, { needsReview: true }),
    ];
    expect(computeVendorBalance(entries, ASOF).needsReviewCount).toBe(1);
  });

  it("returns activity since the anchor newest-first", () => {
    const entries = [
      statement("2026-05-21", 100),
      entry("INVOICE", "2026-06-01", 10),
      entry("PAYMENT", "2026-07-01", 20),
    ];
    const r = computeVendorBalance(entries, ASOF);
    expect(r.entriesSince.map((e) => e.type)).toEqual(["PAYMENT", "INVOICE"]);
  });
});

describe("auditStatements", () => {
  // A July 8 -> Aug 6 2026 chain. Kestrel's own arithmetic is 20 cents high:
  // 12,520.78 − 8,000 − 2,366.56 = 2,154.22, but the email says 2,154.42,
  // which carries into the stated total of 18,803.50 (should be 18,803.30).
  it("catches the 20-cent drift in Kestrel's Aug 6 statement", () => {
    const entries = [
      statement("2026-07-08", 12520.78),
      entry("PAYMENT", "2026-08-03", 8000),
      entry("ADJUSTMENT", "2026-08-05", -2366.56, {
        description: "161kg wool yarn detained by customs — invoice credited back",
      }),
      entry("INVOICE", "2026-08-06", 5103.0, { reference: "KA-202607-YARN" }),
      entry("INVOICE", "2026-08-06", 6122.8, { reference: "KST260708" }),
      entry("INVOICE", "2026-08-06", 4518.0, { reference: "KST260716" }),
      entry("INVOICE", "2026-08-06", 905.28, { reference: "KST260803" }),
      statement("2026-08-06", 18803.5),
    ];
    const audits = auditStatements(entries);
    expect(audits).toHaveLength(1);
    const a = audits[0]!;
    expect(a.previousBalance).toBe("12520.78");
    expect(a.payments).toBe("8000.00");
    expect(a.adjustments).toBe("-2366.56");
    expect(a.invoices).toBe("16649.08");
    expect(a.computedBalance).toBe("18803.30");
    expect(a.statedBalance).toBe("18803.50");
    expect(a.delta).toBe("0.20");
  });

  it("reports a zero delta when the vendor's math ties out", () => {
    const entries = [
      statement("2026-05-21", 21871.38),
      entry("PAYMENT", "2026-06-03", 10000),
      entry("PAYMENT", "2026-06-17", 10000),
      entry("PAYMENT", "2026-07-03", 8000),
      entry("INVOICE", "2026-07-08", 18649.4),
      statement("2026-07-08", 12520.78),
    ];
    const audits = auditStatements(entries);
    expect(audits[0]!.delta).toBe("0.00");
  });

  it("returns nothing when there is only one statement to go on", () => {
    expect(auditStatements([statement("2026-07-08", 100)])).toEqual([]);
  });

  it("skips gaps with no captured line items instead of crying drift", () => {
    // Backfilled history: balances known, the invoices behind them are not.
    const entries = [statement("2025-09-17", 13745.25), statement("2025-09-30", 18519.25)];
    expect(auditStatements(entries)).toEqual([]);
  });
});

describe("balanceHistory", () => {
  it("charts each stated balance plus the current estimate", () => {
    const entries = [
      statement("2026-04-15", 16786.38),
      statement("2026-05-21", 21871.38),
      entry("PAYMENT", "2026-06-03", 10000),
    ];
    const pts = balanceHistory(entries, ASOF);
    expect(pts).toHaveLength(3);
    expect(pts[0]).toMatchObject({ balance: "16786.38", stated: true });
    expect(pts[1]).toMatchObject({ balance: "21871.38", stated: true });
    expect(pts[2]).toMatchObject({ balance: "11871.38", stated: false });
  });
});
