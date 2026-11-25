import { describe, expect, it } from "vitest";
import { computeAging } from "./aging";
import { computeVendorBalance, type LedgerEntryInput, type LedgerType } from "./balance";
import { accountHistory } from "./history";
import { Money } from "./money";
import { paidMarks } from "./paid-marks";
import { entrySource, type StoredSource } from "./source";
import { confirmedWords } from "./words";

/**
 * A payment written down twice on purpose: once as the bank shows it, once as
 * the supplier reports receiving it a day later. TuftStock counts that pair
 * once; a ledger brought across from it has to come to the same figures.
 *
 * Every name and amount here is made up. The expected figures are what
 * TuftStock's own balance, ageing and paid-marks code gives for this ledger
 * (run there on 2026-11-25), so this pins the two apps together.
 */

type Stored = StoredSource & {
  id: string;
  entry_date: string;
  amount: string;
  stated_balance?: string;
  reference?: string;
  payment_sent_at?: string;
  needs_review?: boolean;
};

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
const TYPES: Record<Stored["type"], LedgerType> = {
  statement: "STATEMENT",
  invoice: "INVOICE",
  payment: "PAYMENT",
  adjustment: "ADJUSTMENT",
};

/** The entries as the import writes them, oldest first. */
const ledger = (pair: [Stored["reported_by"], Stored["reported_by"]]): Stored[] => {
  const row = (over: Omit<Stored, "source" | "reported_by"> & Partial<Stored>): Stored => ({
    source: "import",
    reported_by: null,
    ...over,
  });
  return [
    row({
      id: "s1",
      type: "statement",
      entry_date: "2026-10-01",
      amount: "0",
      stated_balance: "500",
    }),
    row({
      id: "i1",
      type: "invoice",
      entry_date: "2026-10-05",
      amount: "1500",
      reference: "INV-201",
      payment_sent_at: "2026-10-19T15:00:00Z",
    }),
    row({
      id: "i2",
      type: "invoice",
      entry_date: "2026-10-12",
      amount: "2100",
      reference: "INV-202",
      needs_review: true,
    }),
    // The wire as the bank shows it, then the supplier saying it arrived.
    row({
      id: "p1",
      type: "payment",
      entry_date: "2026-10-20",
      amount: "3200",
      reported_by: pair[0],
    }),
    row({
      id: "p2",
      type: "payment",
      entry_date: "2026-10-21",
      amount: "3200",
      reported_by: pair[1],
    }),
    row({
      id: "i3",
      type: "invoice",
      entry_date: "2026-11-03",
      amount: "1800",
      reference: "INV-203",
    }),
    row({
      id: "i4",
      type: "invoice",
      entry_date: "2026-11-17",
      amount: "950",
      reference: "INV-204",
      payment_sent_at: "2026-11-20T16:00:00Z",
    }),
  ];
};

const toInput = (row: Stored): LedgerEntryInput => ({
  id: row.id,
  type: TYPES[row.type],
  entryDate: day(row.entry_date),
  amount: new Money(row.amount),
  statedBalance: row.stated_balance === undefined ? null : new Money(row.stated_balance),
  reference: row.reference ?? null,
  description: "",
  source: entrySource(row),
  needsReview: row.needs_review ?? false,
  supersededById: null,
  paymentSentAt: row.payment_sent_at ? new Date(row.payment_sent_at) : null,
});

function account(pair: [Stored["reported_by"], Stored["reported_by"]]) {
  const asOf = day("2026-11-25");
  const inputs = ledger(pair).map(toInput);
  // As the Balances page asks for it.
  const balance = computeVendorBalance(inputs, asOf, { ownPaymentsAreOurs: true });
  const aging = computeAging(inputs, balance.estimatedBalance, asOf, 30);
  const paid = paidMarks(inputs, aging, new Date("2026-11-25T15:00:00Z"));
  return { balance, aging, paid, history: accountHistory(inputs, aging, asOf) };
}

const money = (amount: string) => `$${amount}`;

describe("a payment seen from the bank's side and reported by the supplier", () => {
  it("is counted once when the entries say who reported it, as TuftStock counts it", () => {
    const { balance, aging, paid } = account(["bank", "supplier"]);
    expect(balance.anchor?.statedBalance).toBe("500.00");
    expect(balance.invoicesSince).toBe("6350.00");
    expect(balance.paymentsSince).toBe("3200.00");
    expect(balance.estimatedBalance).toBe("3650.00");
    // The supplier's entry is the one counted; the bank's notice is the same money.
    expect(balance.entriesSince.map((e) => e.id)).toEqual(["i4", "i3", "p2", "i2", "i1"]);
    expect(balance.paymentsPossiblyUnreflected).toEqual([]);
    expect(balance.needsReviewCount).toBe(1);

    expect(aging.openTotal).toBe("3650.00");
    expect(aging.unattributed).toBe("0.00");
    expect(aging.bills.map((b) => [b.reference, b.open, b.partial, b.daysPastDue])).toEqual([
      ["INV-202", "900.00", true, 14],
      ["INV-203", "1800.00", false, -8],
      ["INV-204", "950.00", false, -22],
    ]);
    expect(aging.buckets.notDue).toEqual({ amount: "2750.00", count: 2 });
    expect(aging.buckets.late1to30).toEqual({ amount: "900.00", count: 1 });

    // Paid, waiting to show up: the bill ticked after the wire is still owed.
    expect(paid.waitingTotal).toBe("950.00");
    expect(paid.waiting).toEqual([
      {
        billId: "i4",
        reference: "INV-204",
        open: "950.00",
        markedAt: "2026-11-20T16:00:00.000Z",
        state: "waiting",
        note: "Paid Nov 20 · waiting for the payment to show up",
      },
    ]);
    // Payments confirmed: the bill ticked before the wire, cleared by it.
    expect(paid.confirmed).toEqual([
      {
        billId: "i1",
        reference: "INV-201",
        amount: "1500.00",
        markedAt: "2026-10-19T15:00:00.000Z",
        payment: { date: "2026-10-20", amount: "3200.00" },
      },
    ]);
    expect(confirmedWords(paid.confirmed[0]!, "2026-10-19", money)).toBe(
      "you marked it paid Oct 19; cleared by the $3200.00 payment of Oct 20",
    );
  });

  it("was taken off twice by a ledger that didn't say (the mismatch this fixes)", () => {
    const { balance, aging, paid } = account([null, null]);
    expect(balance.paymentsSince).toBe("6400.00");
    // Short by exactly the payment.
    expect(new Money("3650.00").sub(new Money(balance.estimatedBalance)).toFixed(2)).toBe(
      "3200.00",
    );
    // And with it the bills still owed, and the one waiting for its payment.
    expect(aging.bills.map((b) => b.reference)).toEqual(["INV-204"]);
    expect(paid.waiting.map((w) => w.open)).toEqual(["450.00"]);
  });

  it("needs both sides named: the bank's word alone, or the supplier's alone, is one more payment", () => {
    expect(account(["bank", null]).balance.estimatedBalance).toBe("450.00");
    expect(account([null, "supplier"]).balance.estimatedBalance).toBe("450.00");
    // The order they were written down in makes no difference.
    expect(account(["supplier", "bank"]).balance.estimatedBalance).toBe("3650.00");
  });

  it("moves the running balance once, and ends on the figure the balance gives", () => {
    const { history, balance } = account(["bank", "supplier"]);
    const after = (id: string) => history.rows.find((r) => r.id === id);
    expect(after("i2")?.running).toBe("4100.00");
    expect(after("p1")).toMatchObject({ running: "4100.00", sameAsReported: true });
    expect(after("p2")?.running).toBe("900.00");
    expect(after("p2")?.sameAsReported).toBeUndefined();
    expect(history.rows.at(-1)?.running).toBe(balance.estimatedBalance);
    // One payment in the list of what cleared what, not two.
    expect(history.payments.map((p) => p.id)).toEqual(["p2"]);
    expect(history.payments[0]?.cleared.map((c) => [c.reference, c.amount])).toEqual([
      ["INV-201", "1500.00"],
      ["INV-202", "1200.00"],
    ]);
  });
});

describe("entrySource", () => {
  const src = (over: Partial<StoredSource>) =>
    entrySource({ source: "import", type: "payment", reported_by: null, ...over });
  it("reads whose word a payment is off the entry, however it was written down", () => {
    expect(src({ reported_by: "supplier" })).toBe("KARIDA_EMAIL");
    expect(src({ reported_by: "bank" })).toBe("WELLS_FARGO_EMAIL");
    expect(src({})).toBe("MANUAL");
    expect(src({ source: "email", reported_by: "supplier" })).toBe("KARIDA_EMAIL");
    expect(src({ source: "email", reported_by: "bank" })).toBe("WELLS_FARGO_EMAIL");
    expect(src({ source: "email" })).toBe("MANUAL");
    expect(src({ source: "manual" })).toBe("MANUAL");
  });
  it("keeps the books as our side, and everything that isn't a payment as it was", () => {
    expect(src({ source: "books" })).toBe("QUICKBOOKS");
    expect(src({ source: "email", type: "invoice" })).toBe("VENDOR_EMAIL");
    expect(src({ source: "upload", type: "statement" })).toBe("VENDOR_EMAIL");
    expect(src({ type: "invoice" })).toBe("MANUAL");
  });
});
