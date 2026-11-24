import { describe, it, expect } from "vitest";
import { Money } from "./money";
import { computeAging, bucketFor } from "./aging";
import type { LedgerEntryInput } from "./balance";

let n = 0;
function inv(
  date: string,
  amount: string,
  reference: string,
  extra: Partial<LedgerEntryInput> = {},
): LedgerEntryInput {
  return {
    id: `i${++n}`,
    type: "INVOICE",
    entryDate: new Date(`${date}T00:00:00Z`),
    amount: new Money(amount),
    statedBalance: null,
    reference,
    description: null,
    source: "KARIDA_EMAIL",
    needsReview: false,
    supersededById: null,
    ...extra,
  };
}

const TODAY = new Date("2026-11-03T00:00:00Z");

// An October picture: $5,638.17 owed after the Oct 30 payment.
const OCTOBER = [
  inv("2026-09-29", "9864.65", "KST260916"),
  inv("2026-10-15", "470.50", "KST261009"),
  inv("2026-10-18", "10148.82", "KST261008"),
  inv("2026-10-20", "898.40", "KST261016"),
  inv("2026-10-25", "2816.90", "KST261019"),
];

describe("bill aging (oldest bills paid first)", () => {
  it("the balance is made of the newest bills, the oldest one partly", () => {
    const a = computeAging(OCTOBER, "5638.17", TODAY, 30);
    expect(a.bills.map((b) => [b.reference, b.open, b.partial, b.ageDays, b.dueDate])).toEqual([
      ["KST261008", "1922.87", true, 16, "2026-11-17"],
      ["KST261016", "898.40", false, 14, "2026-11-19"],
      ["KST261019", "2816.90", false, 9, "2026-11-24"],
    ]);
    expect(a.openTotal).toBe("5638.17");
    expect(a.unattributed).toBe("0.00");
    expect(a.buckets.notDue).toEqual({ amount: "5638.17", count: 3 });
  });

  it("ages bills past net 30 into lateness buckets", () => {
    const later = new Date("2026-12-20T00:00:00Z");
    const a = computeAging(OCTOBER, "13500.00", later, 30);
    // KST261019 (Oct 25) is 26 days late, KST261008 (Oct 18) 33 days late.
    const late = Object.fromEntries(a.bills.map((b) => [b.reference, b.daysPastDue]));
    expect(late).toMatchObject({ KST261019: 26, KST261016: 31, KST261008: 33 });
    expect(a.buckets.late1to30.count).toBe(1);
    expect(a.buckets.late31to60.count).toBe(2);
  });

  it("nothing open when the account is settled or in credit", () => {
    expect(computeAging(OCTOBER, "0", TODAY, 30).bills).toEqual([]);
    expect(computeAging(OCTOBER, "-250.00", TODAY, 30).openTotal).toBe("0.00");
  });

  it("reports owed money older than any invoice on record instead of inventing a bill", () => {
    const a = computeAging([inv("2026-10-25", "100.00", "KST261019")], "350.00", TODAY, 30);
    expect(a.bills).toHaveLength(1);
    expect(a.unattributed).toBe("250.00");
  });

  it("ignores superseded invoices and counts a duplicated backfill row once", () => {
    const a = computeAging(
      [
        inv("2026-10-20", "898.40", "KST261016"),
        inv("2026-10-20", "898.40", "KST261016"), // same invoice, second key
        inv("2026-10-25", "999.00", "KST261019", { supersededById: "x" }),
      ],
      "898.40",
      TODAY,
      30,
    );
    expect(a.bills.map((b) => [b.reference, b.open])).toEqual([["KST261016", "898.40"]]);
  });

  it("bucket edges: due today is not late, day 31 / 61 move up", () => {
    expect([0, 1, 30, 31, 60, 61].map(bucketFor)).toEqual([
      "notDue",
      "late1to30",
      "late1to30",
      "late31to60",
      "late31to60",
      "late60plus",
    ]);
  });
});
