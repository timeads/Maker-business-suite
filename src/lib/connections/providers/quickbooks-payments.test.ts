import { describe, expect, it } from "vitest";
import { memoryStore } from "../testing";
import type { Fetch, SyncContext } from "../types";
import { createQuickBooksAdapter } from "./quickbooks";
import { PAYMENT_PAGE, parsePayments, paymentsQuery } from "./quickbooks-payments";

describe("payments to suppliers in QuickBooks", () => {
  it("asks for one kind of record since a day, a page at a time", () => {
    expect(paymentsQuery("BillPayment", "2026-01-15", 0)).toBe(
      `select * from BillPayment where TxnDate >= '2026-01-15' orderby TxnDate startposition 1 maxresults ${PAYMENT_PAGE}`,
    );
    expect(paymentsQuery("Purchase", "2026-01-15", 2)).toContain(
      `startposition ${2 * PAYMENT_PAGE + 1} `,
    );
    // Only ever a plain day goes into the question.
    expect(() => paymentsQuery("Purchase", "2026-01-15' or '1'='1", 0)).toThrow();
  });

  it("reads bill payments by their vendor", () => {
    expect(
      parsePayments("BillPayment", {
        QueryResponse: {
          BillPayment: [
            {
              Id: "412",
              TxnDate: "2026-11-03",
              TotalAmt: 1200.5,
              VendorRef: { value: "9", name: " Hill Mill " },
              PrivateNote: "inv 70201",
            },
            { Id: "413", TxnDate: "2026-11-04", TotalAmt: 0, VendorRef: { name: "Hill Mill" } },
            { Id: "414", TxnDate: "not a day", TotalAmt: 5, VendorRef: { name: "Hill Mill" } },
            { Id: "415", TxnDate: "2026-11-04", TotalAmt: 5 },
          ],
        },
      }),
    ).toEqual([
      {
        external_id: "412",
        kind: "BillPayment",
        date: "2026-11-03",
        payee: "Hill Mill",
        amount: 1200.5,
        memo: "inv 70201",
      },
    ]);
  });

  it("reads a purchase only when it was made out to a vendor, and never a refund", () => {
    const rows = parsePayments("Purchase", {
      QueryResponse: {
        Purchase: [
          {
            Id: "7",
            TxnDate: "2026-11-05",
            TotalAmt: "88.10",
            EntityRef: { name: "Dye Works", type: "Vendor" },
          },
          {
            Id: "8",
            TxnDate: "2026-11-05",
            TotalAmt: 40,
            EntityRef: { name: "A Customer", type: "Customer" },
          },
          {
            Id: "9",
            TxnDate: "2026-11-05",
            TotalAmt: 40,
            Credit: true,
            EntityRef: { name: "Dye Works", type: "Vendor" },
          },
          { Id: "10", TxnDate: "2026-11-05", TotalAmt: 40 },
        ],
      },
    });
    expect(rows.map((row) => [row.external_id, row.payee, row.amount])).toEqual([
      ["7", "Dye Works", 88.1],
    ]);
    expect(parsePayments("Purchase", {})).toEqual([]);
    expect(parsePayments("Purchase", { QueryResponse: { Purchase: "nope" } })).toEqual([]);
  });
});

describe("the QuickBooks sync and supplier payments", () => {
  const report = { Header: {}, Columns: { Column: [] }, Rows: { Row: [] } };
  function net(paymentsFail = false) {
    const urls: string[] = [];
    const impl = (async (input: RequestInfo | URL) => {
      const url = decodeURIComponent(String(input).replace(/\+/g, " "));
      urls.push(url);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.includes("/companyinfo/"))
        return json({ CompanyInfo: { CompanyName: "Alice Rugs" } });
      if (url.includes("/reports/")) return json(report);
      if (url.includes("/query?")) {
        if (paymentsFail) return json({ Fault: {} }, 500);
        if (url.includes("from BillPayment")) {
          return json({
            QueryResponse: {
              BillPayment: [
                { Id: "1", TxnDate: "2026-11-03", TotalAmt: 50, VendorRef: { name: "Hill Mill" } },
              ],
            },
          });
        }
        return json({ QueryResponse: {} });
      }
      return new Response("no route", { status: 599 });
    }) as Fetch;
    return { impl, urls };
  }
  const run = async (wanted: boolean, paymentsFail = false) => {
    const { store, state } = memoryStore();
    state.bookPaymentsWanted = wanted;
    const wire = net(paymentsFail);
    const result = await createQuickBooksAdapter(wire.impl).sync({
      externalAccountId: "4620816365",
      token: { access_token: "at" },
      store,
    } as unknown as SyncContext);
    return { state, urls: wire.urls, result };
  };

  it("doesn't read the books for payments unless the workspace asked", async () => {
    const { state, urls } = await run(false);
    expect(urls.some((url) => url.includes("/query?"))).toBe(false);
    expect(state.bookPayments).toEqual([]);
    expect(state.usage).toBe(4);
  });

  it("hands over what it read when asked, and only ever reads", async () => {
    const { state, urls } = await run(true);
    const queries = urls.filter((url) => url.includes("/query?"));
    expect(queries).toHaveLength(2);
    expect(
      queries.every((url) => /query=select \* from (BillPayment|Purchase) where/.test(url)),
    ).toBe(true);
    expect(state.bookPayments).toEqual([
      {
        external_id: "1",
        kind: "BillPayment",
        date: "2026-11-03",
        payee: "Hill Mill",
        amount: 50,
        memo: "",
      },
    ]);
    expect(state.usage).toBe(6);
  });

  it("still finishes the sync when the payments can't be read", async () => {
    const { state, result } = await run(true, true);
    expect(state.bookPayments).toEqual([]);
    expect(result.cursor).toBeDefined();
  });
});
