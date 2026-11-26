import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  decideExpense,
  decisionPayload,
  expenseSortingSchema,
  factsOfRow,
  type ExpenseSorting,
} from "../../src/lib/dashboard/expenses";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Money's expenses sorted by the books' own accounts: one choice per
 * account sorts every expense in it, past and future; an account with no
 * choice counts as shared and never waits in the inbox; a person's choice,
 * a rule and a payee default still make exceptions. All made-up names.
 */

type User = { id: string; email: string };

let db: PGlite;
let olive: User; // owner of A
let pip: User; // plain member of A
let quinn: User; // owner of B
let tenantA: string;
let tenantB: string;

const RUN_1 = "11111111-1111-4111-8111-111111111111";
const RUN_2 = "22222222-2222-4222-8222-222222222222";
const LINES = new Set(["shop", "classes"]);

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'America/New_York', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

const as = <T = Record<string, unknown>>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);

const expense = (id: string, extra: Record<string, unknown> = {}) => ({
  entity: "Purchase",
  external_id: id,
  kind: "purchase",
  payment_type: "CreditCard",
  date: "2026-10-05",
  amount_cents: 1000,
  account: "Supplies",
  account_ref: "61",
  payee: "Felt Folk",
  memo: "",
  from_account: null,
  lines: [{ account: "Supplies", amount_cents: 1000, description: "" }],
  ...extra,
});

const file = (tenant: string, run: string, rows: unknown[]) =>
  asService(db, async (tx) => {
    const { rows: out } = await tx.query<{ result: Record<string, number> }>(
      "select public.file_book_expenses($1, 'quickbooks', $2, $3::jsonb) as result",
      [tenant, run, JSON.stringify(rows)],
    );
    return out[0].result;
  });

type Row = {
  id: string;
  sort: string | null;
  line_id: string | null;
  split: Record<string, number> | null;
  sorted_by: string | null;
  suggested: Record<string, unknown> | null;
  account_ref: string | null;
  location: string | null;
  lines: { account: string | null; class?: string }[];
};
const row = async (tenant: string, externalId: string) =>
  (
    await db.query<Row>(
      `select id, sort, line_id, split, sorted_by, suggested, account_ref, location, lines
       from public.book_expenses where tenant_id = $1 and external_id = $2`,
      [tenant, externalId],
    )
  ).rows[0];

const saveSorting = (body: Partial<ExpenseSorting>) =>
  as(olive, "select public.save_config($1, 'dashboard', 'expenses', $2::jsonb)", [
    tenantA,
    JSON.stringify({ version: 1, vendors: [], rules: [], accounts: [], ...body }),
  ]);

const apply = async () =>
  (
    await as<{ r: Record<string, number> }>(
      olive,
      "select public.apply_expense_accounts($1) as r",
      [tenantA],
    )
  )[0].r;

beforeAll(async () => {
  db = await createTestDb();
  olive = { id: await createUser(db, "olive@a.test"), email: "olive@a.test" };
  pip = { id: await createUser(db, "pip@a.test"), email: "pip@a.test" };
  quinn = { id: await createUser(db, "quinn@b.test"), email: "quinn@b.test" };
  tenantA = await tenantFor(olive, "Olive Weaves");
  tenantB = await tenantFor(quinn, "Quinn Glass");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, pip.id],
  );
  await as(olive, "select public.save_config($1, 'dashboard', 'revenue', $2::jsonb)", [
    tenantA,
    JSON.stringify({
      version: 1,
      figure: "net_sales",
      by_class_date: false,
      lines: [
        { id: "shop", name: "Shop" },
        { id: "classes", name: "Classes" },
      ],
      default_line: "shop",
      rules: [],
    }),
  ]);
});

describe("with no choices yet", () => {
  it("counts every expense as shared and leaves the inbox empty", async () => {
    const result = await file(tenantA, RUN_1, [
      expense("1"),
      expense("2", { account: "Rent", account_ref: "62", payee: "Landlady" }),
      // Read by earlier code: no account id. Its name still decides.
      expense("3", { account_ref: undefined }),
      expense("9", { entity: "Transfer", kind: "transfer", account: "Card", account_ref: "70" }),
    ]);
    expect(result.by_account).toBe(3);
    for (const id of ["1", "2", "3"]) {
      expect(await row(tenantA, id)).toMatchObject({ sort: "shared", sorted_by: "account" });
    }
    // A move is never sorted.
    expect((await row(tenantA, "9")).sort).toBeNull();
    const [{ n }] = await as<{ n: number }>(
      pip,
      "select coalesce(sum(to_sort), 0)::int as n from public.money_expense_months($1)",
      [tenantA],
    );
    expect(n).toBe(0);
  });

  it("keeps each line's class and the record's location, for rules", async () => {
    await file(tenantA, RUN_1, [
      expense("4", {
        location: "Market Stall",
        lines: [{ account: "Supplies", amount_cents: 1000, description: "", class: "Workshops" }],
      }),
    ]);
    const four = await row(tenantA, "4");
    expect(four.location).toBe("Market Stall");
    expect(four.lines[0].class).toBe("Workshops");
    // A line with no class carries none.
    expect((await row(tenantA, "1")).lines[0]).not.toHaveProperty("class");
  });
});

describe("one choice per account", () => {
  it("sorts every expense in the account at once, past and future", async () => {
    await saveSorting({
      accounts: [{ ref: "61", name: "Supplies", action: { sort: "line", line: "shop" } }],
    });
    const result = await apply();
    expect(result.sorted).toBe(3); // "1", "3" (by its name) and "4"
    expect(await row(tenantA, "1")).toMatchObject({
      sort: "line",
      line_id: "shop",
      sorted_by: "account",
    });
    expect((await row(tenantA, "3")).line_id).toBe("shop");
    expect((await row(tenantA, "2")).sort).toBe("shared");
    // A new one from the sync follows straight away.
    await file(tenantA, RUN_1, [expense("5")]);
    expect((await row(tenantA, "5")).line_id).toBe("shop");
    // Pressing again changes nothing.
    expect(await apply()).toEqual({ sorted: 0, inbox: 0 });
  });

  it("follows the account through a rename in the books", async () => {
    await file(tenantA, RUN_1, [expense("6", { account: "Supplies and Yarn" })]);
    expect((await row(tenantA, "6")).line_id).toBe("shop");
  });

  it("changes many expenses in one checked statement", async () => {
    const many = Array.from({ length: 600 }, (_, i) =>
      expense(`m-${i}`, { account: "Fees", account_ref: "63", payee: `Payee ${i % 7}` }),
    );
    await file(tenantA, RUN_1, many.slice(0, 300));
    await file(tenantA, RUN_1, many.slice(300));
    await saveSorting({
      accounts: [
        { ref: "61", name: "Supplies", action: { sort: "line", line: "shop" } },
        { ref: "63", name: "Fees", action: { sort: "split", split: { shop: 70, classes: 30 } } },
      ],
    });
    expect((await apply()).sorted).toBe(600);
    expect((await row(tenantA, "m-599")).split).toEqual({ shop: 70, classes: 30 });
  });

  it("sends an account set to decide each one to the inbox, and back out when changed", async () => {
    await saveSorting({
      accounts: [
        { ref: "61", name: "Supplies", action: { sort: "line", line: "shop" } },
        { ref: "63", name: "Fees", action: { sort: "each" } },
      ],
    });
    expect((await apply()).inbox).toBe(600);
    expect(await row(tenantA, "m-0")).toMatchObject({ sort: null, sorted_by: null });
    // A new expense in that account waits too.
    await file(tenantA, RUN_1, [expense("m-new", { account: "Fees", account_ref: "63" })]);
    expect((await row(tenantA, "m-new")).sort).toBeNull();
    await saveSorting({
      accounts: [
        { ref: "61", name: "Supplies", action: { sort: "line", line: "shop" } },
        { ref: "63", name: "Fees", action: { sort: "set_aside" } },
      ],
    });
    expect((await apply()).sorted).toBe(601);
    expect((await row(tenantA, "m-new")).sort).toBe("set_aside");
  });

  it("passes over a choice naming a line the workspace no longer has", async () => {
    await saveSorting({
      accounts: [{ ref: "61", name: "Supplies", action: { sort: "line", line: "gone" } }],
    });
    await apply();
    expect((await row(tenantA, "1")).sort).toBe("shared");
  });
});

describe("exceptions", () => {
  it("never changes what a person sorted", async () => {
    await saveSorting({
      accounts: [{ ref: "61", name: "Supplies", action: { sort: "line", line: "shop" } }],
    });
    await apply();
    const id = (await row(tenantA, "1")).id;
    await as(olive, "select public.sort_book_expenses($1, $2::uuid[], 'line', 'classes', null)", [
      tenantA,
      `{${id}}`,
    ]);
    await saveSorting({
      accounts: [{ ref: "61", name: "Supplies", action: { sort: "set_aside" } }],
    });
    await apply();
    await file(tenantA, RUN_2, [expense("1")]);
    expect(await row(tenantA, "1")).toMatchObject({ line_id: "classes", sorted_by: "person" });
    expect((await row(tenantA, "5")).sort).toBe("set_aside");
  });

  it("lets a rule or payee default speak before the account", async () => {
    await file(tenantA, RUN_2, [
      expense("5", { auto: { sort: "line", line: "classes", source: "vendor", rule: "v-1" } }),
    ]);
    expect(await row(tenantA, "5")).toMatchObject({ line_id: "classes", sorted_by: "vendor" });
    // A rule that only suggests takes it back to the inbox, suggestion beside it.
    await file(tenantA, RUN_2, [
      expense("6", {
        account: "Supplies and Yarn",
        suggest: { sort: "shared", source: "rule", rule: "r-1", reason: "words" },
      }),
    ]);
    expect(await row(tenantA, "6")).toMatchObject({
      sort: null,
      suggested: { source: "rule" },
    });
  });

  it("keeps what a person put back in the inbox there", async () => {
    const id = (await row(tenantA, "3")).id;
    await as(olive, "select public.sort_book_expenses($1, $2::uuid[], 'none')", [
      tenantA,
      `{${id}}`,
    ]);
    await apply();
    await file(tenantA, RUN_2, [expense("3")]);
    expect((await row(tenantA, "3")).sort).toBeNull();
  });
});

describe("who can do what", () => {
  it("lets only owners and admins apply, and only to their own workspace", async () => {
    await expect(as(pip, "select public.apply_expense_accounts($1)", [tenantA])).rejects.toThrow(
      /owners and admins/,
    );
    await expect(as(quinn, "select public.apply_expense_accounts($1)", [tenantA])).rejects.toThrow(
      /owners and admins/,
    );
  });

  it("lists the accounts to the whole team, and to nobody outside it", async () => {
    await file(tenantA, RUN_2, [expense("no-id", { account_ref: null })]);
    const list = await as<{
      account_ref: string | null;
      account: string;
      recent: string;
      recent_cents: string;
      to_sort: string;
    }>(
      pip,
      "select account_ref, account, recent::text, recent_cents::text, to_sort::text from public.money_expense_accounts($1, '2025-11-01')",
      [tenantA],
    );
    const fees = list.find((a) => a.account_ref === "63");
    expect(fees).toMatchObject({ account: "Fees", recent: "601", recent_cents: "601000" });
    // The latest name the books used for the account.
    expect(list.find((a) => a.account_ref === "61")?.account).toBe("Supplies");
    // An expense read without an id is listed under its name.
    expect(list.some((a) => a.account_ref === null && a.account === "Supplies")).toBe(true);
    expect(
      await as(quinn, "select * from public.money_expense_accounts($1, '2025-01-01')", [tenantA]),
    ).toEqual([]);
    await file(tenantB, RUN_1, [expense("1")]);
    expect((await row(tenantB, "1")).sort).toBe("shared");
  });
});

describe("the database and decideExpense agree", () => {
  it("on the account step, case by case", async () => {
    const body: ExpenseSorting = expenseSortingSchema.parse({
      version: 1,
      accounts: [
        { ref: "81", name: "Postage", action: { sort: "line", line: "shop" } },
        {
          ref: null,
          name: "Studio Rent",
          action: { sort: "split", split: { shop: 40, classes: 60 } },
        },
        { ref: "83", name: "Odds", action: { sort: "each" } },
        { ref: "84", name: "Draws", action: { sort: "set_aside" } },
        { ref: "85", name: "Old", action: { sort: "line", line: "gone" } },
      ],
    });
    await saveSorting(body);
    const cases = [
      { id: "t-1", account: "Postage", account_ref: "81" },
      { id: "t-2", account: "Postage Renamed", account_ref: "81" },
      { id: "t-3", account: "Postage", account_ref: "99" },
      { id: "t-4", account: "Postage", account_ref: null },
      { id: "t-5", account: "Studio Rent", account_ref: "82" },
      { id: "t-6", account: "studio rent", account_ref: null },
      { id: "t-7", account: "Odds", account_ref: "83" },
      { id: "t-8", account: "Draws", account_ref: "84" },
      { id: "t-9", account: "Old", account_ref: "85" },
      { id: "t-10", account: null, account_ref: null },
    ];
    const rows = cases.map((c) =>
      expense(c.id, { account: c.account, account_ref: c.account_ref, payee: "Nobody Known" }),
    );
    // The worker's own payloads: nothing for the account step.
    for (const r of rows) {
      expect(decisionPayload(body, LINES, factsOfRow(r))).toEqual({});
    }
    await file(tenantA, RUN_2, rows);
    for (const r of rows) {
      const decided = decideExpense(body, LINES, factsOfRow(r));
      const stored = await row(tenantA, r.external_id);
      const action = decided?.action;
      expect({
        sort: stored.sort,
        line: stored.line_id,
        split: stored.split,
      }).toEqual({
        sort: action?.sort ?? null,
        line: action?.sort === "line" ? action.line : null,
        split: action?.sort === "split" ? action.split : null,
      });
    }
  });
});
