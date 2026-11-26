import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadBooksState, loadDebtBook, loadDebtPayments, loadDebts } from "./data";

/** Made-up accounts: nothing here is a real lender, bank or account. */
function fake(tables: Record<string, unknown[]>, rpc: Record<string, unknown[]> = {}) {
  const calls: { table: string; filters: [string, string, unknown][] }[] = [];
  const client = {
    from(table: string) {
      const filters: [string, string, unknown][] = [];
      calls.push({ table, filters });
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => (filters.push(["eq", column, value]), chain),
        is: (column: string, value: unknown) => (filters.push(["is", column, value]), chain),
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: tables[table]?.[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: tables[table] ?? [], error: null }),
      };
      return chain;
    },
    rpc: (name: string) => Promise.resolve({ data: rpc[name] ?? [], error: null }),
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const debtRow = (over: Record<string, unknown>) => ({
  id: "d1",
  name: "Card One",
  kind: "card",
  plan: "pool",
  status: "active",
  rate_bp: 1999,
  minimum_cents: 2500,
  payment_cents: null,
  revolving_bp: null,
  due_day: null,
  priority: null,
  opening_cents: null,
  books_account: "Card One",
  note: null,
  source: "books",
  book_account_id: "a1",
  ...over,
});

describe("loading the debts", () => {
  it("asks only for debts not left out, and says which need a rate", async () => {
    const { client, calls } = fake(
      { money_debts: [debtRow({}), debtRow({ id: "d2", name: "Loan Two", rate_bp: null })] },
      {
        money_debt_current: [
          { debt_id: "d2", balance_cents: 50000, as_of: "2026-11-24", source: "books" },
        ],
      },
    );
    const debts = await loadDebts(client, "t1");
    expect(calls[0].filters).toContainEqual(["is", "left_out_at", null]);
    expect(debts.map((d) => [d.name, d.source, d.needsRate, d.rateBp, d.balance])).toEqual([
      ["Card One", "books", false, 1999, null],
      ["Loan Two", "books", true, 0, 50000],
    ]);
  });
});

describe("debts paid through a plan", () => {
  const rows = (): Record<string, Record<string, unknown>[]> => ({
    money_debts: [
      debtRow({
        id: "plan",
        name: "Card plan",
        plan: "fixed",
        source: "person",
        rate_bp: 0,
        minimum_cents: 0,
        payment_cents: 40000,
        book_account_id: null,
        books_account: null,
        consolidated: true,
        balance_from: "covered",
        plan_account_id: null,
      }),
      debtRow({ id: "c1", name: "Card One", covered_by: "plan" }),
      debtRow({ id: "c2", name: "Card Two", book_account_id: "a2", covered_by: "plan" }),
      debtRow({ id: "c3", name: "Card Three", book_account_id: "a3" }),
    ],
    money_book_accounts: [
      { id: "a1", name: "Card One", balance_cents: 70000, as_of: "2026-11-24", gone_at: null },
      { id: "a2", name: "Card Two", balance_cents: 30000, as_of: "2026-11-24", gone_at: null },
      { id: "a3", name: "Card Three", balance_cents: -1250, as_of: "2026-11-24", gone_at: null },
    ],
  });
  const current = {
    money_debt_current: [
      { debt_id: "c1", balance_cents: 70000, as_of: "2026-11-24", source: "books" },
      { debt_id: "c2", balance_cents: 30000, as_of: "2026-11-24", source: "books" },
      { debt_id: "c3", balance_cents: 0, as_of: "2026-11-24", source: "books" },
    ],
    money_debt_payments: [
      { debt_id: "c1", month: "2026-10-01", cents: 25000, payments: 1 },
      { debt_id: "c3", month: "2026-10-01", cents: 5000, payments: 1 },
    ],
  };

  it("hands everything else one debt for the plan, and keeps the covered ones beside it", async () => {
    const { client } = fake(rows(), current);
    const book = await loadDebtBook(client, "t1");
    expect(book.debts.map((d) => [d.id, d.balance])).toEqual([
      ["plan", 100000],
      ["c3", 0],
    ]);
    expect(book.debts[0].group?.covers.map((d) => d.id)).toEqual(["c1", "c2"]);
    expect(book.stored).toHaveLength(4);
    expect((await loadDebts(client, "t1")).map((d) => d.id)).toEqual(["plan", "c3"]);
    // A covered card's payments are the plan's.
    expect(await loadDebtPayments(client, "t1", "2026-10-01", "2026-12-01", book)).toEqual([
      { debtId: "plan", month: "2026-10", cents: 25000 },
      { debtId: "c3", month: "2026-10", cents: 5000 },
    ]);
  });

  it("leaves the covered cards and a plan's own account out of “Also in your books”", async () => {
    const tables = rows();
    tables.money_book_accounts.push({
      id: "a9",
      name: "Plan Company",
      balance_cents: 0,
      as_of: "2026-11-24",
      gone_at: null,
    });
    tables.money_debts[0] = { ...tables.money_debts[0], plan_account_id: "a9" };
    const { client } = fake(tables, current);
    const book = await loadDebtBook(client, "t1");
    const state = await loadBooksState(client, "t1", book.debts);
    expect(state.others).toEqual([]);
    expect(state.accounts.map((a) => a.id)).toEqual(["a1", "a3", "a2", "a9"]);
  });

  it("says a card the books show in credit is in credit, owing nothing", async () => {
    const { client } = fake(rows(), current);
    const card = (await loadDebts(client, "t1")).find((d) => d.id === "c3");
    expect(card).toMatchObject({ balance: 0, credit: 1250 });
  });

  it("reads debts saved before plans existed just as before", async () => {
    const { client } = fake({ money_debts: [debtRow({})] });
    const [d] = await loadDebts(client, "t1");
    expect(d).toMatchObject({
      consolidated: false,
      coveredBy: null,
      planBalanceFrom: null,
      credit: 0,
    });
  });
});

describe("the books' side of the debts", () => {
  it("lists the liabilities that aren't shown as debts, biggest first, and when they were read", async () => {
    const { client } = fake({
      money_book_accounts: [
        {
          id: "a1",
          name: "Card One",
          account_type: "Credit Card",
          account_subtype: "CreditCard",
          section: null,
          balance_cents: 9000,
          as_of: "2026-11-24",
          choice: null,
          seen_at: "2026-11-24T10:00:00Z",
        },
        {
          id: "a2",
          name: "Sales Tax Payable",
          account_type: "Other Current Liability",
          account_subtype: "SalesTaxPayable",
          section: null,
          balance_cents: 3100,
          as_of: "2026-11-24",
          choice: null,
          seen_at: "2026-11-24T10:00:00Z",
        },
        {
          id: "a3",
          name: "Deposits Held",
          account_type: null,
          account_subtype: null,
          section: "OtherCurrentLiabilities",
          balance_cents: 7000,
          as_of: "2026-11-24",
          choice: "not_debt",
          seen_at: "2026-11-24T10:00:00Z",
        },
        {
          id: "a4",
          name: "Gift Cards Owed",
          account_type: "Other Current Liability",
          account_subtype: null,
          section: null,
          balance_cents: 1200,
          as_of: "2026-11-24",
          choice: null,
          seen_at: "2026-11-24T10:00:00Z",
          hidden_at: "2026-11-25T09:00:00Z",
        },
      ],
      connections: [{ status: "active", last_synced_at: "2026-11-24T10:01:00Z" }],
    });
    const debts = await loadDebts(fake({ money_debts: [debtRow({})] }).client, "t1");
    const state = await loadBooksState(client, "t1", debts);
    expect(state.connected).toBe(true);
    expect(state.lastRead).toBe("2026-11-24T10:00:00Z");
    expect(state.others.map((o) => [o.name, o.typeWords, o.balance, o.markedNotDebt])).toEqual([
      ["Deposits Held", "Other Current Liability", 7000, true],
      ["Sales Tax Payable", "Sales Tax Payable", 3100, false],
    ]);
    // Hidden: only out of the list, kept for "Hidden (n)".
    expect(state.hidden.map((o) => [o.name, o.hidden])).toEqual([["Gift Cards Owed", true]]);
  });

  it("falls back to the last sync before the books were ever read for debts", async () => {
    const { client } = fake({
      connections: [{ status: "needs_reconnect", last_synced_at: "2026-11-01T08:00:00Z" }],
    });
    const state = await loadBooksState(client, "t1", []);
    expect(state).toEqual({
      connected: false,
      lastRead: "2026-11-01T08:00:00Z",
      others: [],
      hidden: [],
      accounts: [],
    });
  });
});
