import { describe, expect, it } from "vitest";
import type { VendorSummary } from "./summary";
import {
  arrivalWords,
  cardLineWords,
  confirmedWords,
  dueWords,
  lastArrival,
  payByHint,
  shortDay,
  supplierCard,
  termsHeading,
  weekDay,
} from "./words";

const money = (amount: string) => `$${amount}`;

const summary = (over: Partial<VendorSummary> = {}): VendorSummary => ({
  supplierId: "s1",
  name: "Hill Mill Yarns",
  termsDays: 30,
  balance: "1175.68",
  overdue: "0.00",
  overdueBills: 0,
  oldest: { reference: "INV-2041", date: "2026-10-27", dueDate: "2026-11-26", daysPastDue: -2 },
  needsReview: 0,
  empty: false,
  markedPaid: "0.00",
  ...over,
});

describe("supplierCard", () => {
  it("names the oldest unpaid bill and when it's due", () => {
    const card = supplierCard(summary());
    expect(card).toMatchObject({ balance: "1175.68", direction: "owed", waiting: null });
    expect(cardLineWords(card.line, money)).toBe("Oldest unpaid INV-2041 due Nov 26");
  });

  it("puts past-due money ahead of the oldest bill", () => {
    const card = supplierCard(summary({ overdue: "310.00", overdueBills: 2 }));
    expect(card.line).toEqual({ kind: "pastDue", amount: "310.00", bills: 2 });
    expect(cardLineWords(card.line, money)).toBe("$310.00 past due");
  });

  it("says Paid up when nothing is owed", () => {
    const card = supplierCard(summary({ balance: "0.00", oldest: null }));
    expect(card.direction).toBe("settled");
    expect(cardLineWords(card.line, money)).toBe("Paid up");
  });

  it("shows a credit without a minus sign, and the days to pay", () => {
    const card = supplierCard(summary({ balance: "-90.00", oldest: null, termsDays: 45 }));
    expect(card).toMatchObject({ balance: "90.00", direction: "credit" });
    expect(cardLineWords(card.line, money)).toBe("45 days to pay each invoice");
  });

  it("carries what's ticked Paid and still waiting", () => {
    expect(supplierCard(summary({ markedPaid: "1028.89" })).waiting).toBe("1028.89");
  });

  it("an account with nothing written down says so", () => {
    const card = supplierCard(summary({ empty: true, balance: "0.00", oldest: null }));
    expect(cardLineWords(card.line, money)).toBe("Nothing written down yet");
  });

  it("a bill with no number is just a bill", () => {
    const card = supplierCard(
      summary({
        oldest: { reference: null, date: "2026-10-27", dueDate: "2026-11-26", daysPastDue: -2 },
      }),
    );
    expect(cardLineWords(card.line, money)).toBe("Oldest unpaid bill due Nov 26");
  });
});

describe("days and due dates in words", () => {
  it("writes plain dates without shifting them", () => {
    expect(shortDay("2026-11-01")).toBe("Nov 1");
    expect(weekDay("2026-12-04")).toBe("Fri Dec 4");
  });

  it("a weekend's bill is paid the Friday before; a weekday's needs no hint", () => {
    expect(payByHint("2026-12-05")).toBe("pay Fri Dec 4"); // Saturday
    expect(payByHint("2026-12-06")).toBe("pay Fri Dec 4"); // Sunday
    expect(payByHint("2026-11-26")).toBeNull(); // Thursday
  });

  it("the Friday can fall in the month before", () => {
    expect(payByHint("2026-11-01")).toBe("pay Fri Oct 30");
  });

  it("says how far off a due date is", () => {
    expect(dueWords(-2)).toEqual({ text: "in 2 days", tone: "ahead" });
    expect(dueWords(-1)).toEqual({ text: "in 1 day", tone: "ahead" });
    expect(dueWords(0)).toEqual({ text: "today", tone: "today" });
    expect(dueWords(12)).toEqual({ text: "12 days late", tone: "late" });
  });

  it("heads the due dates with the shared days to pay, or says each has its own", () => {
    expect(termsHeading(30)).toBe("net 30 from the invoice date");
    expect(termsHeading(45)).toBe("net 45 from the invoice date");
    expect(termsHeading(0)).toBe("due on the invoice date");
    expect(termsHeading(null)).toBe("each supplier's own days to pay");
  });
});

describe("confirmedWords", () => {
  it("names the payment that cleared a ticked bill", () => {
    expect(
      confirmedWords({ payment: { date: "2026-11-18", amount: "640.00" } }, "2026-11-16", money),
    ).toBe("you marked it paid Nov 16; cleared by the $640.00 payment of Nov 18");
  });

  it("says it's no longer owed when no payment is found", () => {
    expect(confirmedWords({ payment: null }, "2026-11-16", money)).toBe(
      "you marked it paid Nov 16; it's no longer owed",
    );
  });
});

describe("how entries get here", () => {
  const rows = [
    { createdAt: "2026-11-20T10:00:00.000Z", source: "manual" },
    { createdAt: "2026-11-22T09:00:00.000Z", source: "books" },
    { createdAt: "2026-11-24T16:26:00.000Z", source: "books" },
    { createdAt: "2026-11-24T16:26:00.000Z", source: "books" },
  ];
  const none = { lastBooks: null, lastImport: null };

  it("finds the newest batch from one source and how many came together", () => {
    expect(lastArrival(rows, "books")).toEqual({ at: "2026-11-24T16:26:00.000Z", count: 2 });
    expect(lastArrival(rows, "manual")).toEqual({ at: "2026-11-20T10:00:00.000Z", count: 1 });
    expect(lastArrival(rows, "import")).toBeNull();
  });

  it("only says payments come from the books when that is switched on", () => {
    const off = arrivalWords("Hill Mill Yarns", { booksOn: false, ...none }).join(" ");
    expect(off).toContain("aren't read from your books");
    const on = arrivalWords("Hill Mill Yarns", { booksOn: true, ...none }).join(" ");
    expect(on).toContain("read at each sync");
    expect(on).not.toContain("aren't read");
  });

  it("always says the latest statement wins, and never mentions reading email", () => {
    const words = arrivalWords("Hill Mill Yarns", { booksOn: true, ...none }).join(" ");
    expect(words).toContain("latest statement always wins");
    expect(words).not.toMatch(/email|script|PDF/i);
  });
});
