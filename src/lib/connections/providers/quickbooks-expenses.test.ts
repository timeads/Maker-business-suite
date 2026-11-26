import { describe, expect, it } from "vitest";
import { memoryStore } from "../testing";
import type { Fetch, SyncContext } from "../types";
import { createQuickBooksAdapter } from "./quickbooks";
import {
  EXPENSE_PAGE,
  expensesQuery,
  expensesSince,
  parseExpense,
  parseExpenses,
} from "./quickbooks-expenses";

describe("reading expenses from the books", () => {
  it("asks for one kind at a time, from a plain day, a page at a time", () => {
    expect(expensesQuery("Bill", "2025-01-01", 0)).toBe(
      `select * from Bill where TxnDate >= '2025-01-01' orderby TxnDate startposition 1 maxresults ${EXPENSE_PAGE}`,
    );
    expect(expensesQuery("Purchase", "2025-01-01", 2)).toContain(
      `startposition ${2 * EXPENSE_PAGE + 1}`,
    );
    expect(() => expensesQuery("Bill", "2025-01-01' or 1=1 --", 0)).toThrow();
    expect(() => expensesQuery("Invoice" as never, "2025-01-01", 0)).toThrow();
  });

  it("reads from the first of January last year", () => {
    expect(expensesSince(new Date("2026-11-26T12:00:00Z"))).toBe("2025-01-01");
    expect(expensesSince(new Date("2027-01-01T00:00:00Z"))).toBe("2026-01-01");
  });

  it("reads a card purchase with its lines, in whole cents", () => {
    const row = parseExpense("Purchase", {
      Id: "71",
      TxnDate: "2026-10-04",
      TotalAmt: 120.1,
      PaymentType: "CreditCard",
      PrivateNote: "  Wool   order ",
      EntityRef: { name: "Yarn Barn", type: "Vendor" },
      Line: [
        {
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: 100.05,
          Description: "Cones",
          AccountBasedExpenseLineDetail: { AccountRef: { name: "Supplies" } },
        },
        {
          DetailType: "ItemBasedExpenseLineDetail",
          Amount: 20.05,
          ItemBasedExpenseLineDetail: { ItemAccountRef: { name: "Inventory" } },
        },
        { DetailType: "SubTotalLineDetail", Amount: 120.1 },
      ],
    });
    expect(row).toEqual({
      entity: "Purchase",
      external_id: "71",
      kind: "purchase",
      date: "2026-10-04",
      memo: "Wool order",
      payment_type: "CreditCard",
      amount_cents: 12010,
      account: "Supplies",
      payee: "Yarn Barn",
      from_account: null,
      lines: [
        { account: "Supplies", amount_cents: 10005, description: "Cones" },
        { account: "Inventory", amount_cents: 2005, description: "" },
      ],
    });
  });

  it("keeps a card refund as money back", () => {
    const row = parseExpense("Purchase", {
      Id: "72",
      TxnDate: "2026-10-05",
      TotalAmt: 15,
      Credit: true,
      Line: [],
    });
    expect(row?.amount_cents).toBe(-1500);
  });

  it("reads a bill under its vendor", () => {
    const row = parseExpense("Bill", {
      Id: "8",
      TxnDate: "2026-09-30",
      TotalAmt: "450.00",
      VendorRef: { name: "Kiln Repairs" },
      Line: [
        {
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: 450,
          AccountBasedExpenseLineDetail: { AccountRef: { name: "Repairs" } },
        },
      ],
    });
    expect(row).toMatchObject({ kind: "bill", payee: "Kiln Repairs", amount_cents: 45000 });
  });

  it("takes only the debit side of a journal entry, added up", () => {
    const row = parseExpense("JournalEntry", {
      Id: "5",
      TxnDate: "2026-10-31",
      PrivateNote: "Month end",
      Line: [
        {
          DetailType: "JournalEntryLineDetail",
          Amount: 30,
          Description: "Insurance for October",
          JournalEntryLineDetail: {
            PostingType: "Debit",
            AccountRef: { name: "Insurance" },
            Entity: { EntityRef: { name: "Cover Co" } },
          },
        },
        {
          DetailType: "JournalEntryLineDetail",
          Amount: 12.5,
          JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { name: "Fees" } },
        },
        {
          DetailType: "JournalEntryLineDetail",
          Amount: 42.5,
          JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { name: "Checking" } },
        },
      ],
    });
    expect(row).toMatchObject({
      kind: "journal",
      amount_cents: 4250,
      account: "Insurance",
      payee: "Cover Co",
      lines: [
        { account: "Insurance", amount_cents: 3000, description: "Insurance for October" },
        { account: "Fees", amount_cents: 1250, description: "" },
      ],
    });
    expect(
      parseExpense("JournalEntry", {
        Id: "6",
        TxnDate: "2026-10-31",
        Line: [
          {
            DetailType: "JournalEntryLineDetail",
            Amount: 5,
            JournalEntryLineDetail: { PostingType: "Credit" },
          },
        ],
      }),
    ).toBeNull();
  });

  it("keeps transfers and card payments as moves, with where the money went", () => {
    expect(
      parseExpense("Transfer", {
        Id: "3",
        TxnDate: "2026-10-02",
        Amount: 500,
        FromAccountRef: { name: "Checking" },
        ToAccountRef: { name: "Equipment loan" },
      }),
    ).toMatchObject({
      kind: "transfer",
      account: "Equipment loan",
      from_account: "Checking",
      amount_cents: 50000,
      payee: null,
    });
    expect(
      parseExpense("CreditCardPayment", {
        Id: "4",
        TxnDate: "2026-10-03",
        Amount: 250.75,
        BankAccountRef: { name: "Checking" },
        CreditCardAccountRef: { name: "Studio card" },
      }),
    ).toMatchObject({ kind: "card_payment", account: "Studio card", amount_cents: 25075 });
    expect(parseExpense("Transfer", { Id: "9", TxnDate: "2026-10-02", Amount: 5 })).toBeNull();
  });

  it("leaves out anything unclear", () => {
    expect(
      parseExpenses("Bill", {
        QueryResponse: {
          Bill: [
            { Id: "", TxnDate: "2026-10-01", TotalAmt: 1 },
            { Id: "2", TxnDate: "October", TotalAmt: 1 },
            null,
            { Id: "3", TxnDate: "2026-10-01", TotalAmt: 1 },
          ],
        },
      }),
    ).toHaveLength(1);
    expect(parseExpenses("Bill", { QueryResponse: null })).toEqual([]);
  });
});

describe("the QuickBooks sync and expenses", () => {
  const report = { Header: {}, Columns: { Column: [] }, Rows: { Row: [] } };
  function net(
    options: { failTransfers?: boolean; fullPage?: boolean; failCashFlow?: boolean } = {},
  ) {
    const urls: string[] = [];
    const impl = (async (input: RequestInfo | URL) => {
      const url = decodeURIComponent(String(input).replace(/\+/g, " "));
      urls.push(url);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.includes("/companyinfo/")) return json({ CompanyInfo: { CompanyName: "Rugs" } });
      if (url.includes("/reports/CashFlow") && options.failCashFlow) {
        return json({ Fault: {} }, 400);
      }
      if (url.includes("/reports/")) return json(report);
      if (url.includes("/query?")) {
        if (url.includes("from Transfer") && options.failTransfers) return json({ Fault: {} }, 500);
        if (url.includes("from Bill ")) {
          const page = url.includes("startposition 1 ") ? 0 : 1;
          const size = options.fullPage && page === 0 ? EXPENSE_PAGE : 1;
          return json({
            QueryResponse: {
              Bill: Array.from({ length: size }, (_, i) => ({
                Id: `${page}-${i}`,
                TxnDate: "2026-10-01",
                TotalAmt: 10,
                VendorRef: { name: "Mill" },
              })),
            },
          });
        }
        return json({ QueryResponse: {} });
      }
      return new Response("no route", { status: 599 });
    }) as Fetch;
    return { impl, urls };
  }
  const run = async (wanted: boolean, options: Parameters<typeof net>[0] = {}) => {
    const { store, state } = memoryStore();
    state.bookExpensesWanted = wanted;
    const wire = net(options);
    const result = await createQuickBooksAdapter(wire.impl).sync({
      externalAccountId: "4620816365",
      token: { access_token: "at" },
      store,
    } as unknown as SyncContext);
    return { state, urls: wire.urls, result };
  };

  it("doesn't read expenses for a workspace without Money", async () => {
    const { state, urls } = await run(false);
    expect(urls.some((url) => url.includes("/query?"))).toBe(false);
    expect(state.bookExpenses).toEqual([]);
  });

  it("reads each kind, only ever with questions, and marks what's gone for kinds read in full", async () => {
    const { state, urls } = await run(true);
    const queries = urls.filter((url) => url.includes("/query?"));
    expect(queries).toHaveLength(5);
    expect(
      queries.every((url) =>
        /query=select \* from (Purchase|Bill|JournalEntry|Transfer|CreditCardPayment) where TxnDate >= '\d{4}-01-01'/.test(
          url,
        ),
      ),
    ).toBe(true);
    expect(state.bookExpenses.map((e) => e.row.external_id)).toEqual(["0-0"]);
    expect(state.expenseCloses).toHaveLength(1);
    expect(state.expenseCloses[0].entities).toEqual([
      "Purchase",
      "Bill",
      "JournalEntry",
      "Transfer",
      "CreditCardPayment",
    ]);
    expect(state.expenseCloses[0].run).toBe(state.bookExpenses[0].run);
    expect(state.usage).toBe(5 + 5);
  });

  it("reads the monthly reports from three Januaries back, cash flow on the cash basis", async () => {
    const { urls } = await run(false);
    const year = new Date().getUTCFullYear();
    const pnl = urls.find((url) => url.includes("/reports/ProfitAndLoss"))!;
    expect(pnl).toContain(`start_date=${year - 3}-01-01`);
    expect(pnl).toContain("summarize_column_by=Month");
    const cash = urls.find((url) => url.includes("/reports/CashFlow"))!;
    expect(cash).toContain(`start_date=${year - 3}-01-01`);
    expect(cash).toContain("summarize_column_by=Month");
    expect(cash).toContain("accounting_method=Cash");
  });

  it("finishes the sync when the cash flow report can't be read", async () => {
    const { result, state } = await run(true, { failCashFlow: true });
    expect(result.cursor).toBeDefined();
    expect(state.bookExpenses.length).toBeGreaterThan(0);
  });

  it("asks for the next page when one comes back full", async () => {
    const { state } = await run(true, { fullPage: true });
    expect(state.bookExpenses).toHaveLength(EXPENSE_PAGE + 1);
  });

  it("leaves a kind it couldn't read untouched, and still finishes", async () => {
    const { state, result } = await run(true, { failTransfers: true });
    expect(state.expenseCloses[0].entities).not.toContain("Transfer");
    expect(state.expenseCloses[0].entities).toContain("Bill");
    expect(result.cursor).toBeDefined();
  });
});
