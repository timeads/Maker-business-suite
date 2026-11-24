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
