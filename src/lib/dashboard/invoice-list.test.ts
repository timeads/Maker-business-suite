import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadInvoiceList } from "./invoice-list";
import { parseInvoiceQuery } from "./invoices";
import { revenueSettingsSchema } from "./lines";

/** Money → Invoices' loader: what it asks the database, and each row's line in words. */

const revenue = revenueSettingsSchema.parse({
  version: 1,
  lines: [
    { id: "shop", name: "Shop" },
    { id: "classes", name: "Classes" },
  ],
  default_line: "shop",
  books: {
    invoices: false,
    accounts: [{ ref: "79", name: "Class income", choice: { line: "classes" } }],
    customers: [{ ref: "7", name: "Maple Library", choice: { line: "shop" } }],
  },
});

const row = (over: Record<string, unknown>) => ({
  id: "00000000-0000-4000-8000-000000000001",
  doc_number: "1001",
  customer_ref: null,
  customer: "Elm Goods",
  txn_date: "2026-10-05",
  due_date: null,
  total_cents: "11000",
  balance_cents: "0",
  memo: "",
  lines: [{ account_ref: "79", account: "Class income", cents: 10000 }],
  sort: null,
  line_id: null,
  split: null,
  status: "paid",
  total_count: "3",
  ...over,
});

function fake(answers: Record<string, () => { data: unknown; error: unknown }>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const supabase = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return Promise.resolve(answers[fn]?.() ?? { data: [], error: null });
    },
  } as unknown as SupabaseClient;
  return { supabase, calls };
}

describe("the invoice list's loader", () => {
  it("hands the setting to the database's filter and words each row by the one rule", async () => {
    const { supabase, calls } = fake({
      money_invoice_sorted_list: () => ({
        data: [
          row({}),
          row({ id: "2", sort: "split", split: { shop: 40, classes: 60 }, balance_cents: "5" }),
          row({ id: "3", customer_ref: "7", customer: "Maple Library" }),
        ],
        error: null,
      }),
    });
    const query = parseInvoiceQuery({ line: "classes", q: "maple" });
    const { rows, total } = await loadInvoiceList(supabase, "t1", revenue, query, "2026-11-20", {
      limit: 50,
      offset: 0,
    });
    expect(calls[0].fn).toBe("money_invoice_sorted_list");
    expect(calls[0].args).toMatchObject({
      p_tenant_id: "t1",
      p_line: "classes",
      p_waiting: false,
      p_q: "%maple%",
      p_sorting: {
        lines: ["shop", "classes"],
        accounts: [{ ref: "79", name: "Class income", place: "line:classes" }],
        customers: [{ ref: "7", name: "Maple Library", place: "line:shop" }],
      },
    });
    expect(total).toBe(3);
    expect(rows.map((r) => [r.place.line, r.place.why, r.by])).toEqual([
      ["Classes", "From its income account", "account"],
      ["60% Classes, 40% Shop", "Your choice", "person"],
      ["Shop", "Your choice for this customer", "customer"],
    ]);
    // Invoices aren't counted yet: each row's "Why?" says so.
    expect(rows[0].why.join(" ")).toMatch(/switch on/);
    expect(rows[1].why.join(" ")).toMatch(/to the cent/);
  });

  it("asks for only what's waiting with “Not sorted yet”", async () => {
    const { supabase, calls } = fake({});
    await loadInvoiceList(
      supabase,
      "t1",
      revenue,
      parseInvoiceQuery({ waiting: "1" }),
      "2026-11-20",
      { limit: 50, offset: 0 },
    );
    expect(calls[0].args).toMatchObject({ p_line: null, p_waiting: true });
  });

  it("falls back to the earlier list on a database from before this", async () => {
    const { supabase, calls } = fake({
      money_invoice_sorted_list: () => ({ data: null, error: { code: "PGRST202", message: "x" } }),
      money_invoice_list: () => ({ data: [row({})], error: null }),
    });
    const { rows } = await loadInvoiceList(
      supabase,
      "t1",
      revenue,
      parseInvoiceQuery({ line: "classes" }),
      "2026-11-20",
      { limit: 50, offset: 0 },
    );
    expect(calls.map((c) => c.fn)).toEqual(["money_invoice_sorted_list", "money_invoice_list"]);
    expect(calls[1].args).toMatchObject({ p_account_refs: ["79"], p_account_names: [] });
    expect(calls[1].args).not.toHaveProperty("p_sorting");
    expect(rows[0].place.line).toBe("Classes");
  });
});
