import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOOKS_DEBT_TYPES,
  bookLiabilities,
  countsAsDebt,
  debtKindOf,
  liabilityTypeWords,
  parseChartAccounts,
  withDebtRule,
  type ChartAccount,
  type SheetLiability,
} from "./books";
import { DEFAULT_DEBT_SETTINGS } from "./settings";

/** Made-up accounts: nothing here is a real lender, bank or account. */
const T = DEFAULT_BOOKS_DEBT_TYPES;
const of = (type: string | null, subtype: string | null = null, section: string | null = null) => ({
  type,
  subtype,
  section,
});

describe("which liabilities are debts", () => {
  it("defaults the setting to the same list", () => {
    expect(DEFAULT_DEBT_SETTINGS.books_debt_types).toEqual([...DEFAULT_BOOKS_DEBT_TYPES]);
  });

  it("counts cards, loans, notes, lines of credit and long-term liabilities by their type", () => {
    expect(countsAsDebt(of("Credit Card", "CreditCard"), T)).toBe(true);
    expect(countsAsDebt(of("Long Term Liability", "OtherLongTermLiabilities"), T)).toBe(true);
    expect(countsAsDebt(of("Other Current Liability", "LineOfCredit"), T)).toBe(true);
    expect(countsAsDebt(of("Other Current Liability", "LoanPayable"), T)).toBe(true);
    expect(countsAsDebt(of("Long Term Liability", "NotesPayable"), T)).toBe(true);
  });

  it("leaves out what isn't a debt to pay down", () => {
    expect(countsAsDebt(of("Accounts Payable", "AccountsPayable"), T)).toBe(false);
    expect(countsAsDebt(of("Other Current Liability", "SalesTaxPayable"), T)).toBe(false);
    expect(countsAsDebt(of("Other Current Liability", "PayrollTaxPayable"), T)).toBe(false);
    expect(countsAsDebt(of("Other Current Liability", "OtherCurrentLiabilities"), T)).toBe(false);
    expect(countsAsDebt(of(null), T)).toBe(false);
  });

  it("falls back to the balance sheet's section when the type wasn't read", () => {
    expect(countsAsDebt(of(null, null, "CreditCards"), T)).toBe(true);
    expect(countsAsDebt(of(null, null, "LongTermLiabilities"), T)).toBe(true);
    expect(countsAsDebt(of(null, null, "OtherCurrentLiabilities"), T)).toBe(false);
    expect(countsAsDebt(of(null, null, "AP"), T)).toBe(false);
  });

  it("follows the workspace's list, spaced or not, and nothing at all with an empty one", () => {
    expect(
      countsAsDebt(of("Other Current Liability", "SalesTaxPayable"), ["sales tax payable"]),
    ).toBe(true);
    expect(countsAsDebt(of("Credit Card", "CreditCard"), [])).toBe(false);
  });

  it("names the kind of debt from the type alone, never from the name", () => {
    expect(debtKindOf(of("Credit Card"))).toBe("card");
    expect(debtKindOf(of(null, null, "CreditCards"))).toBe("card");
    expect(debtKindOf(of("Other Current Liability", "LineOfCredit"))).toBe("line_of_credit");
    expect(debtKindOf(of("Other Current Liability", "LoanPayable"))).toBe("loan");
    expect(debtKindOf(of("Long Term Liability", "ShareholderNotesPayable"))).toBe("loan");
    expect(debtKindOf(of("Other Current Liability", "SalesTaxPayable"))).toBe("other");
  });

  it("says what the books call it, in words", () => {
    expect(liabilityTypeWords(of("Other Current Liability", "SalesTaxPayable"))).toBe(
      "Sales Tax Payable",
    );
    expect(liabilityTypeWords(of("Credit Card", "CreditCard"))).toBe("Credit Card");
    expect(liabilityTypeWords(of(null, null, "AP"))).toBe("Accounts Payable");
    expect(liabilityTypeWords(of(null))).toBe("Something owed");
  });
});

describe("putting the balance sheet and the chart of accounts together", () => {
  const sheet: SheetLiability[] = [
    { id: "41", name: "Card One", cents: 120000, section: "CreditCards" },
    { id: "41", name: "Card One", cents: 500, section: "CreditCards" },
    { id: null, name: "Loan  Two", cents: 900000, section: "LongTermLiabilities" },
    { id: null, name: "Mystery Line", cents: 100, section: "OtherCurrentLiabilities" },
  ];
  const chart: ChartAccount[] = [
    { id: "41", name: "Card One", type: "Credit Card", subtype: "CreditCard", cents: 1 },
    { id: "57", name: "loan two", type: "Long Term Liability", subtype: "NotesPayable", cents: 2 },
    { id: "61", name: "Quiet Card", type: "Credit Card", subtype: "CreditCard", cents: null },
    {
      id: "62",
      name: "Sales Tax Payable",
      type: "Other Current Liability",
      subtype: "SalesTaxPayable",
      cents: 3100,
    },
  ];

  it("takes every chart account with its line's balance, adding up its lines", () => {
    const { accounts, complete } = bookLiabilities(sheet, chart);
    expect(complete).toBe(true);
    expect(accounts.map((a) => [a.id, a.name, a.cents, a.type, a.section])).toEqual([
      ["41", "Card One", 120500, "Credit Card", "CreditCards"],
      // Matched by name where the sheet had no id.
      ["57", "loan two", 900000, "Long Term Liability", "LongTermLiabilities"],
      // No line: a balance sheet leaves accounts at zero out.
      ["61", "Quiet Card", 0, "Credit Card", null],
      // No line, but the chart knows its balance.
      ["62", "Sales Tax Payable", 3100, "Other Current Liability", null],
      // A line the chart doesn't explain still comes in, by its section.
      [null, "Mystery Line", 100, null, "OtherCurrentLiabilities"],
    ]);
  });

  it("doesn't take a chart for whole when it can't be", () => {
    expect(bookLiabilities(sheet, []).complete).toBe(false);
    expect(bookLiabilities([], []).complete).toBe(true);
    const unknown = [...sheet, { id: "99", name: "New Card", cents: 1, section: "CreditCards" }];
    expect(bookLiabilities(unknown, chart).complete).toBe(false);
  });

  it("without the chart: the sheet's lines, typed by section, and never complete", () => {
    const { accounts, complete } = bookLiabilities(sheet, null);
    expect(complete).toBe(false);
    expect(accounts.map((a) => [a.id, a.cents, a.section])).toEqual([
      ["41", 120500, "CreditCards"],
      [null, 900000, "LongTermLiabilities"],
      [null, 100, "OtherCurrentLiabilities"],
    ]);
    expect(withDebtRule(accounts, T).map((a) => [a.kind, a.automatic])).toEqual([
      ["card", true],
      ["loan", true],
      ["other", false],
    ]);
  });
});

describe("reading the chart of accounts", () => {
  it("keeps active liability accounts with their types, in whole cents", () => {
    expect(
      parseChartAccounts({
        QueryResponse: {
          Account: [
            {
              Id: "41",
              Name: " Card  One ",
              AccountType: "Credit Card",
              AccountSubType: "CreditCard",
              Classification: "Liability",
              Active: true,
              CurrentBalance: 1234.5,
            },
            {
              Id: "42",
              Name: "Old",
              AccountType: "Credit Card",
              Classification: "Liability",
              Active: false,
            },
            { Id: "43", Name: "Checking", AccountType: "Bank", Classification: "Asset" },
            { Id: "bad id!", Name: "Odd", Classification: "Liability" },
            { Id: "44", Name: "Deposits", Classification: "Liability" },
          ],
        },
      }),
    ).toEqual([
      { id: "41", name: "Card One", type: "Credit Card", subtype: "CreditCard", cents: 123450 },
      { id: "44", name: "Deposits", type: null, subtype: null, cents: null },
    ]);
    expect(parseChartAccounts({})).toEqual([]);
    expect(parseChartAccounts(null)).toEqual([]);
  });
});
