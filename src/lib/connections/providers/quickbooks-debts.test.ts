import { describe, expect, it } from "vitest";
import { memoryStore } from "../testing";
import type { Fetch, SyncContext } from "../types";
import { createQuickBooksAdapter } from "./quickbooks";
import { parseLiabilityAccounts, type QuickBooksReport } from "./quickbooks-reports";

/** Placeholder names: nothing here is a real lender or account. */
const SHEET: QuickBooksReport = {
  Rows: {
    Row: [
      {
        group: "TotalAssets",
        Rows: {
          Row: [
            {
              group: "BankAccounts",
              Summary: { ColData: [{ value: "Total" }, { value: "100.00" }] },
              Rows: {
                Row: [{ type: "Data", ColData: [{ value: "Checking" }, { value: "100.00" }] }],
              },
            },
          ],
        },
      },
      {
        group: "TotalLiabilitiesAndEquity",
        Rows: {
          Row: [
            {
              group: "Liabilities",
              Rows: {
                Row: [
                  {
                    group: "CreditCards",
                    Rows: {
                      Row: [
                        {
                          type: "Data",
                          ColData: [{ value: "Card One", id: "41" }, { value: "1,234.56" }],
                        },
                      ],
                    },
                  },
                  {
                    group: "LongTermLiabilities",
                    Rows: {
                      Row: [
                        { type: "Data", ColData: [{ value: "Loan Two" }, { value: "-9,000.10" }] },
                      ],
                    },
                  },
                ],
              },
            },
            {
              group: "Equity",
              Rows: {
                Row: [{ type: "Data", ColData: [{ value: "Owner Equity" }, { value: "5.00" }] }],
              },
            },
          ],
        },
      },
    ],
  },
};

/** The chart of accounts' liabilities, as the books would answer (made up). */
const CHART = {
  QueryResponse: {
    Account: [
      {
        Id: "41",
        Name: "Card One",
        AccountType: "Credit Card",
        AccountSubType: "CreditCard",
        Classification: "Liability",
        Active: true,
      },
      {
        Id: "57",
        Name: "Loan Two",
        AccountType: "Long Term Liability",
        AccountSubType: "NotesPayable",
        Classification: "Liability",
        Active: true,
      },
      {
        Id: "60",
        Name: "Sales Tax Payable",
        AccountType: "Other Current Liability",
        AccountSubType: "SalesTaxPayable",
        Classification: "Liability",
        Active: true,
        CurrentBalance: 310,
      },
    ],
  },
};

describe("the books' cards and loans", () => {
  it("reads each liability line with its id and section, in whole cents, and nothing outside liabilities", () => {
    expect(parseLiabilityAccounts(SHEET)).toEqual([
      { id: "41", name: "Card One", cents: 123456, section: "CreditCards" },
      { id: null, name: "Loan Two", cents: -900010, section: "LongTermLiabilities" },
    ]);
    expect(parseLiabilityAccounts({ Rows: { Row: [] } })).toEqual([]);
  });

  const run = async (
    wanted: boolean,
    options: { chart?: "ok" | "fail"; storeFails?: boolean } = {},
  ) => {
    const { store, state } = memoryStore();
    state.bookExpensesWanted = wanted;
    state.bookDebtsFail = options.storeFails ?? false;
    const urls: string[] = [];
    const impl = (async (input: RequestInfo | URL) => {
      const url = decodeURIComponent(String(input).replace(/\+/g, " "));
      urls.push(url);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.includes("/companyinfo/")) return json({ CompanyInfo: { CompanyName: "Rugs" } });
      if (url.includes("/reports/BalanceSheet")) return json(SHEET);
      if (url.includes("/reports/")) return json({ Rows: { Row: [] } });
      if (url.includes("from Account ")) {
        return options.chart === "fail" ? json({ Fault: {} }, 500) : json(CHART);
      }
      return json({ QueryResponse: {} });
    }) as Fetch;
    await createQuickBooksAdapter(impl).sync({
      externalAccountId: "4620816365",
      token: { access_token: "at" },
      store,
    } as unknown as SyncContext);
    return {
      state,
      reports: urls.filter((url) => url.includes("/reports/")),
      chart: urls.filter((url) => url.includes("from Account ")),
    };
  };

  it("hands every liability to the store with the books' types, from one more read only", async () => {
    const { state, reports, chart } = await run(true);
    expect(reports).toHaveLength(4);
    expect(chart).toHaveLength(1);
    expect(chart[0]).toContain("select * from Account where Classification = 'Liability'");
    expect(state.bookDebts).toHaveLength(1);
    const [filed] = state.bookDebts;
    expect(filed.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(filed.complete).toBe(true);
    expect(filed.accounts.map((a) => [a.id, a.name, a.cents, a.type])).toEqual([
      ["41", "Card One", 123456, "Credit Card"],
      ["57", "Loan Two", -900010, "Long Term Liability"],
      ["60", "Sales Tax Payable", 31000, "Other Current Liability"],
    ]);
    expect(state.debtBalances).toEqual([]);
  });

  it("without the chart: the balance sheet's lines by section, and nothing taken as gone", async () => {
    const { state } = await run(true, { chart: "fail" });
    expect(state.bookDebts).toHaveLength(1);
    expect(state.bookDebts[0].complete).toBe(false);
    expect(state.bookDebts[0].accounts.map((a) => [a.name, a.type, a.section])).toEqual([
      ["Card One", null, "CreditCards"],
      ["Loan Two", null, "LongTermLiabilities"],
    ]);
  });

  it("falls back to balances by name when the database can't file debts yet", async () => {
    const { state } = await run(true, { storeFails: true });
    expect(state.debtBalances).toHaveLength(1);
    expect(state.debtBalances[0].accounts).toEqual([
      { name: "Card One", cents: 123456 },
      { name: "Loan Two", cents: -900010 },
    ]);
  });

  it("leaves them alone for a workspace without Money", async () => {
    const { state, chart } = await run(false);
    expect(chart).toEqual([]);
    expect(state.bookDebts).toEqual([]);
    expect(state.debtBalances).toEqual([]);
  });
});
