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
                        { type: "Data", ColData: [{ value: "Card One" }, { value: "1,234.56" }] },
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

describe("the books' cards and loans", () => {
  it("reads each liability account's line in whole cents, and nothing outside liabilities", () => {
    expect(parseLiabilityAccounts(SHEET)).toEqual([
      { name: "Card One", cents: 123456 },
      { name: "Loan Two", cents: -900010 },
    ]);
    expect(parseLiabilityAccounts({ Rows: { Row: [] } })).toEqual([]);
  });

  const run = async (wanted: boolean) => {
    const { store, state } = memoryStore();
    state.bookExpensesWanted = wanted;
    const urls: string[] = [];
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.includes("/companyinfo/")) return json({ CompanyInfo: { CompanyName: "Rugs" } });
      if (url.includes("/reports/BalanceSheet")) return json(SHEET);
      if (url.includes("/reports/")) return json({ Rows: { Row: [] } });
      return json({ QueryResponse: {} });
    }) as Fetch;
    await createQuickBooksAdapter(impl).sync({
      externalAccountId: "4620816365",
      token: { access_token: "at" },
      store,
    } as unknown as SyncContext);
    return { state, reports: urls.filter((url) => url.includes("/reports/")) };
  };

  it("hands them to the store from the balance sheet already read: no extra call", async () => {
    const { state, reports } = await run(true);
    expect(reports).toHaveLength(4);
    expect(state.debtBalances).toHaveLength(1);
    expect(state.debtBalances[0].accounts.map((a) => a.name)).toEqual(["Card One", "Loan Two"]);
    expect(state.debtBalances[0].asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("leaves them alone for a workspace without Money", async () => {
    const { state } = await run(false);
    expect(state.debtBalances).toEqual([]);
  });
});
