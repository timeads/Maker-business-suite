import { describe, expect, it } from "vitest";
import {
  accountChoice,
  accountsOfLine,
  bookRevenue,
  bookRevenueTotal,
  invoiceAccounts,
} from "./book-revenue";
import { daysLate, invoiceHref, invoiceStatus, invoicesTable, parseInvoiceQuery } from "./invoices";
import { revenueSettingsSchema, type RevenueSettings } from "./lines";
import { csvText } from "./export";

const settings = (books: Record<string, unknown> = {}): RevenueSettings =>
  revenueSettingsSchema.parse({
    version: 1,
    lines: [
      { id: "shop", name: "Shop" },
      { id: "classes", name: "Classes" },
    ],
    default_line: "shop",
    books: {
      invoices: true,
      other_income: true,
      accounts: [
        { ref: "79", name: "Class income", choice: { line: "classes" } },
        { ref: null, name: "Sales", choice: { skip: "shop" } },
      ],
      ...books,
    },
  });

describe("which line an income account takes", () => {
  it("goes by the books' id, else the exact name", () => {
    const s = settings();
    expect(accountChoice(s.books, { ref: "79", name: "Renamed" })).toEqual({ line: "classes" });
    expect(accountChoice(s.books, { ref: "12", name: "Sales" })).toEqual({ skip: "shop" });
    expect(accountChoice(s.books, { ref: null, name: "sales" })).toBeNull();
    expect(accountChoice(s.books, { ref: null, name: null })).toBeNull();
  });

  it("lists a line's accounts for the invoice filter", () => {
    expect(accountsOfLine(settings().books, "classes")).toEqual({ refs: ["79"], names: [] });
  });

  it("refuses a choice that points at no line, or the same account twice", () => {
    const base = settings();
    expect(
      revenueSettingsSchema.safeParse({
        ...base,
        books: { ...base.books, accounts: [{ ref: "1", name: "A", choice: { line: "gone" } }] },
      }).success,
    ).toBe(false);
    expect(
      revenueSettingsSchema.safeParse({
        ...base,
        books: {
          ...base.books,
          accounts: [
            { ref: "1", name: "A", choice: { skip: "other" } },
            { ref: "1", name: "B", choice: { skip: "other" } },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      revenueSettingsSchema.safeParse({
        ...base,
        books: { ...base.books, other_income_line: "gone" },
      }).success,
    ).toBe(false);
  });

  it("leaves a saved setting from before the books as it was", () => {
    const old = revenueSettingsSchema.parse({ version: 1 });
    expect(old.books).toEqual({
      invoices: false,
      other_income: false,
      other_income_line: null,
      accounts: [],
      customers: [],
    });
  });
});

describe("the books' revenue by line", () => {
  const invoices = [
    { period: "2026-10-01", account_ref: "79", account: "Class income", cents: 12000 },
    { period: "2026-11-01", account_ref: "79", account: "Class income", cents: 3000 },
    { period: "2026-10-01", account_ref: "5", account: "Sales", cents: 50000 },
    { period: "2026-10-01", account_ref: "81", account: "Rentals", cents: 2500 },
  ];
  const other = [
    { month: "2026-10", cents: 400 },
    { month: "2026-11", cents: 100 },
  ];

  it("counts invoices on chosen accounts, leaves the shop's out and holds the rest apart", () => {
    const out = bookRevenue(settings(), invoices, other);
    expect(out.invoicesByLine).toEqual(new Map([["classes", 15000]]));
    expect(out.invoicesByPeriod.get("classes")).toEqual(
      new Map([
        ["2026-10-01", 12000],
        ["2026-11-01", 3000],
      ]),
    );
    expect(out.leftOut).toBe(50000);
    expect(out.waiting).toBe(2500);
    expect(out.otherIncome).toBe(500);
    expect(out.otherUnplaced).toBe(500);
    expect(out.byLine).toEqual(new Map([["classes", 15000]]));
    expect(bookRevenueTotal(out)).toBe(15500);
  });

  it("puts other income in its line when one is chosen, and says when a month isn't known", () => {
    const out = bookRevenue(settings({ other_income_line: "shop" }), invoices, [
      ...other,
      { month: "2026-12", cents: null },
    ]);
    expect(out.byLine.get("shop")).toBe(500);
    expect(out.otherUnplaced).toBe(0);
    expect(out.otherUnknown).toBe(true);
  });

  it("counts nothing from the books until it's switched on", () => {
    const out = bookRevenue(settings({ invoices: false, other_income: false }), invoices, other);
    expect(out.byLine.size).toBe(0);
    expect(out.waiting + out.leftOut + out.otherIncome).toBe(0);
  });

  it("lists the accounts invoices use with their choices, folding the same account", () => {
    const rows = invoiceAccounts(settings().books, [
      { account_ref: "5", account: "Sales", invoices: 4, cents: 50000 },
      { account_ref: "79", account: "Class income", invoices: 2, cents: 15000 },
      { account_ref: "79", account: null, invoices: 1, cents: 100 },
    ]);
    expect(rows.map((r) => [r.name, r.cents, r.choice])).toEqual([
      ["Sales", 50000, { skip: "shop" }],
      ["Class income", 15100, { line: "classes" }],
    ]);
  });
});

describe("the invoice list", () => {
  it("is paid when nothing is owed, overdue the day after it was due, else open", () => {
    expect(invoiceStatus({ balance_cents: 0, due_date: "2026-01-01" }, "2026-11-20")).toBe("paid");
    expect(invoiceStatus({ balance_cents: 5, due_date: "2026-11-20" }, "2026-11-20")).toBe("open");
    expect(invoiceStatus({ balance_cents: 5, due_date: "2026-11-19" }, "2026-11-20")).toBe(
      "overdue",
    );
    expect(invoiceStatus({ balance_cents: 5, due_date: null }, "2026-11-20")).toBe("open");
    expect(daysLate("2026-11-10", "2026-11-20")).toBe(10);
    expect(daysLate("2026-03-01", "2026-03-09")).toBe(8);
  });

  it("keeps its view, search, line and page in the address", () => {
    const query = parseInvoiceQuery({
      view: "overdue",
      q: "  maple   studio ",
      line: "classes",
      page: "3",
    });
    expect(query).toEqual({
      view: "overdue",
      q: "maple studio",
      line: "classes",
      waiting: false,
      page: 3,
    });
    expect(invoiceHref("/x", query, { view: "paid" })).toBe(
      "/x?view=paid&q=maple+studio&line=classes",
    );
    // "Not sorted yet" and a line are one choice: the newer wins, and the address says so.
    expect(invoiceHref("/x", query, { waiting: true })).toBe(
      "/x?view=overdue&q=maple+studio&waiting=1",
    );
    const waiting = parseInvoiceQuery({ waiting: "1", line: "classes" });
    expect(waiting).toMatchObject({ waiting: true, line: null });
    expect(invoiceHref("/x", waiting, { line: "shop" })).toBe("/x?line=shop");
    expect(parseInvoiceQuery({ view: "nope", line: "Bad Line!", page: "-1" })).toEqual({
      view: "all",
      q: "",
      line: null,
      waiting: false,
      page: 1,
    });
  });

  it("downloads as a spreadsheet a formula can't hide in", () => {
    const text = csvText(
      invoicesTable([
        {
          doc_number: "1042",
          customer: "=HYPERLINK(1)",
          txn_date: "2026-10-05",
          due_date: null,
          total_cents: -1250,
          balance_cents: 0,
          status: "paid",
          place: { line: "Classes", why: "Your choice", state: "sorted" },
        },
      ]),
    );
    expect(text).toBe(
      "Number,Customer,Date,Due,Amount,Still owed,Status,Line,Decided by\r\n1042,'=HYPERLINK(1),2026-10-05,,-12.5,0,Paid,Classes,Your choice\r\n",
    );
  });
});
