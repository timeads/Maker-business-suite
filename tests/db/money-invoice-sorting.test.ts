import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  bookRevenue,
  invoiceSorting,
  isWaiting,
  placeInvoice,
  type InvoiceGroup,
} from "../../src/lib/dashboard/book-revenue";
import { revenueSettingsSchema, type RevenueSettings } from "../../src/lib/dashboard/lines";
import {
  applyMigrationsAfter,
  asAnon,
  asService,
  asUser,
  createTestDb,
  createTestDbUntil,
  createUser,
} from "./harness";

/**
 * Sorting invoices into lines one at a time (`sort_book_invoices`): owners
 * and admins only, several at once, checked against the workspace's lines;
 * the sync never overwrites a choice and a returning invoice keeps it; the
 * list's filters are the twin of `decideInvoice`; nobody reaches across
 * workspaces. Made-up customers, accounts and figures.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let dan: User; // admin of A
let carol: User; // member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;

const RUN_1 = "11111111-1111-4111-8111-111111111111";
const RUN_2 = "22222222-2222-4222-8222-222222222222";

const LINES = [
  { id: "shop", name: "Shop" },
  { id: "classes", name: "Classes" },
  { id: "custom", name: "Custom work" },
];
const SETTINGS: RevenueSettings = revenueSettingsSchema.parse({
  version: 1,
  lines: LINES,
  default_line: "shop",
  books: {
    invoices: true,
    accounts: [
      { ref: "79", name: "Class income", choice: { line: "classes" } },
      { ref: null, name: "Sales", choice: { skip: "shop" } },
    ],
    customers: [
      { ref: "7", name: "Maple Library", choice: { line: "custom" } },
      { ref: null, name: "Birch Hall", choice: { skip: "other" } },
    ],
  },
});

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

type Line = [string | null, string | null, number];
const invoice = (id: string, lines: Line[], extra: Record<string, unknown> = {}) => ({
  external_id: id,
  doc_number: `20${id}`,
  customer: "Elm Goods",
  customer_ref: "3",
  date: "2026-10-05",
  due_date: null,
  total_cents: lines.reduce((a, [, , c]) => a + c, 0),
  balance_cents: 0,
  net_cents: lines.reduce((a, [, , c]) => a + c, 0),
  memo: "",
  lines: lines.map(([account_ref, account, cents]) => ({ account_ref, account, cents })),
  ...extra,
});

const file = (tenant: string, run: string, rows: unknown[]) =>
  asService(db, (tx) =>
    tx.query("select public.file_book_invoices($1, 'quickbooks', $2, $3::jsonb)", [
      tenant,
      run,
      JSON.stringify(rows),
    ]),
  );

const idOf = async (tenant: string, external: string) =>
  (
    await db.query<{ id: string }>(
      "select id from public.book_invoices where tenant_id = $1 and external_id = $2",
      [tenant, external],
    )
  ).rows[0].id;

const sortAs = (user: User, ids: string[], sort: string, line?: string | null, split?: unknown) =>
  as<{ n: number }>(
    user,
    "select public.sort_book_invoices($1, $2::uuid[], $3, $4, $5::jsonb) as n",
    [tenantA, ids, sort, line ?? null, split === undefined ? null : JSON.stringify(split)],
  ).then((rows) => rows[0].n);

const stored = async (external: string) =>
  (
    await db.query<{ sort: string | null; line_id: string | null; split: unknown }>(
      "select sort, line_id, split from public.book_invoices where tenant_id = $1 and external_id = $2",
      [tenantA, external],
    )
  ).rows[0];

// Every way an invoice can be placed, by external id.
const MIXED: ReturnType<typeof invoice>[] = [
  invoice("1", [["79", "Class income", 6000]]),
  invoice("2", [[null, "Sales", 4000]]),
  invoice("3", [["81", "Rentals", 2500]]),
  invoice("4", [
    ["79", "Class income", 1000],
    ["81", "Rentals", 500],
  ]),
  invoice("5", [["81", "Rentals", 700]]), // sorted by hand to shop
  invoice("6", [
    ["79", "Class income", 1001],
    ["81", "Rentals", 2000],
  ]), // split by hand
  invoice("7", [["79", "Class income", 300]]), // "the shop counted this"
  invoice("8", [["81", "Rentals", 900]]), // left out by hand
  invoice("9", [["81", "Rentals", 1200]], { customer_ref: "7", customer: "Maple Library" }),
  invoice("10", [["79", "Class income", 800]], { customer_ref: null, customer: "Birch Hall" }),
  invoice("11", [["81", "Rentals", 50]], { balance_cents: 50 }), // unpaid, by hand to custom
  invoice("12", [["81", "Rentals", 400]], { customer_ref: "7", customer: "Maple Library" }), // customer, then by hand
];

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  dan = { id: await createUser(db, "dan@a.test"), email: "dan@a.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  for (const [user, role] of [
    [dan, "admin"],
    [carol, "member"],
  ] as const) {
    await db.query(
      "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, $3::public.membership_role)",
      [tenantA, user.id, role],
    );
  }
  await as(alice, "select public.save_config($1, 'dashboard', 'revenue', $2::jsonb)", [
    tenantA,
    JSON.stringify(SETTINGS),
  ]);
  await file(tenantA, RUN_1, MIXED);
  await file(tenantB, RUN_1, [invoice("1", [["79", "Class income", 100]], { customer: "Oak Co" })]);
});

describe("a person's choice", () => {
  it("is for owners and admins, several invoices at once", async () => {
    const [five, eleven] = [await idOf(tenantA, "5"), await idOf(tenantA, "11")];
    expect(await sortAs(alice, [five], "line", "shop")).toBe(1);
    expect(await sortAs(dan, [eleven], "line", "custom")).toBe(1);
    expect(
      await sortAs(alice, [await idOf(tenantA, "6")], "split", null, { shop: 33, classes: 67 }),
    ).toBe(1);
    expect(await sortAs(alice, [await idOf(tenantA, "7"), await idOf(tenantA, "12")], "shop")).toBe(
      2,
    );
    expect(await sortAs(dan, [await idOf(tenantA, "8")], "left_out")).toBe(1);
    expect(await stored("12")).toEqual({ sort: "shop", line_id: null, split: null });
    // Then 12 goes to classes by hand, and both at once can go back.
    expect(await sortAs(alice, [await idOf(tenantA, "12")], "line", "classes")).toBe(1);
    expect(await stored("6")).toEqual({
      sort: "split",
      line_id: null,
      split: { shop: 33, classes: 67 },
    });
    const who = await db.query<{ sorted_member: string; sorted_at: string | null }>(
      "select sorted_member, sorted_at from public.book_invoices where id = $1",
      [eleven],
    );
    expect(who.rows[0].sorted_member).toBe(dan.id);
    expect(who.rows[0].sorted_at).not.toBeNull();
  });

  it("is refused to a member, to another workspace and to anyone signed out", async () => {
    const one = await idOf(tenantA, "1");
    await expect(sortAs(carol, [one], "line", "shop")).rejects.toMatchObject({ code: "42501" });
    await expect(
      as(bob, "select public.sort_book_invoices($1, $2::uuid[], 'shop')", [tenantA, [one]]),
    ).rejects.toMatchObject({ code: "42501" });
    // An owner naming another workspace's invoice changes nothing there.
    expect(
      (
        await as<{ n: number }>(
          bob,
          "select public.sort_book_invoices($1, $2::uuid[], 'shop') as n",
          [tenantB, [one]],
        )
      )[0].n,
    ).toBe(0);
    await expect(
      asAnon(db, (tx) =>
        tx.query("select public.sort_book_invoices($1, $2::uuid[], 'shop')", [tenantA, [one]]),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      as(alice, "update public.book_invoices set sort = 'shop' where id = $1", [one]),
    ).rejects.toThrow(/permission denied/i);
    expect(await stored("1")).toEqual({ sort: null, line_id: null, split: null });
  });

  it("only takes a line, a split or a way of leaving out that fits the workspace's lines", async () => {
    const one = await idOf(tenantA, "1");
    for (const [sort, line, split] of [
      ["line", "wholesale", undefined],
      ["line", null, undefined],
      ["split", null, { shop: 50, classes: 49 }],
      ["split", null, { shop: 100 }],
      ["split", null, { shop: 50, wholesale: 50 }],
      ["split", null, { shop: 50.5, classes: 49.5 }],
      ["split", "shop", { shop: 50, classes: 50 }],
      ["shop", "shop", undefined],
      ["left_out", null, { shop: 50, classes: 50 }],
      ["shared", null, undefined],
      [null, null, undefined],
    ] as [string, string | null, unknown][]) {
      await expect(
        sortAs(alice, [one], sort, line, split),
        JSON.stringify([sort, line, split]),
      ).rejects.toMatchObject({
        code: "22023",
      });
    }
    await expect(sortAs(alice, [], "shop")).rejects.toMatchObject({ code: "22023" });
    expect(await stored("1")).toEqual({ sort: null, line_id: null, split: null });
  });
});

describe("the books' facts and the person's sorting stay apart", () => {
  it("a sync never overwrites a choice, and keeps the customer's id it isn't sent", async () => {
    // An earlier worker's rows carry no customer id.
    const again = MIXED.map(({ customer_ref: _ref, ...row }) => ({ ...row, memo: "read again" }));
    await file(tenantA, RUN_2, again);
    expect(await stored("5")).toEqual({ sort: "line", line_id: "shop", split: null });
    expect(await stored("6")).toMatchObject({ sort: "split" });
    const { rows } = await db.query<{ customer_ref: string; memo: string }>(
      "select customer_ref, memo from public.book_invoices where tenant_id = $1 and external_id = '9'",
      [tenantA],
    );
    expect(rows[0]).toEqual({ customer_ref: "7", memo: "read again" });
  });

  it("an invoice gone from the books keeps its choice when it comes back", async () => {
    await asService(db, (tx) =>
      tx.query("select public.close_book_invoices($1, 'quickbooks', $2, '2026-10-01')", [
        tenantA,
        RUN_1,
      ]),
    );
    const gone = await db.query<{ n: string }>(
      "select count(*)::text as n from public.book_invoices where tenant_id = $1 and removed_at is null",
      [tenantA],
    );
    expect(gone.rows[0].n).toBe("0");
    // While gone, it can't be sorted.
    expect(await sortAs(alice, [await idOf(tenantA, "5")], "line", "classes")).toBe(0);
    await file(tenantA, RUN_1, MIXED);
    expect(await stored("5")).toEqual({ sort: "line", line_id: "shop", split: null });
    expect(await stored("8")).toEqual({ sort: "left_out", line_id: null, split: null });
  });

  it("goes back to its customer or account with none", async () => {
    const ten = await idOf(tenantA, "10");
    await sortAs(alice, [ten], "line", "classes");
    expect(await sortAs(alice, [ten, await idOf(tenantA, "1")], "none")).toBe(1);
    expect(await stored("10")).toEqual({ sort: null, line_id: null, split: null });
  });
});

type ListRow = {
  doc_number: string;
  customer_ref: string | null;
  customer: string | null;
  lines: { account_ref: string | null; account: string | null; cents: number }[];
  sort: string | null;
  line_id: string | null;
  split: Record<string, number> | null;
  balance_cents: string;
};

const list = (user: User, tenant: string, sorting: unknown, line: string | null, waiting = false) =>
  as<ListRow>(
    user,
    `select doc_number, customer_ref, customer, lines, sort, line_id, split, balance_cents::text
       from public.money_invoice_sorted_list($1, '2026-11-20', 'all', null, $2::jsonb, $3, $4, 500, 0)`,
    [tenant, JSON.stringify(sorting), line, waiting],
  );

describe("the list's filters are the twin of the one rule", () => {
  // The same setting, and one where "custom" has since been taken away.
  const withoutCustom = {
    ...SETTINGS,
    lines: SETTINGS.lines.filter((l) => l.id !== "custom"),
  } as RevenueSettings;

  for (const [name, settings] of [
    ["every line", SETTINGS],
    ["a line taken away", withoutCustom],
  ] as const) {
    it(`agrees invoice by invoice, with ${name}`, async () => {
      const sorting = invoiceSorting(settings);
      const all = await list(alice, tenantA, sorting, null);
      expect(all.length).toBe(MIXED.length);
      const places = new Map(all.map((row) => [row.doc_number, placeInvoice(settings, row)]));
      for (const line of LINES.map((l) => l.id)) {
        const inLine = (await list(alice, tenantA, sorting, line)).map((r) => r.doc_number).sort();
        const expected = [...places]
          .filter(([, place]) => place.byLine.has(line))
          .map(([doc]) => doc)
          .sort();
        expect(inLine, line).toEqual(expected);
      }
      const waiting = (await list(alice, tenantA, sorting, null, true))
        .map((r) => r.doc_number)
        .sort();
      expect(waiting).toEqual(
        [...places]
          .filter(([, place]) => isWaiting(place))
          .map(([doc]) => doc)
          .sort(),
      );
      const counts = await as<{ waiting: string; waiting_cents: string; by_hand: string }>(
        alice,
        "select waiting::text, waiting_cents::text, by_hand::text from public.money_invoice_sorting_counts($1, $2::jsonb)",
        [tenantA, JSON.stringify(sorting)],
      );
      expect(Number(counts[0].waiting)).toBe(waiting.length);
      expect(Number(counts[0].by_hand)).toBe(6);
    });
  }

  it("leaves what it should: the shop's own sales and the customer's left out wait for nothing", async () => {
    const waiting = (await list(alice, tenantA, invoiceSorting(SETTINGS), null, true)).map(
      (r) => r.doc_number,
    );
    expect(waiting.sort()).toEqual(["203", "204"]);
  });

  it("adds paid invoices up by the same rule, a split once on its whole total", async () => {
    const rows = await as<Record<string, unknown>>(
      alice,
      "select * from public.money_invoice_sorted_revenue($1, '2026-10-01', '2026-11-01', 'month')",
      [tenantA],
    );
    const groups: InvoiceGroup[] = rows.map((r) => ({
      period: String(r.period),
      account_ref: (r.account_ref as string | null) ?? null,
      account: (r.account as string | null) ?? null,
      cents: Number(r.cents),
      customer_ref: (r.customer_ref as string | null) ?? null,
      customer: (r.customer as string | null) ?? null,
      sort: (r.sort as string | null) ?? null,
      line_id: (r.line_id as string | null) ?? null,
      split: r.split,
      invoice_id: (r.invoice_id as string | null) ?? null,
    }));
    // The split invoice comes back on its own, one row per account.
    expect(
      groups
        .filter((g) => g.sort === "split")
        .map((g) => g.cents)
        .sort(),
    ).toEqual([1001, 2000]);
    const fromGroups = bookRevenue(SETTINGS, groups, []);
    const paid = (await list(alice, tenantA, invoiceSorting(SETTINGS), null)).filter(
      (r) => Number(r.balance_cents) <= 0,
    );
    const byLine = new Map<string, number>();
    for (const row of paid) {
      for (const [line, cents] of placeInvoice(SETTINGS, row).byLine) {
        byLine.set(line, (byLine.get(line) ?? 0) + cents);
      }
    }
    expect(Object.fromEntries(fromGroups.invoicesByLine)).toEqual(Object.fromEntries(byLine));
    // 1: 6000 classes; 4: 1000 classes; 5: 700 shop; 6: 3001 split 33/67;
    // 9: 1200 custom (its customer); 12: 400 classes by hand.
    expect(Object.fromEntries(fromGroups.invoicesByLine)).toEqual({
      classes: 6000 + 1000 + 2011 + 400,
      shop: 700 + 990,
      custom: 1200,
    });
    expect(fromGroups.leftOut).toBe(4000 + 300 + 900 + 800);
    expect(fromGroups.waiting).toBe(2500 + 500);
  });
});

describe("other workspaces", () => {
  it("see none of it, and reach none of it", async () => {
    const sorting = invoiceSorting(SETTINGS);
    expect(await list(bob, tenantA, sorting, null)).toEqual([]);
    expect(await list(alice, tenantB, sorting, null)).toEqual([]);
    expect(
      await as(
        alice,
        "select * from public.money_invoice_sorted_revenue($1, '2026-01-01', '2027-01-01')",
        [tenantB],
      ),
    ).toEqual([]);
    const counts = await as<{ waiting: string }>(
      bob,
      "select waiting::text from public.money_invoice_sorting_counts($1, $2::jsonb)",
      [tenantA, JSON.stringify(sorting)],
    );
    expect(counts).toEqual([]);
    const seen = await as<{ sort: string | null }>(bob, "select sort from public.book_invoices");
    expect(seen).toEqual([{ sort: null }]);
  });

  it("a plain member reads the choices, as they read the invoices", async () => {
    const rows = await list(carol, tenantA, invoiceSorting(SETTINGS), "custom");
    expect(rows.map((r) => r.doc_number).sort()).toEqual(["2011", "209"]);
  });
});

describe("during the deploy", () => {
  const BEFORE = "20270213000200_money_summaries.sql";

  it("keeps an earlier build's questions answering as before over a database with this", async () => {
    const old = await createTestDbUntil(BEFORE);
    const owner = { id: await createUser(old, "olive@a.test"), email: "olive@a.test" };
    const tenant = await asUser(old, owner, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "select id from public.create_tenant('Olive Rugs', 'America/New_York', 'USD')",
      );
      return rows[0].id;
    });
    await asService(old, (tx) =>
      tx.query("select public.file_book_invoices($1, 'quickbooks', $2, $3::jsonb)", [
        tenant,
        RUN_1,
        JSON.stringify([invoice("1", [["79", "Class income", 6000]])]),
      ]),
    );
    await applyMigrationsAfter(old, BEFORE);
    const asOwner = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      asUser(old, owner, async (tx) => (await tx.query<T>(sql, params)).rows);
    // The earlier build's list and revenue, unchanged.
    expect(
      await asOwner<{ doc_number: string }>(
        "select doc_number from public.money_invoice_list($1, '2026-11-20', 'all', null, null, null, 50, 0)",
        [tenant],
      ),
    ).toEqual([{ doc_number: "201" }]);
    expect(
      await asOwner<{ cents: string }>(
        "select cents::text from public.money_invoice_revenue($1, '2026-10-01', '2026-11-01', 'month')",
        [tenant],
      ),
    ).toEqual([{ cents: "6000" }]);
    // An invoice filed before this has no choice and no customer id yet; the
    // earlier worker's rows (no customer id) still file.
    const { rows } = await old.query<{ sort: string | null; customer_ref: string | null }>(
      "select sort, customer_ref from public.book_invoices",
    );
    expect(rows).toEqual([{ sort: null, customer_ref: null }]);
    await asService(old, (tx) =>
      tx.query("select public.file_book_invoices($1, 'quickbooks', $2, $3::jsonb)", [
        tenant,
        RUN_2,
        JSON.stringify([
          (({ customer_ref: _ref, ...row }) => row)(invoice("2", [["79", "Class income", 10]])),
        ]),
      ]),
    );
    expect(
      (await old.query<{ n: string }>("select count(*)::text as n from public.book_invoices"))
        .rows[0].n,
    ).toBe("2");
  });
});
