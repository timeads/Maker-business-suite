import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Money's expenses: filed from the books by the sync, sorted by a person or
 * by the workspace's rules, never across workspaces, and never by a rule
 * over a person's choice.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let carol: User; // plain member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;

const RUN_1 = "11111111-1111-4111-8111-111111111111";
const RUN_2 = "22222222-2222-4222-8222-222222222222";

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
  amount_cents: 12345,
  account: "Supplies",
  payee: "Yarn Barn",
  memo: "Wool",
  from_account: null,
  lines: [{ account: "Supplies", amount_cents: 12345, description: "Wool cones" }],
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

const row = async (tenant: string, externalId: string, entity = "Purchase") =>
  (
    await db.query<{
      id: string;
      sort: string | null;
      line_id: string | null;
      split: Record<string, number> | null;
      sorted_by: string | null;
      amount_cents: string;
      removed_at: string | null;
      is_move: boolean;
      suggested: Record<string, unknown> | null;
      rules_off: boolean;
      search_text: string;
    }>(
      `select id, sort, line_id, split, sorted_by, amount_cents::text, removed_at::text, is_move,
              suggested, rules_off, search_text
       from public.book_expenses where tenant_id = $1 and entity = $2 and external_id = $3`,
      [tenant, entity, externalId],
    )
  ).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, carol.id],
  );
  const lines = {
    version: 1,
    figure: "net_sales",
    by_class_date: false,
    lines: [
      { id: "shop", name: "Shop" },
      { id: "classes", name: "Classes" },
    ],
    default_line: "shop",
    rules: [],
  };
  await as(alice, "select public.save_config($1, 'dashboard', 'revenue', $2::jsonb)", [
    tenantA,
    JSON.stringify(lines),
  ]);
  // These tests are about the inbox: "Supplies" is an account set to "decide
  // each one", so its expenses wait there as before. Sorting by account has
  // its own tests (money-expense-accounts.test.ts).
  await as(alice, "select public.save_config($1, 'dashboard', 'expenses', $2::jsonb)", [
    tenantA,
    JSON.stringify({
      version: 1,
      vendors: [],
      rules: [],
      accounts: [{ ref: null, name: "Supplies", action: { sort: "each" } }],
    }),
  ]);
});

describe("filing from the books", () => {
  it("keeps each record once, by the books' own kind and id, and follows a change", async () => {
    await file(tenantA, RUN_1, [
      expense("1"),
      expense("2", { payee: "Studio Landlord", account: "Rent", amount_cents: 100000 }),
      expense("9", { entity: "Transfer", kind: "transfer", payee: null, account: "Card" }),
    ]);
    const again = await file(tenantA, RUN_1, [expense("1", { amount_cents: 13000 })]);
    expect(again.read).toBe(1);
    const one = await row(tenantA, "1");
    expect(one.amount_cents).toBe("13000");
    expect(one.search_text).toContain("wool cones");
    expect((await row(tenantA, "9", "Transfer")).is_move).toBe(true);
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.book_expenses where tenant_id = $1",
      [tenantA],
    );
    expect(rows[0].n).toBe(3);
  });

  it("refuses rows it can't read, and takes nothing from a member", async () => {
    const result = await file(tenantA, RUN_1, [expense("", {}), expense("x", { kind: "gift" })]);
    expect(result.bad).toBe(2);
    await expect(
      as(carol, "select public.file_book_expenses($1, 'quickbooks', $2, '[]'::jsonb)", [
        tenantA,
        RUN_1,
      ]),
    ).rejects.toThrow();
  });

  it("sorts a new expense by a rule, and only suggests when the rule says so", async () => {
    await file(tenantA, RUN_1, [
      expense("3", {
        payee: "Glue Co",
        auto: { sort: "line", line: "shop", source: "vendor", rule: "v-1" },
      }),
      expense("4", {
        payee: "Paper Co",
        suggest: { sort: "line", line: "classes", source: "rule", rule: "r-1", reason: "memo" },
      }),
      // A rule naming a line the workspace doesn't have is ignored.
      expense("5", { auto: { sort: "line", line: "nope", source: "rule", rule: "r-2" } }),
      // A move is never sorted.
      expense("10", {
        entity: "CreditCardPayment",
        kind: "card_payment",
        auto: { sort: "set_aside", source: "rule", rule: "r-3" },
      }),
    ]);
    expect(await row(tenantA, "3")).toMatchObject({
      sort: "line",
      line_id: "shop",
      sorted_by: "vendor",
    });
    const four = await row(tenantA, "4");
    expect(four.sort).toBeNull();
    expect(four.suggested).toMatchObject({ sort: "line", line: "classes", source: "rule" });
    expect((await row(tenantA, "5")).sort).toBeNull();
    expect((await row(tenantA, "10", "CreditCardPayment")).sort).toBeNull();
  });

  it("marks what the books no longer hold, only for kinds read in full", async () => {
    await file(tenantA, RUN_2, [expense("1"), expense("2"), expense("3"), expense("4")]);
    const closed = await asService(db, async (tx) => {
      const { rows } = await tx.query<{ n: number }>(
        "select public.close_book_expenses($1, 'quickbooks', $2, '2026-01-01', array['Purchase']) as n",
        [tenantA, RUN_2],
      );
      return rows[0].n;
    });
    expect(closed).toBe(1); // "5" was not seen again
    expect((await row(tenantA, "5")).removed_at).not.toBeNull();
    expect((await row(tenantA, "9", "Transfer")).removed_at).toBeNull();
    // Seen again later: back.
    await file(tenantA, RUN_2, [expense("5")]);
    expect((await row(tenantA, "5")).removed_at).toBeNull();
  });
});

describe("sorting by a person", () => {
  it("lets an owner sort, split, share or set aside, and checks the split", async () => {
    const ids = [(await row(tenantA, "1")).id, (await row(tenantA, "2")).id];
    const [{ n }] = await as<{ n: number }>(
      alice,
      `select public.sort_book_expenses($1, $2::uuid[], 'split', null, '{"shop":60,"classes":40}'::jsonb) as n`,
      [tenantA, `{${ids.join(",")}}`],
    );
    expect(n).toBe(2);
    expect(await row(tenantA, "1")).toMatchObject({
      sort: "split",
      split: { shop: 60, classes: 40 },
      sorted_by: "person",
    });
    for (const split of ['{"shop":60,"classes":30}', '{"shop":100}', '{"shop":50,"gone":50}']) {
      await expect(
        as(alice, "select public.sort_book_expenses($1, $2::uuid[], 'split', null, $3::jsonb)", [
          tenantA,
          `{${ids[0]}}`,
          split,
        ]),
      ).rejects.toThrow(/sorted/);
    }
    await expect(
      as(alice, "select public.sort_book_expenses($1, $2::uuid[], 'line', 'gone', null)", [
        tenantA,
        `{${ids[0]}}`,
      ]),
    ).rejects.toThrow(/sorted/);
  });

  it("never lets a later rule or sync change a person's choice", async () => {
    const id = (await row(tenantA, "1")).id;
    await file(tenantA, RUN_2, [
      expense("1", { auto: { sort: "set_aside", source: "rule", rule: "r-9" } }),
    ]);
    expect((await row(tenantA, "1")).sort).toBe("split");
    const [{ result }] = await as<{ result: Record<string, number> }>(
      alice,
      "select public.note_expense_decisions($1, $2::jsonb) as result",
      [tenantA, JSON.stringify([{ id, auto: { sort: "set_aside", source: "rule", rule: "r-9" } }])],
    );
    expect(result.sorted).toBe(0);
  });

  it("keeps rules off an expense a person put back in the inbox", async () => {
    const id = (await row(tenantA, "3")).id;
    await as(alice, "select public.sort_book_expenses($1, $2::uuid[], 'none')", [
      tenantA,
      `{${id}}`,
    ]);
    expect(await row(tenantA, "3")).toMatchObject({ sort: null, rules_off: true });
    await file(tenantA, RUN_2, [
      expense("3", { auto: { sort: "line", line: "shop", source: "vendor", rule: "v-1" } }),
    ]);
    expect((await row(tenantA, "3")).sort).toBeNull();
  });

  it("takes Claude's answer only as a suggestion", async () => {
    const id = (await row(tenantA, "4")).id;
    const [{ result }] = await as<{ result: Record<string, number> }>(
      alice,
      "select public.note_expense_decisions($1, $2::jsonb) as result",
      [
        tenantA,
        JSON.stringify([
          {
            id,
            auto: { sort: "line", line: "shop", source: "ai" },
            suggest: { sort: "line", line: "shop", source: "ai", reason: "Glue for rugs" },
          },
        ]),
      ],
    );
    expect(result).toEqual({ sorted: 0, suggested: 1 });
    expect(await row(tenantA, "4")).toMatchObject({
      sort: null,
      suggested: { source: "ai", line: "shop" },
    });
    // A later sync with no rule for it keeps Claude's suggestion.
    await file(tenantA, RUN_2, [expense("4")]);
    expect((await row(tenantA, "4")).suggested).toMatchObject({ source: "ai" });
  });

  it("refuses plain members and other workspaces", async () => {
    const id = (await row(tenantA, "4")).id;
    await expect(
      as(carol, "select public.sort_book_expenses($1, $2::uuid[], 'shared')", [tenantA, `{${id}}`]),
    ).rejects.toThrow(/owners and admins/);
    await expect(
      as(bob, "select public.sort_book_expenses($1, $2::uuid[], 'shared')", [tenantA, `{${id}}`]),
    ).rejects.toThrow(/owners and admins/);
    // Bob naming his own workspace changes nothing of Alice's.
    const [{ n }] = await as<{ n: number }>(
      bob,
      "select public.sort_book_expenses($1, $2::uuid[], 'set_aside') as n",
      [tenantB, `{${id}}`],
    );
    expect(n).toBe(0);
    expect((await row(tenantA, "4")).sort).toBeNull();
  });
});

describe("reading", () => {
  it("shows the whole team its own workspace's expenses, and nobody else's", async () => {
    await file(tenantB, RUN_1, [expense("1", { payee: "Kiln Parts" })]);
    const mine = await as<{ payee: string }>(carol, "select payee from public.book_expenses");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((r) => r.payee === "Kiln Parts")).toBe(false);
    const bobs = await as<{ payee: string }>(bob, "select payee from public.book_expenses");
    expect(bobs.map((r) => r.payee)).toEqual(["Kiln Parts"]);
    await expect(
      asAnon(db, (tx) => tx.query("select 1 from public.book_expenses")),
    ).rejects.toThrow();
    await expect(
      as(carol, "update public.book_expenses set sort = 'shared' where tenant_id = $1", [tenantA]),
    ).rejects.toThrow();
  });

  it("adds expenses up by month and by way of sorting, leaving out moves and removed ones", async () => {
    const months = await as<{ month: string; to_sort: string; all_count: string }>(
      carol,
      "select month, to_sort::text, all_count::text from public.money_expense_months($1)",
      [tenantA],
    );
    expect(months).toEqual([{ month: "2026-10", to_sort: "3", all_count: "5" }]);
    const totals = await as<{ sort: string | null; cents: string }>(
      carol,
      "select sort, cents::text from public.money_expense_totals($1, '2026-10-01', '2026-11-01', 'month')",
      [tenantA],
    );
    const total = totals.reduce((sum, t) => sum + Number(t.cents), 0);
    expect(total).toBe(12345 * 4 + 12345); // "1","2","3","4","5" as last filed
    const bobSees = await as(
      bob,
      "select * from public.money_expense_totals($1, '2026-01-01', '2027-01-01')",
      [tenantA],
    );
    expect(bobSees).toEqual([]);
  });

  it("adds up the shop's item costs where an item has one", async () => {
    const order = (id: string, extra: Record<string, unknown>, lines: unknown[]) => ({
      external_id: id,
      name: `#${id}`,
      processed_at: "2026-10-10T15:00:00Z",
      currency: "USD",
      net_sales: 100,
      total: 100,
      channel: "Online Store",
      financial_status: "PAID",
      tags: ["Wholesale"],
      lines,
      ...extra,
    });
    await asService(db, (tx) =>
      tx.query(
        "select public.upsert_commerce_batch($1, 'shopify', '[]'::jsonb, '[]'::jsonb, $2::jsonb)",
        [
          tenantA,
          JSON.stringify([
            order("5001", {}, [
              {
                external_id: "a",
                title: "Rug",
                product_external_id: "801",
                quantity: 2,
                unit_price: 40,
                unit_cost: 12.5,
              },
              {
                external_id: "b",
                title: "Card",
                product_external_id: "802",
                quantity: 1,
                unit_price: 20,
              },
            ]),
            order("5002", { cancelled_at: "2026-10-11T00:00:00Z" }, [
              {
                external_id: "a",
                title: "Rug",
                product_external_id: "801",
                quantity: 1,
                unit_price: 40,
                unit_cost: 12.5,
              },
            ]),
          ]),
        ],
      ),
    );
    const costs = await as<{
      product_external_id: string;
      cost_cents: string;
      order_tags: string[];
    }>(
      carol,
      "select product_external_id, cost_cents::text, order_tags from public.money_line_item_costs($1, '2026-10-01', '2026-11-01')",
      [tenantA],
    );
    expect(costs).toEqual([
      { product_external_id: "801", cost_cents: "2500", order_tags: ["Wholesale"] },
    ]);
    expect(
      await as(bob, "select * from public.money_line_item_costs($1, '2026-01-01', '2027-01-01')", [
        tenantA,
      ]),
    ).toEqual([]);
  });

  it("erases a disconnected provider's expenses", async () => {
    await asService(db, (tx) =>
      tx.query("select public.purge_provider_data($1, 'quickbooks')", [tenantB]),
    );
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.book_expenses where tenant_id = $1",
      [tenantB],
    );
    expect(rows[0].n).toBe(0);
  });
});
