import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Money's budgets and the cost cutter's decisions: typed in by owners and
 * admins through checked functions, read by the whole team, never across
 * workspaces; actuals per account added up from the books' expenses.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let carol: User; // plain member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;

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

const setBudgets = (user: User, tenant: string, month: string, rows: unknown[]) =>
  as<{ n: number }>(user, "select public.set_money_budgets($1, $2, $3::jsonb) as n", [
    tenant,
    month,
    JSON.stringify(rows),
  ]);

const budgets = async (tenant: string) =>
  (
    await db.query<{ subject: string; subject_key: string; month: string; amount_cents: string }>(
      `select subject, subject_key, month::text, amount_cents::text from public.money_budgets
       where tenant_id = $1 order by month, subject, subject_key`,
      [tenant],
    )
  ).rows;

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
  await as(alice, "select public.save_config($1, 'dashboard', 'revenue', $2::jsonb)", [
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

describe("budgets", () => {
  it("are set per account or line per month by owners and admins", async () => {
    const [{ n }] = await setBudgets(alice, tenantA, "2026-10-01", [
      { subject: "account", key: "  Advertising ", amount_cents: 30000 },
      { subject: "line", key: "classes", amount_cents: 50000 },
    ]);
    expect(n).toBe(2);
    await setBudgets(alice, tenantA, "2026-10-01", [
      { subject: "account", key: "Advertising", amount_cents: 32000 },
    ]);
    expect(await budgets(tenantA)).toEqual([
      {
        subject: "account",
        subject_key: "Advertising",
        month: "2026-10-01",
        amount_cents: "32000",
      },
      { subject: "line", subject_key: "classes", month: "2026-10-01", amount_cents: "50000" },
    ]);
  });

  it("refuse a line that isn't set up, a part of a month, cents below zero or a fraction", async () => {
    await expect(
      setBudgets(alice, tenantA, "2026-10-01", [{ subject: "line", key: "nope", amount_cents: 1 }]),
    ).rejects.toThrow(/accounts or lines/);
    await expect(
      setBudgets(alice, tenantA, "2026-10-02", [{ subject: "account", key: "A", amount_cents: 1 }]),
    ).rejects.toThrow(/whole month/);
    await expect(
      setBudgets(alice, tenantA, "2026-10-01", [
        { subject: "account", key: "A", amount_cents: -1 },
      ]),
    ).rejects.toThrow(/whole number/);
    await expect(
      setBudgets(alice, tenantA, "2026-10-01", [
        { subject: "account", key: "A", amount_cents: 1.5 },
      ]),
    ).rejects.toThrow(/whole number/);
  });

  it("clear when the amount is null", async () => {
    await setBudgets(alice, tenantA, "2026-09-01", [
      { subject: "account", key: "Software", amount_cents: 100 },
    ]);
    await setBudgets(alice, tenantA, "2026-09-01", [
      { subject: "account", key: "Software", amount_cents: null },
    ]);
    expect((await budgets(tenantA)).some((b) => b.subject_key === "Software")).toBe(false);
  });

  it("copy last month's onto this one, replacing the same accounts", async () => {
    await setBudgets(alice, tenantA, "2026-11-01", [
      { subject: "account", key: "Advertising", amount_cents: 1 },
      { subject: "account", key: "Rent", amount_cents: 99 },
    ]);
    const [{ n }] = await as<{ n: number }>(
      alice,
      "select public.copy_money_budget_month($1, '2026-11-01') as n",
      [tenantA],
    );
    expect(n).toBe(2);
    const november = (await budgets(tenantA)).filter((b) => b.month === "2026-11-01");
    expect(november).toEqual([
      {
        subject: "account",
        subject_key: "Advertising",
        month: "2026-11-01",
        amount_cents: "32000",
      },
      { subject: "account", subject_key: "Rent", month: "2026-11-01", amount_cents: "99" },
      { subject: "line", subject_key: "classes", month: "2026-11-01", amount_cents: "50000" },
    ]);
  });

  it("fill the rest of the year without overwriting a month already set", async () => {
    await setBudgets(alice, tenantA, "2026-12-01", [
      { subject: "account", key: "Rent", amount_cents: 12345 },
    ]);
    const [{ n }] = await as<{ n: number }>(
      alice,
      "select public.fill_money_budget_year($1, '2026-10-01') as n",
      [tenantA],
    );
    // November had both already; December gets Advertising and classes, keeps its Rent.
    expect(n).toBe(2);
    const december = (await budgets(tenantA)).filter((b) => b.month === "2026-12-01");
    expect(december.map((b) => [b.subject_key, b.amount_cents])).toEqual([
      ["Advertising", "32000"],
      ["Rent", "12345"],
      ["classes", "50000"],
    ]);
    // Nothing spills into the next year.
    expect((await budgets(tenantA)).some((b) => b.month.startsWith("2027"))).toBe(false);
  });

  it("can't be changed by a plain member, another workspace or anyone signed out", async () => {
    await expect(
      setBudgets(carol, tenantA, "2026-10-01", [
        { subject: "account", key: "Advertising", amount_cents: 1 },
      ]),
    ).rejects.toThrow(/owners and admins/);
    await expect(
      setBudgets(bob, tenantA, "2026-10-01", [
        { subject: "account", key: "Advertising", amount_cents: 1 },
      ]),
    ).rejects.toThrow();
    await expect(
      as(bob, "select public.copy_money_budget_month($1, '2026-11-01')", [tenantA]),
    ).rejects.toThrow();
    await expect(
      asAnon(db, (tx) =>
        tx.query("select public.set_money_budgets($1, '2026-10-01', '[]'::jsonb)", [tenantA]),
      ),
    ).rejects.toThrow();
    await expect(
      as(
        alice,
        "insert into public.money_budgets (tenant_id, subject, subject_key, month, amount_cents) values ($1, 'account', 'X', '2026-10-01', 1)",
        [tenantA],
      ),
    ).rejects.toThrow();
  });

  it("are read by the whole team of their own workspace only", async () => {
    await setBudgets(bob, tenantB, "2026-10-01", [
      { subject: "account", key: "Clay", amount_cents: 777 },
    ]);
    const carols = await as<{ tenant_id: string }>(
      carol,
      "select tenant_id from public.money_budgets",
    );
    expect(carols.length).toBeGreaterThan(0);
    expect(carols.every((row) => row.tenant_id === tenantA)).toBe(true);
    const bobs = await as<{ tenant_id: string }>(bob, "select tenant_id from public.money_budgets");
    expect(bobs.every((row) => row.tenant_id === tenantB)).toBe(true);
  });
});

describe("what the books spent per account", () => {
  it("adds up each month's expenses per account, leaving out moves and set-aside spending", async () => {
    const expense = (id: string, extra: Record<string, unknown>) => ({
      entity: "Purchase",
      external_id: id,
      kind: "purchase",
      payment_type: "CreditCard",
      date: "2026-10-05",
      amount_cents: 1000,
      account: "Advertising",
      payee: "Ad Place",
      memo: "",
      from_account: null,
      lines: [],
      ...extra,
    });
    await asService(db, (tx) =>
      tx.query("select public.file_book_expenses($1, 'quickbooks', $2, $3::jsonb)", [
        tenantA,
        "11111111-1111-4111-8111-111111111111",
        JSON.stringify([
          expense("1", {}),
          expense("2", { amount_cents: 2500 }),
          expense("3", { date: "2026-11-01", amount_cents: 700 }),
          expense("4", { account: "Owner", amount_cents: 99999 }),
          expense("5", { entity: "Transfer", kind: "transfer", account: "Card", amount_cents: 5 }),
          expense("6", { date: "2026-12-01", amount_cents: 1 }),
        ]),
      ]),
    );
    const [owner] = await db
      .query<{ id: string }>(
        "select id from public.book_expenses where tenant_id = $1 and external_id = '4'",
        [tenantA],
      )
      .then((r) => r.rows);
    await as(alice, "select public.sort_book_expenses($1, $2::uuid[], 'set_aside')", [
      tenantA,
      [owner.id],
    ]);
    const totals = await as<{ month: string; account: string; cents: string }>(
      carol,
      "select month::text, account, cents::text from public.money_account_totals($1, '2026-10-01', '2026-12-01')",
      [tenantA],
    );
    expect(totals).toEqual([
      { month: "2026-10-01", account: "Advertising", cents: "3500" },
      { month: "2026-11-01", account: "Advertising", cents: "700" },
    ]);
    // Another workspace's member sees nothing of it.
    expect(
      await as(bob, "select * from public.money_account_totals($1, '2026-01-01', '2027-01-01')", [
        tenantA,
      ]),
    ).toEqual([]);
  });
});

describe("decisions on recurring charges", () => {
  const decide = (
    user: User,
    tenant: string,
    key: string,
    decision: string | null,
    note?: string,
  ) =>
    as(user, "select public.decide_money_charge($1, $2, $3, $4, 'Cloud Tools', 2999)", [
      tenant,
      key,
      decision,
      note ?? null,
    ]);

  it("are kept once per charge, changed in place and cleared", async () => {
    await decide(alice, tenantA, "cloud tools", "review", "Ask if we still use it");
    await decide(alice, tenantA, "cloud tools", "cancelled", "  Called them  ");
    const rows = await as<{ decision: string; note: string; payee: string; monthly_cents: string }>(
      carol,
      "select decision, note, payee, monthly_cents::text from public.money_charge_decisions",
    );
    expect(rows).toEqual([
      { decision: "cancelled", note: "Called them", payee: "Cloud Tools", monthly_cents: "2999" },
    ]);
    await decide(alice, tenantA, "cloud tools", null);
    expect(await as(carol, "select 1 from public.money_charge_decisions")).toEqual([]);
  });

  it("refuse anything but the four decisions, and anyone but owners and admins", async () => {
    await expect(decide(alice, tenantA, "x", "delete")).rejects.toThrow(/decision/);
    await expect(decide(carol, tenantA, "x", "keep")).rejects.toThrow(/owners and admins/);
    await expect(decide(bob, tenantA, "x", "keep")).rejects.toThrow();
  });

  it("stay in their own workspace", async () => {
    await decide(alice, tenantA, "cloud tools", "keep");
    await decide(bob, tenantB, "cloud tools", "cancel");
    const alices = await as<{ tenant_id: string; decision: string }>(
      alice,
      "select tenant_id, decision from public.money_charge_decisions",
    );
    expect(alices).toEqual([{ tenant_id: tenantA, decision: "keep" }]);
    const bobs = await as<{ tenant_id: string }>(
      bob,
      "select tenant_id from public.money_charge_decisions",
    );
    expect(bobs).toEqual([{ tenant_id: tenantB }]);
  });
});
