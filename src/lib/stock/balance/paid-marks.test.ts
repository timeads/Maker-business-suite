import { describe, it, expect } from "vitest";
import { Money } from "./money";
import { computeAging } from "./aging";
import type { LedgerEntryInput } from "./balance";
import { paidMarks } from "./paid-marks";

const D = (n: string) => new Money(n);
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
let seq = 0;
const entry = (
  type: LedgerEntryInput["type"],
  date: string,
  amount: string,
  extra: Partial<LedgerEntryInput> = {},
): LedgerEntryInput => ({
  id: `e${++seq}`,
  type,
  entryDate: day(date),
  amount: D(amount),
  statedBalance: null,
  reference: null,
  description: null,
  source: "MANUAL",
  needsReview: false,
  supersededById: null,
  ...extra,
});
const inv = (date: string, amount: string, reference: string, markedPaid?: string) =>
  entry("INVOICE", date, amount, {
    reference,
    paymentSentAt: markedPaid ? new Date(`${markedPaid}T15:00:00Z`) : null,
  });

const NOW = new Date("2026-11-16T14:00:00Z");
const run = (entries: LedgerEntryInput[], balance: string) =>
  paidMarks(entries, computeAging(entries, balance, day("2026-11-16"), 30), NOW);

describe("paid marks", () => {
  it("a bill ticked Friday, no payment yet: waiting", () => {
    const r = run(
      [
        inv("2026-10-14", "545.39", "10070172", "2026-11-13"),
        inv("2026-10-27", "482.53", "10070200"),
      ],
      "1027.92",
    );
    expect(r.waiting).toEqual([
      expect.objectContaining({
        reference: "10070172",
        state: "waiting",
        note: "Paid Nov 13 · waiting for the payment to show up",
      }),
    ]);
    expect(r.waitingTotal).toBe("545.39");
    expect(r.confirmed).toEqual([]);
  });

  it("the payment posts and clears it: confirmed, with that payment", () => {
    const r = run(
      [
        inv("2026-10-14", "545.39", "10070172", "2026-11-13"),
        inv("2026-10-27", "482.53", "10070200"),
        entry("PAYMENT", "2026-11-13", "545.39"),
      ],
      "482.53",
    );
    expect(r.waiting).toEqual([]);
    expect(r.confirmed).toEqual([
      expect.objectContaining({
        reference: "10070172",
        payment: { date: "2026-11-13", amount: "545.39" },
      }),
    ]);
  });

  it("one wire for three Kestrel bills (some not due yet) confirms all three", () => {
    const entries = [
      inv("2026-10-18", "1922.87", "KST261008", "2026-11-14"),
      inv("2026-10-20", "898.40", "KST261016", "2026-11-14"),
      inv("2026-10-25", "2816.90", "KST261019", "2026-11-14"),
      inv("2026-11-10", "847.60", "KST261105"),
      entry("PAYMENT", "2026-11-14", "5638.17"),
    ];
    const r = run(entries, "847.60");
    expect(r.confirmed.map((c) => c.reference).sort()).toEqual([
      "KST261008",
      "KST261016",
      "KST261019",
    ]);
    expect(r.waiting).toEqual([]);
  });

  it("a payment posted but the ticked bill is still owed: says the amounts don't add up", () => {
    const r = run(
      [
        inv("2026-10-18", "1000.00", "A"),
        inv("2026-10-20", "500.00", "B", "2026-11-14"),
        entry("PAYMENT", "2026-11-15", "1000.00"),
      ],
      "500.00",
    );
    expect(r.waiting[0]).toMatchObject({ reference: "B", state: "short" });
    expect(r.waiting[0]!.note).toMatch(
      /\$1,000\.00 payment posted Nov 15, but this bill still shows \$500\.00 owed/,
    );
  });

  it("nothing after a week turns amber", () => {
    const r = run([inv("2026-10-01", "100.00", "X", "2026-11-06")], "100.00");
    expect(r.waiting[0]).toMatchObject({
      state: "late",
      note: "Marked paid Nov 6 (10 days ago) — no payment has shown up yet",
    });
  });

  it("an older payment doesn't count as confirming a new tick", () => {
    const r = run(
      [inv("2026-10-01", "100.00", "X", "2026-11-14"), entry("PAYMENT", "2026-10-30", "999.00")],
      "100.00",
    );
    expect(r.waiting[0]!.state).toBe("waiting");
  });
});
