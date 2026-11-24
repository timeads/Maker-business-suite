import { describe, it, expect } from "vitest";
import { Money } from "./money";
import { computeAging } from "./aging";
import type { LedgerEntryInput } from "./balance";
import { combineAging, combineSummaries, summarizeVendor } from "./summary";

const D = (n: string | number) => new Money(n);
let seq = 0;
const inv = (date: string, amount: string, reference: string): LedgerEntryInput => ({
  id: `e${++seq}`,
  type: "INVOICE",
  entryDate: new Date(`${date}T00:00:00Z`),
  amount: D(amount),
  statedBalance: null,
  reference,
  description: null,
  source: "MANUAL",
  needsReview: false,
  supersededById: null,
});

const TODAY = new Date("2026-11-04T00:00:00Z");

function vendor(
  name: string,
  balance: string,
  entries: LedgerEntryInput[],
  extra: { review?: number } = {},
) {
  return summarizeVendor({
    supplierId: name.toLowerCase(),
    supplierName: name,
    paymentTermsDays: 30,
    estimatedBalance: balance,
    aging: computeAging(entries, balance, TODAY, 30),
    needsReviewCount: extra.review ?? 0,
    entryCount: entries.length,
  });
}

describe("summarizeVendor", () => {
  it("splits the balance into overdue and not-yet-due, oldest bill first", () => {
    const s = vendor("Pinewood Chemical", "3000.00", [
      inv("2026-09-01", "1000.00", "160735"), // due Oct 1 → 34 days late
      inv("2026-10-20", "2000.00", "162320"), // due Nov 19 → not due
    ]);
    expect(s.balance).toBe("3000.00");
    expect(s.overdue).toBe("1000.00");
    expect(s.overdueBills).toBe(1);
    expect(s.oldest).toMatchObject({ reference: "160735", date: "2026-09-01", daysPastDue: 34 });
    expect(s.empty).toBe(false);
  });

  it("an account with no entries is marked empty, owing nothing", () => {
    const s = vendor("Rosewood", "0", []);
    expect(s).toMatchObject({ balance: "0.00", overdue: "0.00", oldest: null, empty: true });
  });
});

describe("combineSummaries", () => {
  it("adds up what's owed across vendors and the overdue part", () => {
    const all = combineSummaries([
      vendor("Kestrel Outdoors", "5638.17", [inv("2026-10-25", "5638.17", "KST261019")]),
      vendor("Pinewood Chemical", "3000.00", [
        inv("2026-09-01", "1000.00", "160735"),
        inv("2026-10-20", "2000.00", "162320"),
      ]),
      vendor("Rosewood", "1200.50", [inv("2026-09-15", "1200.50", "10070172")]), // due Oct 15, late
    ]);
    expect(all).toEqual({
      owed: "9838.67",
      overdue: "2200.50",
      overdueBills: 2,
      credit: "0.00",
      vendorsOwed: 3,
      vendorsOverdue: 2,
      markedPaid: "0.00",
    });
  });

  it("never nets one vendor's credit against another vendor's bill", () => {
    const all = combineSummaries([
      vendor("Kestrel Outdoors", "-250.00", []),
      vendor("Rosewood", "800.00", [inv("2026-10-27", "800.00", "10070201")]),
    ]);
    expect(all.owed).toBe("800.00");
    expect(all.credit).toBe("250.00");
    expect(all.vendorsOwed).toBe(1);
  });
});

describe("combineAging", () => {
  it("lists every vendor's open bills together, soonest due first, buckets added up", () => {
    const kestrel = computeAging([inv("2026-10-25", "5638.17", "KST261019")], "5638.17", TODAY, 30);
    const ronile = computeAging(
      [inv("2026-09-15", "1200.50", "10070172"), inv("2026-10-27", "546.36", "10070201")],
      "1746.86",
      TODAY,
      30,
    );
    const all = combineAging([
      { vendor: "Kestrel Outdoors", aging: kestrel },
      { vendor: "Rosewood", aging: ronile },
    ]);
    expect(all.bills.map((b) => [b.vendor, b.reference, b.dueDate])).toEqual([
      ["Rosewood", "10070172", "2026-10-15"],
      ["Kestrel Outdoors", "KST261019", "2026-11-24"],
      ["Rosewood", "10070201", "2026-11-26"],
    ]);
    expect(all.openTotal).toBe("7385.03");
    expect(all.buckets.late1to30).toEqual({ amount: "1200.50", count: 1 });
    expect(all.buckets.notDue).toEqual({ amount: "6184.53", count: 2 });
    expect(all.termsDays).toBe(30);
  });
});

describe("dueSchedule", () => {
  const bill = (vendor: string, reference: string, dueDate: string, open: string) => ({
    id: reference,
    vendor,
    reference,
    date: "2026-10-01",
    amount: open,
    open,
    partial: false,
    ageDays: 0,
    dueDate,
    daysPastDue: 0,
  });

  it("groups past-due bills first, then by week with a total per week (today Wed Nov 4)", async () => {
    const { dueSchedule } = await import("./summary");
    const groups = dueSchedule(
      [
        bill("Kestrel Outdoors", "KST261019", "2026-11-24", "2816.90"),
        bill("Rosewood", "10070172", "2026-11-21", "545.39"),
        bill("Kestrel Outdoors", "KST261008", "2026-11-17", "1922.87"),
        bill("Pinewood Chemical", "162320", "2026-11-19", "1175.89"),
        bill("Rosewood", "OLD", "2026-11-02", "100.00"),
        bill("Rosewood", "SOON", "2026-11-08", "50.00"),
        bill("Rosewood", "NEXT", "2026-11-09", "25.00"),
      ],
      "2026-11-04",
    );
    expect(groups.map((g) => [g.label, g.total, g.bills.map((b) => b.reference)])).toEqual([
      ["Past due", "100.00", ["OLD"]],
      ["This week · Nov 2 – Nov 8", "50.00", ["SOON"]],
      ["Next week · Nov 9 – Nov 15", "25.00", ["NEXT"]],
      ["Week of Nov 16 – Nov 22", "3644.15", ["KST261008", "162320", "10070172"]],
      ["Week of Nov 23 – Nov 29", "2816.90", ["KST261019"]],
    ]);
    expect(groups[0]!.overdue).toBe(true);
  });

  it("bills ticked 'Paid' are shown but not counted as still to pay", async () => {
    const { dueSchedule } = await import("./summary");
    const [week] = dueSchedule(
      [
        {
          ...bill("Rosewood", "10070201", "2026-11-26", "546.36"),
          paymentSentAt: "2026-11-13T15:00:00Z",
        },
        bill("Rosewood", "10070200", "2026-11-26", "482.53"),
      ],
      "2026-11-16",
    );
    expect(week).toMatchObject({ total: "482.53", paid: "546.36" });
    expect(week!.bills).toHaveLength(2);
  });

  it("a bill due today is this week, not past due", async () => {
    const { dueSchedule } = await import("./summary");
    expect(
      dueSchedule([bill("Rosewood", "T", "2026-11-04", "1.00")], "2026-11-04")[0]!.overdue,
    ).toBe(false);
  });
});
