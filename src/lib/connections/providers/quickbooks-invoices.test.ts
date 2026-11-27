import { describe, expect, it } from "vitest";
import { memoryStore } from "../testing";
import type { Fetch, SyncContext } from "../types";
import { createQuickBooksAdapter } from "./quickbooks";
import {
  INVOICE_PAGE,
  invoicesQuery,
  itemsQuery,
  parseInvoice,
  parseInvoices,
  parseItems,
} from "./quickbooks-invoices";

const items = parseItems({
  QueryResponse: {
    Item: [
      { Id: "11", Name: "Group class", IncomeAccountRef: { value: "79", name: "Class income" } },
      { Id: "12", Name: "Wall piece", IncomeAccountRef: { value: "80", name: "Commissions" } },
      { Id: "13", Name: "No account" },
    ],
  },
});

const sale = (item: string, amount: number, extra: Record<string, unknown> = {}) => ({
  DetailType: "SalesItemLineDetail",
  Amount: amount,
  Description: `About ${item}`,
  SalesItemLineDetail: { ItemRef: { value: item, name: `Item ${item}` } },
  ...extra,
});

describe("reading invoices from the books", () => {
  it("only ever asks questions, a page at a time", () => {
    expect(invoicesQuery("2024-01-01", 0)).toBe(
      "select * from Invoice where TxnDate >= '2024-01-01' orderby TxnDate startposition 1 maxresults 500",
    );
    expect(invoicesQuery("2024-01-01", 2)).toContain(`startposition ${2 * INVOICE_PAGE + 1}`);
    expect(itemsQuery(1)).toBe("select * from Item startposition 1001 maxresults 1000");
    expect(() => invoicesQuery("2024-01-01' or 1=1", 0)).toThrow();
  });

  it("knows each item's income account", () => {
    expect(items.get("11")).toEqual({ ref: "79", name: "Class income" });
    expect(items.has("13")).toBe(false);
  });

  it("shares the invoice before tax among its sales lines, to the cent", () => {
    const row = parseInvoice(
      {
        Id: "301",
        DocNumber: "1042",
        TxnDate: "2026-10-05",
        DueDate: "2026-11-04",
        TotalAmt: 107.0,
        Balance: 0,
        CustomerRef: { value: "5", name: "Maple Studio" },
        TxnTaxDetail: { TotalTax: 7 },
        Line: [
          sale("11", 60),
          sale("12", 50),
          { DetailType: "DiscountLineDetail", Amount: 10 },
          { DetailType: "SubTotalLineDetail", Amount: 100 },
        ],
      },
      items,
    )!;
    expect(row).toMatchObject({
      external_id: "301",
      doc_number: "1042",
      customer: "Maple Studio",
      date: "2026-10-05",
      due_date: "2026-11-04",
      total_cents: 10700,
      balance_cents: 0,
      net_cents: 10000,
    });
    expect(row.lines.map((l) => [l.account, l.cents])).toEqual([
      ["Class income", 5455],
      ["Commissions", 4545],
    ]);
    expect(row.lines.reduce((sum, l) => sum + l.cents, 0)).toBe(10000);
  });

  it("prefers the account on the line itself, and keeps an invoice with no sales lines whole", () => {
    const onLine = parseInvoice(
      {
        Id: "302",
        TxnDate: "2026-10-06",
        TotalAmt: 20,
        Balance: 20,
        Line: [
          sale("11", 20, {
            SalesItemLineDetail: {
              ItemRef: { value: "11" },
              ItemAccountRef: { value: "90", name: "Other sales" },
            },
          }),
        ],
      },
      items,
    )!;
    expect(onLine.lines).toEqual([
      {
        account_ref: "90",
        account: "Other sales",
        item: null,
        cents: 2000,
        description: "About 11",
      },
    ]);
    const bare = parseInvoice({ Id: "303", TxnDate: "2026-10-07", TotalAmt: 5, Line: [] }, items)!;
    expect(bare.lines).toEqual([
      { account_ref: null, account: null, item: null, cents: 500, description: "" },
    ]);
  });

  it("leaves out what isn't clear", () => {
    expect(parseInvoice({ Id: "", TxnDate: "2026-10-01" }, items)).toBeNull();
    expect(parseInvoice({ Id: "4", TxnDate: "October" }, items)).toBeNull();
    expect(parseInvoices({ QueryResponse: null }, items)).toEqual([]);
  });
});

describe("the QuickBooks sync and invoices", () => {
  const report = { Header: {}, Columns: { Column: [] }, Rows: { Row: [] } };
  function net(options: { failItems?: boolean; fullPage?: boolean } = {}) {
    const urls: string[] = [];
    const impl = (async (input: RequestInfo | URL) => {
      const url = decodeURIComponent(String(input).replace(/\+/g, " "));
      urls.push(url);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.includes("/companyinfo/")) return json({ CompanyInfo: { CompanyName: "Rugs" } });
      if (url.includes("/reports/")) return json(report);
      if (url.includes("from Item ")) {
        return options.failItems
          ? json({ Fault: {} }, 500)
          : json({
              QueryResponse: {
                Item: [{ Id: "11", IncomeAccountRef: { value: "79", name: "Class income" } }],
              },
            });
      }
      if (url.includes("from Invoice ")) {
        const page = url.includes("startposition 1 ") ? 0 : 1;
        const size = options.fullPage && page === 0 ? INVOICE_PAGE : 1;
        return json({
          QueryResponse: {
            Invoice: Array.from({ length: size }, (_, i) => ({
              Id: `${page}-${i}`,
              TxnDate: "2026-10-01",
              TotalAmt: 10,
              Balance: 0,
              Line: [sale("11", 10)],
            })),
          },
        });
      }
      if (url.includes("/query?")) return json({ QueryResponse: {} });
      return new Response("no route", { status: 599 });
    }) as Fetch;
    return { impl, urls };
  }
  const run = async (wanted: boolean, options: Parameters<typeof net>[0] = {}, fail = false) => {
    const { store, state } = memoryStore();
    state.bookExpensesWanted = wanted;
    state.bookInvoicesFail = fail;
    const wire = net(options);
    const result = await createQuickBooksAdapter(wire.impl).sync({
      externalAccountId: "4620816365",
      token: { access_token: "at" },
      store,
    } as unknown as SyncContext);
    return { state, urls: wire.urls, result };
  };

  it("doesn't read invoices for a workspace without Money", async () => {
    const { state, urls } = await run(false);
    expect(urls.some((url) => url.includes("from Invoice"))).toBe(false);
    expect(state.bookInvoices).toEqual([]);
  });

  it("reads invoices from three Januaries back with each item's account, and closes a full read", async () => {
    const { state, urls } = await run(true);
    const year = new Date().getUTCFullYear();
    expect(urls.filter((url) => url.includes("from Invoice"))[0]).toContain(
      `TxnDate >= '${year - 3}-01-01'`,
    );
    expect(state.bookInvoices.map((i) => i.row.lines[0].account)).toEqual(["Class income"]);
    expect(state.invoiceCloses).toEqual([
      { run: state.bookInvoices[0].run, since: `${year - 3}-01-01` },
    ]);
  });

  it("asks for the next page when one comes back full", async () => {
    const { state } = await run(true, { fullPage: true });
    expect(state.bookInvoices).toHaveLength(INVOICE_PAGE + 1);
  });

  it("still reads invoices when the item list can't be read, with the accounts unnamed", async () => {
    const { state } = await run(true, { failItems: true });
    expect(state.bookInvoices[0].row.lines[0].account).toBeNull();
  });

  it("finishes the sync when the database can't file invoices yet", async () => {
    const { result, state } = await run(true, {}, true);
    expect(result.cursor).toBeDefined();
    expect(state.invoiceCloses).toEqual([]);
  });
});
