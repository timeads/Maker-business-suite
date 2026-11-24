import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { seasonsSchema } from "@/lib/stock/config";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Stock, the fourth batch of gaps closed after the side-by-side with
 * TuftStock: selling seasons, and what follows in the sections below.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let bob: User; // owner of B
let carol: User; // plain member of A
let tenantA: string;
let tenantB: string;
let rug: string;
let yarn: string;
let bobRug: string;
let supplierA: string;
let supplierB: string;

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'America/New_York', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0];

const items = (prefix: string) => [
  {
    external_id: `${prefix}-v1`,
    product_external_id: `${prefix}-p1`,
    inventory_item_id: `${prefix}-i1`,
    title: "Wool rug",
    variant_title: "Large",
    sku: `${prefix}-RUG-L`,
    on_hand: 4,
    unit_cost: 60,
    tracked: true,
    product_status: "ACTIVE",
  },
  {
    external_id: `${prefix}-v2`,
    product_external_id: `${prefix}-p2`,
    inventory_item_id: `${prefix}-i2`,
    title: "Yarn bundle",
    variant_title: null,
    sku: null,
    on_hand: 30,
    unit_cost: 8.5,
    tracked: true,
    product_status: "ACTIVE",
  },
];
const itemId = async (tenant: string, external: string) =>
  (
    await one<{ id: string }>(
      "select id from public.stock_items where tenant_id = $1 and external_id = $2",
      [tenant, external],
    )
  ).id;
const newSupplier = (user: User, tenant: string, name: string) =>
  as<{ id: string }>(
    user,
    "select public.save_supplier($1, null, $2, 'orders@mill.test', 21, 45, 1, 'order', '') as id",
    [tenant, name],
  ).then((rows) => rows[0].id);

/** A draft order for the tenant's owner; returns its id, reference and lines by item. */
async function draftOrder(
  owner: User,
  tenant: string,
  supplier: string,
  lines: { stock_item_id: string; qty: number; unit_cost: number }[],
) {
  const [{ n }] = await as<{ n: number }>(
    owner,
    "select public.create_purchase_order($1, $2, $3::jsonb, '') as n",
    [tenant, supplier, JSON.stringify(lines)],
  );
  const order = await one<{ id: string; reference: string }>(
    "select id, reference from public.purchase_orders where tenant_id = $1 and number = $2",
    [tenant, n],
  );
  const { rows } = await db.query<{ id: string; stock_item_id: string }>(
    "select id, stock_item_id from public.purchase_order_lines where po_id = $1",
    [order.id],
  );
  return { ...order, line: Object.fromEntries(rows.map((r) => [r.stock_item_id, r.id])) };
}
const send = (owner: User, id: string) =>
  as(owner, "select public.set_purchase_order_status($1, 'ordered')", [id]);
const events = async (id: string) =>
  (
    await db.query<{ kind: string; detail: string; actor: string | null }>(
      "select kind, detail, actor from public.purchase_order_events where po_id = $1 order by created_at, kind",
      [id],
    )
  ).rows;

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, carol.id],
  );
  for (const [tenant, prefix] of [
    [tenantA, "a"],
    [tenantB, "b"],
  ]) {
    await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
      tenant,
      JSON.stringify(items(prefix)),
    ]);
  }
  rug = await itemId(tenantA, "a-v1");
  yarn = await itemId(tenantA, "a-v2");
  bobRug = await itemId(tenantB, "b-v1");
  supplierA = await newSupplier(alice, tenantA, "Hill Mill");
  supplierB = await newSupplier(bob, tenantB, "Clay Co");
}, 120_000);

describe("selling seasons", () => {
  it("are a workspace setting: managers write, the team reads, others see nothing", async () => {
    const seasons = seasonsSchema.parse({
      version: 1,
      seasons: [
        { id: "holiday001", name: "Holiday rush", in_stock_by: "2026-12-10", lift_pct: 25 },
      ],
    });
    const body = JSON.stringify(seasons);
    const save = "select public.save_config($1, 'stock', 'seasons', $2::jsonb)";
    await expect(as(carol, save, [tenantA, body])).rejects.toThrow();
    await expect(as(bob, save, [tenantA, body])).rejects.toThrow();
    await as(alice, save, [tenantA, body]);
    const read = (user: User) =>
      as<{ body: unknown }>(
        user,
        "select body from public.configs where tenant_id = $1 and module = 'stock' and key = 'seasons'",
        [tenantA],
      );
    // What comes back parses, with the card open until someone folds it.
    expect(seasonsSchema.parse((await read(carol))[0].body).seasons[0]).toMatchObject({
      name: "Holiday rush",
      lift_pct: 25,
      card: "open",
    });
    expect(await read(bob)).toEqual([]);
    expect(await as(bob, "select 1 from public.configs where tenant_id = $1", [tenantA])).toEqual(
      [],
    );
    // Folding a card is a write like any other, and leaves a version behind.
    seasons.seasons[0].card = "folded";
    await as(alice, save, [tenantA, JSON.stringify(seasons)]);
    const versions = await one<{ n: number }>(
      "select count(*)::int as n from public.config_versions where tenant_id = $1 and module = 'stock' and key = 'seasons'",
      [tenantA],
    );
    expect(versions.n).toBe(2);
    expect(tenantB).not.toBe(tenantA);
  });

  it("refuses a season that isn't one", () => {
    const bad = (season: object) =>
      seasonsSchema.safeParse({ version: 1, seasons: [season] }).success;
    expect(bad({ id: "holiday001", name: "", in_stock_by: "2026-12-10" })).toBe(false);
    expect(bad({ id: "holiday001", name: "Fair", in_stock_by: "Dec 10" })).toBe(false);
    expect(bad({ id: "holiday001", name: "Fair", in_stock_by: "2026-12-10", lift_pct: 900 })).toBe(
      false,
    );
    expect(bad({ id: "holiday001", name: "Fair", in_stock_by: "2026-12-10" })).toBe(true);
  });
});

describe("an order's log", () => {
  it("writes down who sent, renamed, closed and put an order away, by itself", async () => {
    const order = await draftOrder(alice, tenantA, supplierA, [
      { stock_item_id: rug, qty: 3, unit_cost: 60 },
    ]);
    expect(await events(order.id)).toEqual([]);
    await send(alice, order.id);
    await as(alice, "select public.rename_purchase_order($1, $2)", [order.id, "  Spring   rugs "]);
    await as(alice, "select public.set_purchase_order_status($1, 'closed')", [order.id]);
    await as(alice, "select public.archive_purchase_order($1, true)", [order.id]);
    await as(alice, "select public.archive_purchase_order($1, true)", [order.id]); // twice: once
    await as(alice, "select public.archive_purchase_order($1, false)", [order.id]);
    const log = await events(order.id);
    expect(log.map((event) => event.kind).sort()).toEqual([
      "archived",
      "closed",
      "renamed",
      "sent",
      "unarchived",
    ]);
    expect(log.every((event) => event.actor === alice.id)).toBe(true);
    expect(log.find((event) => event.kind === "renamed")?.detail).toBe(
      `${order.reference} → Spring rugs`,
    );
  });

  it("notes an order that closed by itself when the last of it arrived, with nobody's name", async () => {
    const order = await draftOrder(alice, tenantA, supplierA, [
      { stock_item_id: yarn, qty: 2, unit_cost: 8.5 },
    ]);
    await send(alice, order.id);
    await as(
      carol,
      "select * from public.receive_delivery($1, gen_random_uuid(), $2::jsonb, false)",
      [order.id, JSON.stringify([{ line_id: order.line[yarn], quantity: 2 }])],
    );
    const closed = (await events(order.id)).find((event) => event.kind === "closed");
    // Carol checked it in; the receipt says so. The close itself is logged as hers too,
    // since her press is what closed it.
    expect(closed?.actor).toBe(carol.id);
  });

  it("is read by the team, written by nobody, and unseen by other workspaces", async () => {
    const order = await draftOrder(alice, tenantA, supplierA, [
      { stock_item_id: rug, qty: 1, unit_cost: 60 },
    ]);
    await send(alice, order.id);
    const read = (user: User) =>
      as<{ kind: string }>(user, "select kind from public.purchase_order_events where po_id = $1", [
        order.id,
      ]);
    expect(await read(carol)).toEqual([{ kind: "sent" }]);
    expect(await read(bob)).toEqual([]);
    await expect(
      as(
        alice,
        "insert into public.purchase_order_events (tenant_id, po_id, kind) values ($1, $2, 'closed')",
        [tenantA, order.id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(alice, "delete from public.purchase_order_events where po_id = $1", [order.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asAnon(db, (tx) => tx.query("select 1 from public.purchase_order_events")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("renaming an order", () => {
  it("takes a tidy name once per workspace, whatever the capitals", async () => {
    const first = await draftOrder(alice, tenantA, supplierA, [
      { stock_item_id: rug, qty: 1, unit_cost: 60 },
    ]);
    const second = await draftOrder(alice, tenantA, supplierA, [
      { stock_item_id: rug, qty: 1, unit_cost: 60 },
    ]);
    const rename = "select public.rename_purchase_order($1, $2) as reference";
    expect(await as(alice, rename, [first.id, "Autumn yarn #2"])).toEqual([
      { reference: "Autumn yarn #2" },
    ]);
    await expect(as(alice, rename, [second.id, "AUTUMN YARN #2"])).rejects.toThrow(
      /reference_taken/,
    );
    for (const bad of ["ab", "x".repeat(41), "-starts with a dash", "semi;colon"]) {
      await expect(as(alice, rename, [second.id, bad])).rejects.toThrow(/bad_reference/);
    }
    // The same name again is no change, and leaves no second note in the log.
    await as(alice, rename, [first.id, "Autumn yarn #2"]);
    expect((await events(first.id)).filter((event) => event.kind === "renamed")).toHaveLength(1);
    // Another workspace may use the same words for its own order.
    const theirs = await draftOrder(bob, tenantB, supplierB, [
      { stock_item_id: bobRug, qty: 1, unit_cost: 60 },
    ]);
    expect(await as(bob, rename, [theirs.id, "Autumn yarn #2"])).toHaveLength(1);
  });

  it("is for owners and admins of that workspace, and not for a finished order", async () => {
    const order = await draftOrder(alice, tenantA, supplierA, [
      { stock_item_id: rug, qty: 1, unit_cost: 60 },
    ]);
    const rename = "select public.rename_purchase_order($1, 'Mine now')";
    await expect(as(carol, rename, [order.id])).rejects.toThrow();
    await expect(as(bob, rename, [order.id])).rejects.toThrow(/not found/i);
    await expect(asAnon(db, (tx) => tx.query(rename, [order.id]))).rejects.toThrow(
      /permission denied/,
    );
    await as(alice, "select public.set_purchase_order_status($1, 'cancelled')", [order.id]);
    await expect(as(alice, rename, [order.id])).rejects.toThrow(/finished_order/);
    expect(
      (
        await one<{ reference: string }>(
          "select reference from public.purchase_orders where id = $1",
          [order.id],
        )
      ).reference,
    ).toBe(order.reference);
  });
});

describe("putting an order away, and deleting a draft", () => {
  it("archives a draft or a finished order, but not one still on its way", async () => {
    const order = await draftOrder(alice, tenantA, supplierA, [
      { stock_item_id: rug, qty: 1, unit_cost: 60 },
    ]);
    const archive = "select public.archive_purchase_order($1, $2)";
    await expect(as(carol, archive, [order.id, true])).rejects.toThrow();
    await expect(as(bob, archive, [order.id, true])).rejects.toThrow(/not found/i);
    await send(alice, order.id);
    await expect(as(alice, archive, [order.id, true])).rejects.toThrow(/still_open/);
    await as(alice, "select public.set_purchase_order_status($1, 'closed')", [order.id]);
    await as(alice, archive, [order.id, true]);
    const row = () =>
      one<{ archived_at: string | null; archived_by: string | null }>(
        "select archived_at, archived_by from public.purchase_orders where id = $1",
        [order.id],
      );
    expect((await row()).archived_by).toBe(alice.id);
    expect((await row()).archived_at).not.toBeNull();
    // Nobody sets it directly.
    await expect(
      as(alice, "update public.purchase_orders set archived_at = null where id = $1", [order.id]),
    ).rejects.toThrow(/permission denied/);
    await as(alice, archive, [order.id, false]);
    expect((await row()).archived_at).toBeNull();
  });

  it("deletes an unused draft for good, with its lines and log", async () => {
    const order = await draftOrder(alice, tenantA, supplierA, [
      { stock_item_id: rug, qty: 1, unit_cost: 60 },
    ]);
    await as(alice, "select public.rename_purchase_order($1, 'Throwaway')", [order.id]);
    const remove = "select public.delete_draft_purchase_order($1)";
    await expect(as(carol, remove, [order.id])).rejects.toThrow();
    await expect(as(bob, remove, [order.id])).rejects.toThrow(/not found/i);
    await expect(asAnon(db, (tx) => tx.query(remove, [order.id]))).rejects.toThrow(
      /permission denied/,
    );
    await as(alice, remove, [order.id]);
    for (const table of ["purchase_orders", "purchase_order_lines", "purchase_order_events"]) {
      const column = table === "purchase_orders" ? "id" : "po_id";
      expect(
        (await db.query(`select 1 from public.${table} where ${column} = $1`, [order.id])).rows,
      ).toEqual([]);
    }
  });

  it("keeps an order that was sent, and a draft that was emailed", async () => {
    const sent = await draftOrder(alice, tenantA, supplierA, [
      { stock_item_id: rug, qty: 1, unit_cost: 60 },
    ]);
    await send(alice, sent.id);
    const remove = "select public.delete_draft_purchase_order($1)";
    await expect(as(alice, remove, [sent.id])).rejects.toThrow(/not_a_draft/);

    const emailed = await draftOrder(alice, tenantA, supplierA, [
      { stock_item_id: rug, qty: 1, unit_cost: 60 },
    ]);
    await db.query(
      `insert into public.purchase_order_emails
         (tenant_id, po_id, request_key, status, to_emails, subject, sender_email, fingerprint,
          message_id_header, snapshot)
       values ($1, $2, gen_random_uuid(), 'unsure', '{orders@mill.test}', 'Order', 'me@shop.test',
               'f', '<a@b.test>', '{}'::jsonb)`,
      [tenantA, emailed.id],
    );
    await expect(as(alice, remove, [emailed.id])).rejects.toThrow(/has_history/);
    expect(
      (await db.query("select 1 from public.purchase_orders where id = $1", [emailed.id])).rows,
    ).toHaveLength(1);
  });
});

describe("an item's two switches, and the shop's tags", () => {
  const flags = async (id: string) =>
    one<{ dont_reorder: boolean; hidden: boolean; tags: string[] }>(
      "select dont_reorder, hidden, tags from public.stock_items where id = $1",
      [id],
    );

  it("“don't reorder” is a manager's switch, apart from “hidden”, and a sync leaves it alone", async () => {
    const set = "select public.set_stock_items_reorder($1, $2::uuid[], $3) as n";
    await expect(as(carol, set, [tenantA, [rug], true])).rejects.toThrow();
    await expect(as(bob, set, [tenantA, [rug], true])).rejects.toThrow();
    await expect(asAnon(db, (tx) => tx.query(set, [tenantA, [rug], true]))).rejects.toThrow(
      /permission denied/,
    );
    // Another workspace's item named among ours is never touched.
    expect(await as(alice, set, [tenantA, [rug, bobRug], true])).toEqual([{ n: 1 }]);
    expect(await as(alice, set, [tenantA, [rug], true])).toEqual([{ n: 0 }]); // already so
    expect(await flags(rug)).toMatchObject({ dont_reorder: true, hidden: false });
    expect((await flags(bobRug)).dont_reorder).toBe(false);
    await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
      tenantA,
      JSON.stringify(items("a")),
    ]);
    expect((await flags(rug)).dont_reorder).toBe(true);
    await expect(
      as(alice, "update public.stock_items set dont_reorder = false where id = $1", [rug]),
    ).rejects.toThrow(/permission denied/);
    expect(await as(alice, set, [tenantA, [rug], false])).toEqual([{ n: 1 }]);
  });

  it("the sync notes each product's tags on its items, tidied, inside one workspace", async () => {
    const tag = "select public.set_stock_item_tags($1, 'shopify', $2::jsonb) as n";
    const [{ n }] = await service<{ n: number }>(tag, [
      tenantA,
      JSON.stringify([
        { product_external_id: "a-p1", tags: [" Made to order ", "wool", "wool", ""] },
        // Another workspace's product id: nothing of theirs changes.
        { product_external_id: "b-p1", tags: ["not yours"] },
        { product_external_id: "a-p2", tags: "not a list" },
      ]),
    ]);
    expect(n).toBe(1);
    expect((await flags(rug)).tags).toEqual(["Made to order", "wool"]);
    expect((await flags(yarn)).tags).toEqual([]);
    expect((await flags(bobRug)).tags).toEqual([]);
    // The same tags again change nothing; an emptied list clears them.
    expect(
      await service<{ n: number }>(tag, [
        tenantA,
        JSON.stringify([{ product_external_id: "a-p1", tags: ["wool", "Made to order"] }]),
      ]),
    ).toEqual([{ n: 0 }]);
    // Members read them with the item; only the sync writes them.
    expect(
      await as<{ tags: string[] }>(carol, "select tags from public.stock_items where id = $1", [
        rug,
      ]),
    ).toEqual([{ tags: ["Made to order", "wool"] }]);
    await expect(as(alice, tag, [tenantA, "[]"])).rejects.toThrow(/permission denied/);
    await expect(asAnon(db, (tx) => tx.query(tag, [tenantA, "[]"]))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      as(alice, "update public.stock_items set tags = '{}' where id = $1", [rug]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("a supplier's days to arrive", () => {
  const lead = async (id: string) =>
    (
      await one<{ lead_time_days: number | null }>(
        "select lead_time_days from public.suppliers where id = $1",
        [id],
      )
    ).lead_time_days;

  it("can be left empty to follow the workspace's default, and adopted in one press", async () => {
    const [{ id }] = await as<{ id: string }>(
      alice,
      "select public.save_supplier($1, null, 'Usual Co', '', null, 45, 1, 'order', '') as id",
      [tenantA],
    );
    expect(await lead(id)).toBeNull();
    const set = "select public.set_supplier_lead_time($1, $2, $3)";
    await expect(as(carol, set, [tenantA, id, 12])).rejects.toThrow();
    await expect(as(bob, set, [tenantA, id, 12])).rejects.toThrow();
    await expect(as(bob, set, [tenantB, id, 12])).rejects.toThrow(/not found/i);
    await expect(asAnon(db, (tx) => tx.query(set, [tenantA, id, 12]))).rejects.toThrow(
      /permission denied/,
    );
    await expect(as(alice, set, [tenantA, id, 400])).rejects.toThrow(/Bad lead time/);
    await as(alice, set, [tenantA, id, 12]);
    expect(await lead(id)).toBe(12);
    await as(alice, set, [tenantA, id, null]);
    expect(await lead(id)).toBeNull();
  });

  it("a supplier the sync or an import makes starts empty, and an import can fill it in", async () => {
    await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
      tenantA,
      JSON.stringify([{ ...items("a")[0], external_id: "a-v9", vendor: "Shop Vendor" }]),
    ]);
    const vendor = await one<{ id: string }>(
      "select id from public.suppliers where tenant_id = $1 and name = 'Shop Vendor'",
      [tenantA],
    );
    expect(await lead(vendor.id)).toBeNull();
    // The only thing the file changes is the figure that was empty: it must still count.
    const [{ counts }] = await as<{ counts: { new: number; changed: number; same: number } }>(
      alice,
      "select public.import_suppliers($1, gen_random_uuid(), $2::jsonb, 'suppliers.csv', true) as counts",
      [tenantA, JSON.stringify([{ name: "Shop Vendor", lead_time_days: 21 }])],
    );
    expect(counts).toMatchObject({ new: 0, changed: 1, same: 0 });
    expect(await lead(vendor.id)).toBe(21);
  });
});

describe("payments read from the books", () => {
  let mill: string;
  const ledger = async (supplier: string) =>
    (
      await db.query<{
        type: string;
        day: string;
        amount: string;
        source: string;
        key: string | null;
      }>(
        `select type, entry_date::text as day, amount::text, source, external_key as key
         from public.supplier_ledger where supplier_id = $1 order by entry_date, created_at`,
        [supplier],
      )
    ).rows;
  const file = (tenant: string, rows: object[]) =>
    service<{ counts: Record<string, number | boolean> }>(
      "select public.import_book_payments($1, 'quickbooks', $2::jsonb) as counts",
      [tenant, JSON.stringify(rows)],
    ).then((rows) => rows[0].counts);
  const payment = (id: string, date: string, amount: number, payee = "hill mill", memo = "") => ({
    external_id: id,
    kind: "BillPayment",
    date,
    payee,
    amount,
    memo,
  });
  const settings = (tenant: string, user: User, on: boolean) =>
    as(user, "select public.save_config($1, 'stock', 'settings', $2::jsonb)", [
      tenant,
      JSON.stringify({ version: 1, payments_from_books: on }),
    ]);

  it("does nothing until the workspace asks for it", async () => {
    mill = supplierA;
    await as(
      alice,
      "select public.save_ledger_entry($1, $2, 'invoice', '2026-10-01', 500, null, 'INV-1', '')",
      [tenantA, mill],
    );
    const wanted = () =>
      service<{ on: boolean }>("select public.book_payments_wanted($1, 'quickbooks') as on", [
        tenantA,
      ]).then((rows) => rows[0].on);
    expect(await wanted()).toBe(false);
    expect(await file(tenantA, [payment("1", "2026-10-20", 200)])).toEqual({ off: true });
    expect((await ledger(mill)).filter((row) => row.type === "payment")).toEqual([]);
    await settings(tenantA, alice, true);
    expect(await wanted()).toBe(true);
    // Only the books connection is asked.
    expect(
      (
        await service<{ on: boolean }>("select public.book_payments_wanted($1, 'shopify') as on", [
          tenantA,
        ])
      )[0].on,
    ).toBe(false);
  });

  it("files a payment on the supplier of the same name, once, and follows the books' corrections", async () => {
    const rows = [
      payment("1", "2026-10-20", 200, "  Hill MILL ", "inv INV-1"),
      payment("2", "2026-09-01", 75), // before the account's first invoice
      payment("3", "2026-10-21", 10, "Nobody We Know"),
      payment("4", "2026-10-22", -5),
      { ...payment("5", "2026-10-22", 5), kind: "Bill; drop" },
    ];
    expect(await file(tenantA, rows)).toMatchObject({
      read: 5,
      added: 1,
      before_account: 1,
      no_supplier: 3,
    });
    expect((await ledger(mill)).filter((row) => row.type === "payment")).toEqual([
      {
        type: "payment",
        day: "2026-10-20",
        amount: "200.00",
        source: "books",
        key: "qbo:BillPayment:1",
      },
    ]);
    // Read again: nothing new. Corrected in the books: the same row follows.
    expect(await file(tenantA, rows)).toMatchObject({ added: 0, same: 1 });
    expect(await file(tenantA, [payment("1", "2026-10-21", 210)])).toMatchObject({ changed: 1 });
    expect((await ledger(mill)).filter((row) => row.type === "payment")).toMatchObject([
      { day: "2026-10-21", amount: "210.00" },
    ]);
    const [{ description }] = (
      await db.query<{ description: string }>(
        "select description from public.supplier_ledger where external_key = 'qbo:BillPayment:1'",
      )
    ).rows;
    expect(description).toBe("From your books (QuickBooks)");
  });

  it("leaves alone a payment already typed in by hand", async () => {
    await as(
      alice,
      "select public.save_ledger_entry($1, $2, 'payment', '2026-11-02', 90, null, 'wire', '')",
      [tenantA, mill],
    );
    expect(
      await file(tenantA, [payment("9", "2026-11-05", 90), payment("10", "2026-11-12", 90)]),
    ).toMatchObject({ typed_already: 1, added: 1 });
    const keys = (await ledger(mill)).map((row) => row.key).filter(Boolean);
    expect(keys).toEqual(["qbo:BillPayment:1", "qbo:BillPayment:10"]);
  });

  it("stays off an account once a manager has taken it off", async () => {
    const row = await one<{ id: string }>(
      "select id from public.supplier_ledger where external_key = 'qbo:BillPayment:10'",
    );
    await expect(
      as(carol, "select public.remove_ledger_entry($1, $2)", [tenantA, row.id]),
    ).rejects.toThrow();
    await as(alice, "select public.remove_ledger_entry($1, $2)", [tenantA, row.id]);
    expect(await file(tenantA, [payment("10", "2026-11-12", 90)])).toMatchObject({
      taken_off: 1,
      added: 0,
    });
    // A hand-typed entry is removed as before, with nothing noted.
    const typed = await one<{ id: string }>(
      "select id from public.supplier_ledger where supplier_id = $1 and reference = 'wire'",
      [mill],
    );
    await as(alice, "select public.remove_ledger_entry($1, $2)", [tenantA, typed.id]);
    const skips = (
      await db.query<{ external_key: string; skipped_by: string }>(
        "select external_key, skipped_by from public.supplier_ledger_skips where tenant_id = $1",
        [tenantA],
      )
    ).rows;
    expect(skips).toEqual([{ external_key: "qbo:BillPayment:10", skipped_by: alice.id }]);
  });

  it("is for the sync only, and never crosses workspaces", async () => {
    const call = "select public.import_book_payments($1, 'quickbooks', '[]'::jsonb)";
    await expect(as(alice, call, [tenantA])).rejects.toThrow(/permission denied/);
    await expect(asAnon(db, (tx) => tx.query(call, [tenantA]))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      as(alice, "select public.book_payments_wanted($1, 'quickbooks')", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      service("select public.import_book_payments($1, 'shopify', '[]'::jsonb)", [tenantA]),
    ).rejects.toThrow(/Only the books/);
    // Bob's workspace has a supplier of its own and has switched it on; a
    // payment named for Alice's supplier finds nothing there.
    await settings(tenantB, bob, true);
    expect(await file(tenantB, [payment("77", "2026-11-01", 60)])).toMatchObject({
      no_supplier: 1,
      added: 0,
    });
    // Skips and books rows are read by managers of their own workspace only.
    const skips = (user: User) =>
      as(user, "select 1 from public.supplier_ledger_skips where tenant_id = $1", [tenantA]);
    expect(await skips(alice)).toHaveLength(1);
    expect(await skips(carol)).toEqual([]);
    expect(await skips(bob)).toEqual([]);
    await expect(
      as(alice, "delete from public.supplier_ledger_skips where tenant_id = $1", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(
        alice,
        "insert into public.supplier_ledger_skips (tenant_id, supplier_id, external_key) values ($1, $2, 'x')",
        [tenantA, mill],
      ),
    ).rejects.toThrow(/permission denied/);
    // A typed entry can't pass itself off as one from the books, or the other way round.
    await expect(
      db.query(
        "insert into public.supplier_ledger (tenant_id, supplier_id, type, entry_date, amount, source) values ($1, $2, 'payment', '2026-11-01', 1, 'books')",
        [tenantA, mill],
      ),
    ).rejects.toThrow(/supplier_ledger_books_have_a_key/);
  });
});

describe("notices hidden on supplier balances", () => {
  it("are kept with the workspace by its managers", async () => {
    const save = "select public.save_config($1, 'stock', 'hidden_notices', $2::jsonb)";
    const body = JSON.stringify({ version: 1, keys: ["stale:s1:2026-08-06"] });
    await expect(as(carol, save, [tenantA, body])).rejects.toThrow();
    await expect(as(bob, save, [tenantA, body])).rejects.toThrow();
    await as(alice, save, [tenantA, body]);
    const read = (user: User) =>
      as<{ body: { keys: string[] } }>(
        user,
        "select body from public.configs where tenant_id = $1 and module = 'stock' and key = 'hidden_notices'",
        [tenantA],
      );
    expect((await read(alice))[0].body.keys).toEqual(["stale:s1:2026-08-06"]);
    expect(await read(bob)).toEqual([]);
  });
});
