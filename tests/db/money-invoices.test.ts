import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Money's invoices: filed from the books by the sync, read by the whole team
 * of their own workspace and nobody else, each paid, open or overdue worked
 * out on read, and paid ones added up by income account for revenue by line.
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

const invoice = (id: string, extra: Record<string, unknown> = {}) => ({
  external_id: id,
  doc_number: `10${id}`,
  customer: "Maple Studio",
  date: "2026-10-05",
  due_date: "2026-11-04",
  total_cents: 11000,
  balance_cents: 0,
  net_cents: 10000,
  memo: "Thanks",
  lines: [
    { account_ref: "79", account: "Class income", item: "Group class", cents: 6000 },
    { account_ref: "80", account: "Commissions", item: "Wall piece", cents: 4000 },
  ],
  ...extra,
});

const file = (tenant: string, run: string, rows: unknown[]) =>
  asService(db, async (tx) => {
    const { rows: out } = await tx.query<{ result: Record<string, number> }>(
      "select public.file_book_invoices($1, 'quickbooks', $2, $3::jsonb) as result",
      [tenant, run, JSON.stringify(rows)],
    );
    return out[0].result;
  });

const list = (user: User, tenant: string, status = "all", extra: unknown[] = [null, null, null]) =>
  as<{ doc_number: string; status: string; total_count: string }>(
    user,
    "select doc_number, status, total_count::text from public.money_invoice_list($1, '2026-11-20', $2, $3, $4, $5)",
    [tenant, status, ...extra],
  );

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
  await file(tenantA, RUN_1, [
    invoice("1"),
    invoice("2", { balance_cents: 11000, due_date: "2026-11-01" }),
    invoice("3", { balance_cents: 5000, due_date: "2026-12-01", customer: "Birch & Co" }),
  ]);
  await file(tenantB, RUN_1, [invoice("9", { customer: "Elm Goods" })]);
});

describe("filing invoices", () => {
  it("keeps each invoice once, by the books' id, and follows a change", async () => {
    const again = await file(tenantA, RUN_2, [
      invoice("1"),
      invoice("2", { balance_cents: 0, due_date: "2026-11-01" }),
      invoice("3", { balance_cents: 5000, due_date: "2026-12-01", customer: "Birch & Co" }),
    ]);
    expect(again).toEqual({ read: 3, bad: 0 });
    const { rows } = await db.query<{ n: string }>(
      "select count(*)::text as n from public.book_invoices where tenant_id = $1",
      [tenantA],
    );
    expect(rows[0].n).toBe("3");
    expect((await list(alice, tenantA, "paid")).map((r) => r.doc_number)).toEqual(["102", "101"]);
  });

  it("skips what isn't clear, and only the sync can file", async () => {
    expect(await file(tenantA, RUN_2, [{ external_id: "", date: "2026-10-01" }])).toEqual({
      read: 1,
      bad: 1,
    });
    await expect(
      as(alice, "select public.file_book_invoices($1, 'quickbooks', $2, '[]'::jsonb)", [
        tenantA,
        RUN_2,
      ]),
    ).rejects.toThrow(/permission denied/i);
  });

  it("marks what a complete read no longer saw as gone, and brings it back when seen", async () => {
    await file(tenantA, RUN_1, [invoice("4", { date: "2026-09-01" })]);
    await asService(db, (tx) =>
      tx.query("select public.close_book_invoices($1, 'quickbooks', $2, '2026-01-01')", [
        tenantA,
        RUN_2,
      ]),
    );
    expect((await list(alice, tenantA)).map((r) => r.doc_number)).not.toContain("104");
    await file(tenantA, RUN_2, [invoice("4", { date: "2026-09-01" })]);
    expect((await list(alice, tenantA)).map((r) => r.doc_number)).toContain("104");
  });
});

describe("reading invoices", () => {
  it("works out paid, open and overdue against the day given", async () => {
    const rows = await list(carol, tenantA);
    const status = Object.fromEntries(rows.map((r) => [r.doc_number, r.status]));
    expect(status["101"]).toBe("paid");
    expect(status["103"]).toBe("open");
    await file(tenantA, RUN_2, [invoice("5", { balance_cents: 100, due_date: "2026-11-19" })]);
    expect((await list(carol, tenantA, "overdue")).map((r) => r.doc_number)).toEqual(["105"]);
    const counts = await as<{ status: string; invoices: string }>(
      carol,
      "select status, invoices::text from public.money_invoice_counts($1, '2026-11-20')",
      [tenantA],
    );
    expect(counts.find((c) => c.status === "overdue")?.invoices).toBe("1");
  });

  it("searches the number, customer and lines, and filters to a line's accounts", async () => {
    const found = await list(alice, tenantA, "all", ["%birch%", null, null]);
    expect(found.map((r) => r.doc_number)).toEqual(["103"]);
    expect(found[0].total_count).toBe("1");
    const byRef = await list(alice, tenantA, "all", [null, ["80"], []]);
    expect(byRef.length).toBeGreaterThan(0);
    expect(await list(alice, tenantA, "all", [null, ["nope"], ["Nobody's account"]])).toEqual([]);
  });

  it("adds paid invoices up by income account, before tax", async () => {
    const rows = await as<{ account: string; cents: string }>(
      alice,
      "select account, cents::text from public.money_invoice_revenue($1, '2026-10-01', '2026-11-01', 'month')",
      [tenantA],
    );
    // Invoices 101 and 102 are paid and dated in October.
    expect(Object.fromEntries(rows.map((r) => [r.account, r.cents]))).toEqual({
      "Class income": "12000",
      Commissions: "8000",
    });
    const accounts = await as<{ account: string }>(
      alice,
      "select account from public.money_invoice_accounts($1, '2026-01-01')",
      [tenantA],
    );
    expect(accounts.map((a) => a.account)).toEqual(["Class income", "Commissions"]);
  });

  it("never crosses workspaces", async () => {
    expect((await list(bob, tenantA)).length).toBe(0);
    expect((await list(alice, tenantB)).length).toBe(0);
    const seen = await as<{ tenant_id: string; customer: string }>(
      bob,
      "select tenant_id, customer from public.book_invoices",
    );
    expect(seen.map((r) => r.customer)).toEqual(["Elm Goods"]);
    expect(
      await as(
        alice,
        "select * from public.money_invoice_revenue($1, '2026-01-01', '2027-01-01', 'month')",
        [tenantB],
      ),
    ).toEqual([]);
  });

  it("can't be written by anyone signed in, and is closed to anyone signed out", async () => {
    await expect(
      as(alice, "update public.book_invoices set balance_cents = 0 where tenant_id = $1", [
        tenantA,
      ]),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asAnon(db, (tx) => tx.query("select * from public.book_invoices")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("goes when the books are disconnected", async () => {
    await asService(db, (tx) =>
      tx.query("select public.purge_provider_data($1, 'quickbooks')", [tenantB]),
    );
    expect(await as(bob, "select id from public.book_invoices")).toEqual([]);
  });
});
