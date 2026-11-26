import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Debt payoff and the emergency fund are for a workspace's owners and admins
 * ONLY. The database holds that line: a plain member reads nothing of it
 * (no debt, balance, payment into a debt, plan month, saved what-if or the
 * plan's setting), can't write any of it, and nobody reads across
 * workspaces. Everything a member could read before still reads the same.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let dan: User; // admin of A
let carol: User; // plain member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;
let cardA: string;
let loanA: string;

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

const saveDebt = async (
  user: User,
  tenant: string,
  fields: Record<string, unknown>,
  id: string | null = null,
) =>
  (
    await as<{ id: string }>(user, "select public.save_money_debt($1, $2, $3::jsonb) as id", [
      tenant,
      id,
      JSON.stringify(fields),
    ])
  )[0].id;

const CARD = {
  name: "Studio card",
  kind: "card",
  plan: "pool",
  status: "active",
  rate_bp: 2299,
  minimum_cents: 5000,
  payment_cents: null,
  revolving_bp: null,
  due_day: 12,
  priority: 1,
  opening_cents: 500000,
  books_account: "Studio  Card",
  note: null,
};

const move = (id: string, account: string, date: string, cents: number, kind = "card_payment") => ({
  entity: kind === "transfer" ? "Transfer" : "CreditCardPayment",
  external_id: id,
  kind,
  payment_type: null,
  date,
  amount_cents: cents,
  account,
  payee: null,
  memo: "",
  from_account: "Operating",
  lines: [],
});

const fileExpenses = (tenant: string, rows: unknown[]) =>
  asService(db, (tx) =>
    tx.query("select public.file_book_expenses($1, 'quickbooks', gen_random_uuid(), $2::jsonb)", [
      tenant,
      JSON.stringify(rows),
    ]),
  );

const fromBooks = (tenant: string, asOf: string, rows: unknown[]) =>
  asService(db, async (tx) => {
    const { rows: out } = await tx.query<{ n: number }>(
      "select public.note_debt_balances_from_books($1, 'quickbooks', $2, $3::jsonb) as n",
      [tenant, asOf, JSON.stringify(rows)],
    );
    return out[0].n;
  });

const DEBT_SETTING = { version: 1, strategy: "snowball", emergency_target_cents: 1234500 };

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  dan = { id: await createUser(db, "dan@a.test"), email: "dan@a.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await db.query(
    `insert into public.memberships (tenant_id, user_id, role)
     values ($1, $2, 'admin'), ($1, $3, 'member')`,
    [tenantA, dan.id, carol.id],
  );

  cardA = await saveDebt(alice, tenantA, CARD);
  loanA = await saveDebt(dan, tenantA, {
    ...CARD,
    name: "Equipment loan",
    kind: "loan",
    plan: "fixed",
    rate_bp: 0,
    payment_cents: 20000,
    books_account: "Equipment Loan",
    priority: null,
  });
  await saveDebt(bob, tenantB, { ...CARD, name: "Kiln loan" });

  await as(alice, "select public.note_money_debt_balance($1, $2, '2026-10-31', 300000)", [
    tenantA,
    cardA,
  ]);
  await as(alice, "select public.set_money_debt_plan_months($1, $2::jsonb)", [
    tenantA,
    JSON.stringify([{ month: "2026-12-01", pool_cents: 0, emergency_cents: 5000 }]),
  ]);
  await as(
    alice,
    "select public.save_money_debt_scenario($1, 'What if I paid 100 more?', $2::jsonb, $3::jsonb)",
    [tenantA, JSON.stringify({ extra_monthly_cents: 10000 }), JSON.stringify({ months: 20 })],
  );
  await as(alice, "select public.save_config($1, 'dashboard', 'debt', $2::jsonb)", [
    tenantA,
    JSON.stringify(DEBT_SETTING),
  ]);
  await as(
    alice,
    "select public.propose_config_change($1, 'dashboard', 'debt', $2::jsonb, 'Use avalanche')",
    [tenantA, JSON.stringify({ ...DEBT_SETTING, strategy: "avalanche" })],
  );
  await as(alice, "select public.save_config($1, 'dashboard', 'health', $2::jsonb)", [
    tenantA,
    JSON.stringify({ version: 1 }),
  ]);

  await fileExpenses(tenantA, [
    move("cp1", "studio card", "2026-10-05", 15000),
    move("cp2", "Studio Card", "2026-10-20", 5000),
    move("t1", "Equipment Loan", "2026-11-02", 20000, "transfer"),
    move("t2", "Savings", "2026-11-03", 99999, "transfer"),
    {
      entity: "Purchase",
      external_id: "p1",
      kind: "purchase",
      payment_type: "Cash",
      date: "2026-10-07",
      amount_cents: 4200,
      account: "Supplies",
      payee: "Yarn shop",
      memo: "",
      from_account: null,
      lines: [],
    },
  ]);
});

const DEBT_TABLES = [
  "money_debts",
  "money_debt_balances",
  "money_debt_plan_months",
  "money_debt_scenarios",
];

describe("owners and admins", () => {
  it("keep their debts, balances, months set by hand and what-ifs", async () => {
    for (const user of [alice, dan]) {
      const debts = await as<{ name: string; books_account: string }>(
        user,
        "select name, books_account from public.money_debts where tenant_id = $1 order by name",
        [tenantA],
      );
      expect(debts).toEqual([
        { name: "Equipment loan", books_account: "Equipment Loan" },
        { name: "Studio card", books_account: "Studio Card" },
      ]);
      for (const table of DEBT_TABLES) {
        const [{ n }] = await as<{ n: number }>(
          user,
          `select count(*)::int as n from public.${table}`,
        );
        expect(n, table).toBeGreaterThan(0);
      }
    }
  });

  it("read each debt's latest balance, the latest day first, then the latest written", async () => {
    expect(await fromBooks(tenantA, "2026-11-20", [{ name: "STUDIO CARD", cents: -250000 }])).toBe(
      1,
    );
    await as(alice, "select public.note_money_debt_balance($1, $2, '2026-11-20', 240000)", [
      tenantA,
      cardA,
    ]);
    const current = await as<{ debt_id: string; balance_cents: string; source: string }>(
      alice,
      "select debt_id, balance_cents::text, source from public.money_debt_current($1)",
      [tenantA],
    );
    expect(current).toEqual([{ debt_id: cardA, balance_cents: "240000", source: "person" }]);
    // The books again the same day: now the latest written.
    await fromBooks(tenantA, "2026-11-20", [{ name: "Studio Card", cents: 245000 }]);
    const again = await as<{ balance_cents: string; source: string }>(
      alice,
      "select balance_cents::text, source from public.money_debt_current($1) where debt_id = $2",
      [tenantA, cardA],
    );
    expect(again).toEqual([{ balance_cents: "245000", source: "books" }]);
  });

  it("see what the books show paid into each debt's own account, by month", async () => {
    const paid = await as<{ debt_id: string; month: string; cents: string; payments: string }>(
      alice,
      `select debt_id, month::text, cents::text, payments::text
       from public.money_debt_payments($1, '2026-01-01', '2027-01-01') order by month, cents`,
      [tenantA],
    );
    expect(paid).toEqual([
      { debt_id: cardA, month: "2026-10-01", cents: "20000", payments: "2" },
      { debt_id: loanA, month: "2026-11-01", cents: "20000", payments: "1" },
    ]);
    const list = await as<{ debt_id: string; cents: string }>(
      dan,
      "select debt_id, cents::text from public.money_debt_payment_list($1, 10)",
      [tenantA],
    );
    expect(list.map((row) => row.cents)).toEqual(["20000", "5000", "15000"]);
    const accounts = await as<{ account: string }>(
      alice,
      "select account from public.money_move_accounts($1)",
      [tenantA],
    );
    expect(accounts.map((row) => row.account).sort()).toEqual([
      "Equipment Loan",
      "Savings",
      "Studio Card",
      "studio card",
    ]);
  });

  it("change and remove what they typed, and only what they typed", async () => {
    await saveDebt(alice, tenantA, { ...CARD, status: "paused", note: "  on hold  " }, cardA);
    const [row] = await as<{ status: string; note: string }>(
      alice,
      "select status, note from public.money_debts where id = $1",
      [cardA],
    );
    expect(row).toEqual({ status: "paused", note: "on hold" });
    const [books] = await as<{ id: string }>(
      alice,
      "select id from public.money_debt_balances where source = 'books' limit 1",
    );
    await expect(
      as(alice, "select public.remove_money_debt_balance($1, $2)", [tenantA, books.id]),
    ).rejects.toThrow(/can take back/);
    await saveDebt(alice, tenantA, CARD, cardA);
  });

  it("keep months set by hand, and put one back to worked out", async () => {
    await as(alice, "select public.set_money_debt_plan_months($1, $2::jsonb)", [
      tenantA,
      JSON.stringify([
        { month: "2027-01-01", pool_cents: 100, emergency_cents: null },
        { month: "2027-01-01", pool_cents: null, emergency_cents: null },
      ]),
    ]);
    const months = await as<{ month: string }>(
      alice,
      "select month::text from public.money_debt_plan_months",
    );
    expect(months).toEqual([{ month: "2026-12-01" }]);
    await expect(
      as(alice, "select public.set_money_debt_plan_months($1, $2::jsonb)", [
        tenantA,
        JSON.stringify([{ month: "2027-01-15", pool_cents: 1 }]),
      ]),
    ).rejects.toThrow(/whole month/);
  });

  it("read the plan's setting, its versions and proposals", async () => {
    for (const user of [alice, dan]) {
      for (const table of ["configs", "config_versions", "config_proposals"]) {
        const [{ n }] = await as<{ n: number }>(
          user,
          `select count(*)::int as n from public.${table} where module = 'dashboard' and key = 'debt'`,
        );
        expect(n, table).toBeGreaterThan(0);
      }
    }
  });
});

describe("a plain member", () => {
  it("reads nothing of the debts, from any table or function", async () => {
    for (const table of DEBT_TABLES) {
      const rows = await as(carol, `select * from public.${table}`);
      expect(rows, table).toEqual([]);
    }
    for (const sql of [
      "select * from public.money_debt_current($1)",
      "select * from public.money_debt_payments($1, '2000-01-01', '2100-01-01')",
      "select * from public.money_debt_payment_list($1, 100)",
      "select * from public.money_move_accounts($1)",
    ]) {
      expect(await as(carol, sql, [tenantA]), sql).toEqual([]);
    }
  });

  it("doesn't see payments into a card or loan in the books, but still sees the expenses", async () => {
    const rows = await as<{ external_id: string }>(
      carol,
      "select external_id from public.book_expenses where tenant_id = $1 order by external_id",
      [tenantA],
    );
    expect(rows).toEqual([{ external_id: "p1" }]);
    const [{ n }] = await as<{ n: number }>(
      alice,
      "select count(*)::int as n from public.book_expenses where tenant_id = $1",
      [tenantA],
    );
    expect(n).toBe(5);
  });

  it("doesn't see the plan's setting, its versions or proposals, but sees the others", async () => {
    for (const table of ["configs", "config_versions", "config_proposals"]) {
      const rows = await as(
        carol,
        `select * from public.${table} where module = 'dashboard' and key = 'debt'`,
      );
      expect(rows, table).toEqual([]);
    }
    const health = await as(
      carol,
      "select * from public.configs where module = 'dashboard' and key = 'health'",
    );
    expect(health).toHaveLength(1);
  });

  it("can't propose a change to the plan's setting, but can to others", async () => {
    await expect(
      as(carol, "select public.propose_config_change($1, 'dashboard', 'debt', '{}'::jsonb, 'x')", [
        tenantA,
      ]),
    ).rejects.toThrow(/Only owners and admins/);
    const [{ id }] = await as<{ id: string }>(
      carol,
      "select public.propose_config_change($1, 'dashboard', 'health', '{\"version\":1}'::jsonb, 'x') as id",
      [tenantA],
    );
    expect(id).toBeTruthy();
  });

  it("can't write any of it", async () => {
    const tries: [string, unknown[]][] = [
      ["select public.save_money_debt($1, null, $2::jsonb)", [tenantA, JSON.stringify(CARD)]],
      ["select public.save_money_debt($1, $2, $3::jsonb)", [tenantA, cardA, JSON.stringify(CARD)]],
      ["select public.remove_money_debt($1, $2)", [tenantA, cardA]],
      ["select public.note_money_debt_balance($1, $2, '2026-11-01', 1)", [tenantA, cardA]],
      ["select public.set_money_debt_plan_months($1, '[]'::jsonb)", [tenantA]],
      ["select public.save_money_debt_scenario($1, 'q', '{}'::jsonb, '{}'::jsonb)", [tenantA]],
      ["select public.save_config($1, 'dashboard', 'debt', '{}'::jsonb)", [tenantA]],
    ];
    for (const [sql, params] of tries) {
      await expect(as(carol, sql, params), sql).rejects.toThrow(/Only owners and admins/);
    }
    await expect(
      as(carol, "insert into public.money_debts (tenant_id, name) values ($1, 'x')", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(
        carol,
        "select public.note_debt_balances_from_books($1, 'quickbooks', '2026-11-01', '[]'::jsonb)",
        [tenantA],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("across workspaces", () => {
  it("an owner of another workspace reads and writes nothing of this one's", async () => {
    for (const table of DEBT_TABLES) {
      const rows = await as<{ tenant_id: string }>(bob, `select tenant_id from public.${table}`);
      expect(
        rows.every((row) => row.tenant_id === tenantB),
        table,
      ).toBe(true);
    }
    expect(await as(bob, "select * from public.money_debt_current($1)", [tenantA])).toEqual([]);
    expect(
      await as(bob, "select * from public.money_debt_payments($1, '2000-01-01', '2100-01-01')", [
        tenantA,
      ]),
    ).toEqual([]);
    await expect(
      as(bob, "select public.save_money_debt($1, $2, $3::jsonb)", [
        tenantA,
        cardA,
        JSON.stringify(CARD),
      ]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      as(bob, "select public.save_money_debt($1, $2, $3::jsonb)", [
        tenantB,
        cardA,
        JSON.stringify(CARD),
      ]),
    ).rejects.toThrow(/isn't here/);
    await expect(
      as(bob, "select public.note_money_debt_balance($1, $2, '2026-11-01', 1)", [tenantB, cardA]),
    ).rejects.toThrow(/isn't here/);
  });

  it("the books' balances land only on the named workspace's linked debts", async () => {
    expect(await fromBooks(tenantB, "2026-11-21", [{ name: "Equipment Loan", cents: 1 }])).toBe(0);
    expect(await fromBooks(tenantA, "2026-11-21", [{ name: "Nobody's account", cents: 1 }])).toBe(
      0,
    );
    const [{ n }] = await db
      .query<{ n: number }>(
        "select count(*)::int as n from public.money_debt_balances where as_of = '2026-11-21'",
      )
      .then((r) => r.rows);
    expect(n).toBe(0);
  });

  it("strangers read nothing", async () => {
    for (const table of DEBT_TABLES) {
      await expect(
        asAnon(db, (tx) => tx.query(`select * from public.${table}`)),
        table,
      ).rejects.toThrow(/permission denied/);
    }
  });
});
