import { describe, expect, it } from "vitest";
import { computeAging } from "./aging";
import { computeVendorBalance, type LedgerEntryInput, type LedgerType } from "./balance";
import { accountHistory, invoiceNeighbours, invoiceTimeline } from "./history";
import { Money } from "./money";

const TODAY = new Date("2026-11-24T00:00:00Z");
const TERMS = 30;

function entry(
  id: string,
  type: LedgerType,
  date: string,
  amount: string,
  more: Partial<LedgerEntryInput> = {},
): LedgerEntryInput {
  return {
    id,
    type,
    entryDate: new Date(`${date}T00:00:00Z`),
    amount: new Money(type === "STATEMENT" ? 0 : amount),
    statedBalance: type === "STATEMENT" ? new Money(amount) : null,
    reference: type === "INVOICE" ? id.toUpperCase() : null,
    description: null,
    source: "MANUAL",
    needsReview: false,
    supersededById: null,
    ...more,
  };
}

/** The history of an account, worked out the way the page does it. */
function story(entries: LedgerEntryInput[]) {
  const balance = computeVendorBalance(entries, TODAY, { ownPaymentsAreOurs: true });
  const aging = computeAging(entries, balance.estimatedBalance, TODAY, TERMS);
  return { balance, aging, history: accountHistory(entries, aging, TODAY) };
}

const invoice = (h: ReturnType<typeof story>["history"], id: string) =>
  h.invoices.find((i) => i.id === id)!;

describe("accountHistory: the balance after each entry", () => {
  it("adds invoices and takes payments off, ending on today's balance", () => {
    const { balance, history } = story([
      entry("a", "INVOICE", "2026-10-01", "100.00"),
      entry("b", "INVOICE", "2026-10-10", "200.00"),
      entry("p", "PAYMENT", "2026-10-15", "150.00"),
    ]);
    expect(history.rows.map((r) => r.running)).toEqual(["100.00", "300.00", "150.00"]);
    expect(history.rows.at(-1)!.running).toBe(balance.estimatedBalance);
  });

  it("shows no balance before the first statement, then starts from its figure", () => {
    const { balance, history } = story([
      entry("old", "INVOICE", "2026-09-01", "75.00"),
      entry("s1", "STATEMENT", "2026-10-01", "2400.00"),
      entry("a", "INVOICE", "2026-10-07", "1250.50"),
      entry("p", "PAYMENT", "2026-10-21", "2400.00"),
      entry("c", "ADJUSTMENT", "2026-11-12", "-60.00"),
    ]);
    expect(history.rows.map((r) => [r.id, r.running])).toEqual([
      ["old", null],
      ["s1", "2400.00"],
      ["a", "3650.50"],
      ["p", "1250.50"],
      ["c", "1190.50"],
    ]);
    expect(history.rows[1]).toMatchObject({ anchor: true, current: true, delta: null });
    expect(history.rows.at(-1)!.running).toBe(balance.estimatedBalance);
  });

  it("a later statement re-sets the balance and says by how much it differs", () => {
    const { history } = story([
      entry("s1", "STATEMENT", "2026-09-01", "500.00"),
      entry("a", "INVOICE", "2026-09-10", "300.00"),
      entry("p", "PAYMENT", "2026-09-20", "500.00"),
      entry("s2", "STATEMENT", "2026-10-01", "300.20"),
      entry("b", "INVOICE", "2026-10-05", "40.00"),
    ]);
    const s2 = history.rows.find((r) => r.id === "s2")!;
    expect(s2).toMatchObject({
      anchor: true,
      current: true,
      computedBefore: "300.00",
      delta: "0.20",
      running: "300.20",
    });
    expect(history.rows.find((r) => r.id === "s1")).toMatchObject({ anchor: true, current: false });
    expect(history.rows.at(-1)!.running).toBe("340.20");
  });

  it("two statements with nothing written down between them report no difference", () => {
    const { history } = story([
      entry("s1", "STATEMENT", "2026-09-01", "500.00"),
      entry("s2", "STATEMENT", "2026-10-01", "900.00"),
    ]);
    expect(history.rows[1]).toMatchObject({ delta: null, computedBefore: null, running: "900.00" });
  });

  it("an entry on a statement's own day is already in that statement", () => {
    const { balance, history } = story([
      entry("s1", "STATEMENT", "2026-10-01", "100.00"),
      entry("a", "INVOICE", "2026-10-01", "100.00"),
    ]);
    expect(history.rows.map((r) => r.id)).toEqual(["a", "s1"]);
    expect(history.rows.at(-1)!.running).toBe(balance.estimatedBalance);
    expect(balance.estimatedBalance).toBe("100.00");
  });

  it("an entry dated after today is listed but not counted", () => {
    const { history } = story([
      entry("a", "INVOICE", "2026-10-01", "100.00"),
      entry("z", "INVOICE", "2026-12-25", "900.00"),
    ]);
    expect(history.rows.at(-1)).toMatchObject({ id: "z", counted: false, running: null });
    expect(invoice(history, "z")).toMatchObject({ state: "notCounted", notCounted: "future" });
  });
});

describe("accountHistory: which payments cleared which bills", () => {
  it("counts a payment against the oldest bills first", () => {
    const { history } = story([
      entry("a", "INVOICE", "2026-10-01", "100.00"),
      entry("b", "INVOICE", "2026-10-10", "200.00"),
      entry("p", "PAYMENT", "2026-10-15", "150.00", { reference: "wire 7" }),
    ]);
    expect(invoice(history, "a")).toMatchObject({
      state: "cleared",
      open: "0.00",
      paid: "100.00",
      unmatched: "0.00",
      clearedBy: [{ entryId: "p", kind: "PAYMENT", amount: "100.00", reference: "wire 7" }],
    });
    expect(invoice(history, "b")).toMatchObject({
      state: "part",
      open: "150.00",
      paid: "50.00",
      clearedBy: [{ entryId: "p", amount: "50.00" }],
    });
    expect(history.payments).toEqual([
      {
        id: "p",
        kind: "PAYMENT",
        date: "2026-10-15",
        amount: "150.00",
        reference: "wire 7",
        cleared: [
          { invoiceId: "a", reference: "A", amount: "100.00", whole: true },
          { invoiceId: "b", reference: "B", amount: "50.00", whole: false },
        ],
        rest: "0.00",
      },
    ]);
  });

  it("a statement's opening balance is paid off before the invoices after it", () => {
    const { aging, history } = story([
      entry("s1", "STATEMENT", "2026-10-01", "2400.00"),
      entry("a", "INVOICE", "2026-10-07", "1250.50"),
      entry("p", "PAYMENT", "2026-10-21", "2400.00"),
      entry("b", "INVOICE", "2026-11-12", "980.00"),
      entry("c", "ADJUSTMENT", "2026-11-16", "-60.00"),
    ]);
    expect(aging.bills.map((b) => [b.id, b.open])).toEqual([
      ["a", "1190.50"],
      ["b", "980.00"],
    ]);
    // The $2,400 went to what the statement said was owed; only the credit touches invoice A.
    expect(invoice(history, "a").clearedBy).toEqual([
      { entryId: "c", kind: "CREDIT", date: "2026-11-16", reference: null, amount: "60.00" },
    ]);
    expect(history.payments.find((p) => p.id === "p")).toMatchObject({
      cleared: [],
      rest: "2400.00",
    });
    expect(history.payments.find((p) => p.id === "c")).toMatchObject({
      kind: "CREDIT",
      amount: "60.00",
      rest: "0.00",
    });
  });

  it("a bill a statement settles without a payment here is paid, by nothing on record", () => {
    const { history } = story([
      entry("a", "INVOICE", "2026-10-01", "100.00"),
      entry("s1", "STATEMENT", "2026-10-20", "0.00"),
    ]);
    expect(invoice(history, "a")).toMatchObject({
      state: "cleared",
      paid: "100.00",
      clearedBy: [],
      unmatched: "100.00",
    });
  });

  it("money sent ahead clears the next invoice as it arrives", () => {
    const { balance, history } = story([
      entry("p", "PAYMENT", "2026-10-01", "300.00"),
      entry("a", "INVOICE", "2026-10-05", "100.00"),
    ]);
    expect(balance.estimatedBalance).toBe("-200.00");
    expect(invoice(history, "a")).toMatchObject({
      state: "cleared",
      clearedBy: [{ entryId: "p", amount: "100.00" }],
    });
    expect(history.payments[0]).toMatchObject({ rest: "200.00" });
  });

  it("a statement that says more is owed re-opens the newest bills, never more than the ageing", () => {
    const { aging, history } = story([
      entry("a", "INVOICE", "2026-10-01", "100.00"),
      entry("p", "PAYMENT", "2026-10-05", "100.00"),
      entry("b", "INVOICE", "2026-10-10", "100.00"),
      entry("s1", "STATEMENT", "2026-10-20", "150.00"),
    ]);
    expect(aging.bills.map((b) => [b.id, b.open])).toEqual([
      ["a", "50.00"],
      ["b", "100.00"],
    ]);
    expect(invoice(history, "a")).toMatchObject({
      state: "part",
      open: "50.00",
      paid: "50.00",
      clearedBy: [{ entryId: "p", amount: "50.00" }],
      unmatched: "0.00",
    });
    expect(history.payments[0]).toMatchObject({ rest: "50.00" });
  });

  it("every invoice's paid and still-owed add up to its amount, whatever the story", () => {
    const { aging, history } = story([
      entry("s0", "STATEMENT", "2026-08-01", "310.10"),
      entry("a", "INVOICE", "2026-08-05", "120.00"),
      entry("x", "ADJUSTMENT", "2026-08-06", "15.00"),
      entry("p1", "PAYMENT", "2026-08-20", "400.00"),
      entry("b", "INVOICE", "2026-09-02", "89.95"),
      entry("s1", "STATEMENT", "2026-09-15", "140.00"),
      entry("c", "INVOICE", "2026-10-01", "640.00"),
      entry("p2", "PAYMENT", "2026-10-20", "500.00"),
      entry("d", "INVOICE", "2026-11-10", "75.25"),
      entry("cr", "ADJUSTMENT", "2026-11-11", "-20.00"),
    ]);
    const open = new Map(aging.bills.map((b) => [b.id, b.open]));
    for (const inv of history.invoices) {
      expect(inv.open).toBe(open.get(inv.id) ?? "0.00");
      expect(new Money(inv.open).add(inv.paid).toFixed(2)).toBe(inv.amount);
      const matched = inv.clearedBy.reduce((s, c) => s.add(c.amount), new Money(0));
      expect(matched.add(inv.unmatched).toFixed(2)).toBe(inv.paid);
      expect(new Money(inv.unmatched).gte(0)).toBe(true);
    }
    for (const p of history.payments) {
      expect(new Money(p.rest).gte(0)).toBe(true);
      const used = p.cleared.reduce((s, c) => s.add(c.amount), new Money(0));
      expect(used.add(p.rest).toFixed(2)).toBe(p.amount);
    }
  });

  it("the same invoice written down twice is counted once", () => {
    const { history } = story([
      entry("a1", "INVOICE", "2026-10-01", "100.00", { reference: "INV-7" }),
      entry("a2", "INVOICE", "2026-10-02", "100.00", { reference: "inv-7" }),
    ]);
    expect(invoice(history, "a1")).toMatchObject({ state: "notCounted", notCounted: "duplicate" });
    expect(invoice(history, "a2").notCounted).toBeNull();
  });

  it("works out each invoice's due day and the day to pay it", () => {
    // Nov 5 + 30 days is Saturday Dec 5: pay the Friday before.
    const { history } = story([entry("a", "INVOICE", "2026-11-05", "146.79")]);
    expect(invoice(history, "a")).toMatchObject({
      dueDate: "2026-12-05",
      payBy: "2026-12-04",
      ageDays: 19,
      daysPastDue: -11,
      state: "open",
    });
  });
});

describe("invoiceTimeline", () => {
  it("puts the invoice, the tick, its payments, the pay day and the due date in date order", () => {
    const { history } = story([
      entry("a", "INVOICE", "2026-11-05", "146.79", {
        paymentSentAt: new Date("2026-11-20T15:00:00Z"),
      }),
      entry("p", "PAYMENT", "2026-11-21", "100.00"),
    ]);
    const events = invoiceTimeline(invoice(history, "a"), "2026-11-24", "2026-11-20");
    expect(events.map((e) => [e.kind, e.date, e.happened])).toEqual([
      ["invoiced", "2026-11-05", true],
      ["marked", "2026-11-20", true],
      ["payment", "2026-11-21", true],
      ["payBy", "2026-12-04", false],
      ["due", "2026-12-05", false],
    ]);
    expect(events[2]).toMatchObject({ amount: "100.00" });
  });

  it("leaves out the pay day when the due date is a weekday", () => {
    const { history } = story([entry("a", "INVOICE", "2026-10-27", "482.53")]);
    const kinds = invoiceTimeline(invoice(history, "a"), "2026-11-24", null).map((e) => e.kind);
    expect(kinds).toEqual(["invoiced", "due"]);
  });
});

describe("invoiceNeighbours", () => {
  it("names the invoices before and after", () => {
    const { history } = story([
      entry("a", "INVOICE", "2026-10-01", "1.00"),
      entry("b", "INVOICE", "2026-10-02", "1.00"),
      entry("c", "INVOICE", "2026-10-03", "1.00"),
    ]);
    const mid = invoiceNeighbours(history.invoices, "b");
    expect(mid).toMatchObject({ position: 2, total: 3 });
    expect(mid.before!.id).toBe("a");
    expect(mid.after!.id).toBe("c");
    expect(invoiceNeighbours(history.invoices, "a").before).toBeNull();
    expect(invoiceNeighbours(history.invoices, "c").after).toBeNull();
  });
});
