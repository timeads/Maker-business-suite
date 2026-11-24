import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Stock, the gaps closed after the side-by-side with TuftStock: checking a
 * delivery in once, trying the shop again, the daily count behind sold-out
 * days, costs, and planning edits.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let bob: User; // owner of B
let carol: User; // plain member of A
let tenantA: string;
let tenantB: string;
let supplierA: string;
let supplierB: string;
let rug: string;
let yarn: string;
let bobRug: string;

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
const sync = (tenant: string, batch: object[]) =>
  service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
    tenant,
    JSON.stringify(batch),
  ]);
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

/** A sent order for the tenant's owner; returns its id and its lines by item. */
async function sentOrder(
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
  const order = await one<{ id: string }>(
    "select id from public.purchase_orders where tenant_id = $1 and number = $2",
    [tenant, n],
  );
  await as(owner, "select public.set_purchase_order_status($1, 'ordered')", [order.id]);
  const { rows } = await db.query<{ id: string; stock_item_id: string }>(
    "select id, stock_item_id from public.purchase_order_lines where po_id = $1",
    [order.id],
  );
  return { id: order.id, line: Object.fromEntries(rows.map((r) => [r.stock_item_id, r.id])) };
}
const onHand = async (id: string) =>
  (await one<{ on_hand: number }>("select on_hand from public.stock_items where id = $1", [id]))
    .on_hand;
const KEY1 = "11111111-1111-4111-8111-111111111111";
const KEY2 = "22222222-2222-4222-8222-222222222222";

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
  await sync(tenantA, items("a"));
  await sync(tenantB, items("b"));
  supplierA = await newSupplier(alice, tenantA, "Hill Mill");
  supplierB = await newSupplier(bob, tenantB, "Clay Co");
  rug = await itemId(tenantA, "a-v1");
  yarn = await itemId(tenantA, "a-v2");
  bobRug = await itemId(tenantB, "b-v1");
}, 120_000);

describe("checking a delivery in once", () => {
  it("a second press with the same key finds the first delivery and adds nothing", async () => {
    const order = await sentOrder(alice, tenantA, supplierA, [
      { stock_item_id: rug, qty: 10, unit_cost: 60 },
      { stock_item_id: yarn, qty: 40, unit_cost: 8.5 },
    ]);
    const before = [await onHand(rug), await onHand(yarn)];
    const arrived = JSON.stringify([
      { line_id: order.line[rug], quantity: 6 },
      { line_id: order.line[yarn], quantity: 40 },
    ]);
    const press = (key: string, lines = arrived) =>
      as<{ units: number; boxes: number; repeated: boolean }>(
        carol, // anyone on the team can check a delivery in
        "select * from public.receive_delivery($1, $2, $3::jsonb, true)",
        [order.id, key, lines],
      );
    expect(await press(KEY1)).toEqual([{ units: 46, boxes: 2, repeated: false }]);
    expect(await press(KEY1)).toEqual([{ units: 46, boxes: 2, repeated: true }]);
    expect([await onHand(rug), await onHand(yarn)]).toEqual([before[0] + 6, before[1] + 40]);
    const receipts = await db.query<{ quantity: number; shop_status: string }>(
      "select quantity, shop_status from public.stock_receipts where request_key = $1 order by quantity",
      [KEY1],
    );
    expect(receipts.rows).toEqual([
      { quantity: 6, shop_status: "pending" },
      { quantity: 40, shop_status: "pending" },
    ]);
    expect(
      (
        await one<{ status: string }>("select status from public.purchase_orders where id = $1", [
          order.id,
        ])
      ).status,
    ).toBe("partial");

    // A new press (a new key) is a new delivery; the last of it closes the order.
    const rest = JSON.stringify([{ line_id: order.line[rug], quantity: 4 }]);
    expect(await press(KEY2, rest)).toEqual([{ units: 4, boxes: 1, repeated: false }]);
    expect(
      (
        await one<{ status: string }>("select status from public.purchase_orders where id = $1", [
          order.id,
        ])
      ).status,
    ).toBe("closed");
    // Even after the order has closed, the same key still answers with its own delivery.
    expect(await press(KEY2, rest)).toEqual([{ units: 4, boxes: 1, repeated: true }]);
    await expect(press("33333333-3333-4333-8333-333333333333", rest)).rejects.toThrow(
      /isn't waiting on a delivery/,
    );
  });

  it("takes all of a delivery or none of it, and only for the order's own lines", async () => {
    const order = await sentOrder(alice, tenantA, supplierA, [
      { stock_item_id: rug, qty: 5, unit_cost: 60 },
    ]);
    const other = await sentOrder(alice, tenantA, supplierA, [
      { stock_item_id: yarn, qty: 5, unit_cost: 8.5 },
    ]);
    const before = await onHand(rug);
    const key = "44444444-4444-4444-8444-444444444444";
    const bad = [
      [
        { line_id: order.line[rug], quantity: 2 },
        { line_id: other.line[yarn], quantity: 1 },
      ],
      [
        { line_id: order.line[rug], quantity: 2 },
        { line_id: order.line[rug], quantity: 0 },
      ],
      [],
    ];
    for (const lines of bad) {
      await expect(
        as(alice, "select * from public.receive_delivery($1, $2, $3::jsonb, false)", [
          order.id,
          key,
          JSON.stringify(lines),
        ]),
      ).rejects.toThrow(/How many arrived/);
    }
    await expect(
      as(alice, "select * from public.receive_delivery($1, null, '[]'::jsonb, false)", [order.id]),
    ).rejects.toThrow(/request key/);
    expect(await onHand(rug)).toBe(before);
    expect(
      (await db.query("select 1 from public.stock_receipts where request_key = $1", [key])).rows,
    ).toEqual([]);
  });

  it("another workspace can't check in, or reuse a key to peek", async () => {
    const order = await sentOrder(alice, tenantA, supplierA, [
      { stock_item_id: rug, qty: 3, unit_cost: 60 },
    ]);
    const key = "55555555-5555-4555-8555-555555555555";
    const lines = JSON.stringify([{ line_id: order.line[rug], quantity: 3 }]);
    await expect(
      as(bob, "select * from public.receive_delivery($1, $2, $3::jsonb, false)", [
        order.id,
        key,
        lines,
      ]),
    ).rejects.toThrow(/Order not found/);
    await as(alice, "select * from public.receive_delivery($1, $2, $3::jsonb, false)", [
      order.id,
      key,
      lines,
    ]);
    // Bob's own order with Alice's key is its own delivery, not hers.
    const bobs = await sentOrder(bob, tenantB, supplierB, [
      { stock_item_id: bobRug, qty: 2, unit_cost: 60 },
    ]);
    expect(
      await as(bob, "select * from public.receive_delivery($1, $2, $3::jsonb, false)", [
        bobs.id,
        key,
        JSON.stringify([{ line_id: bobs.line[bobRug], quantity: 2 }]),
      ]),
    ).toEqual([{ units: 2, boxes: 1, repeated: false }]);
  });
});

describe("trying the shop again", () => {
  type Try = { id: string; quantity: number; attempt: number; shop_key: string };
  const claim = () => service<Try>("select * from public.claim_stock_receipt_tries(50)");
  const receipt = (id: string) =>
    one<{
      shop_status: string;
      shop_attempts: number;
      shop_can_retry: boolean;
      shop_retried_by: string | null;
      shop_error: string | null;
    }>(
      "select shop_status, shop_attempts, shop_can_retry, shop_retried_by, shop_error from public.stock_receipts where id = $1",
      [id],
    );
  /** Checks one delivery in with "add to my shop" ticked; returns its receipt id. */
  async function pushed(owner: User, tenant: string, supplier: string, item: string, key: string) {
    const order = await sentOrder(owner, tenant, supplier, [
      { stock_item_id: item, qty: 2, unit_cost: 10 },
    ]);
    await as(owner, "select * from public.receive_delivery($1, $2, $3::jsonb, true)", [
      order.id,
      key,
      JSON.stringify([{ line_id: order.line[item], quantity: 2 }]),
    ]);
    return (
      await one<{ id: string }>(
        "select id from public.stock_receipts where tenant_id = $1 and request_key = $2",
        [tenant, key],
      )
    ).id;
  }

  beforeAll(async () => {
    // Clear what the earlier tests queued, so each test sees only its own.
    for (const row of await claim()) {
      await service("select public.finish_stock_receipt_try($1, null, false)", [row.id]);
    }
  });

  it("a manager can put a failed receipt back once, as a new try with its own key", async () => {
    const id = await pushed(alice, tenantA, supplierA, rug, "66666666-6666-4666-8666-666666666661");
    const [first] = await claim();
    expect([first.id, first.attempt]).toEqual([id, 1]);
    expect(await claim()).toEqual([]);
    await service("select public.finish_stock_receipt_try($1, $2, true)", [id, "Shop said no"]);
    expect(await receipt(id)).toMatchObject({
      shop_status: "failed",
      shop_attempts: 1,
      shop_can_retry: true,
    });

    await expect(as(carol, "select public.retry_stock_receipt($1)", [id])).rejects.toThrow(
      /Only owners and admins/,
    );
    await expect(as(bob, "select public.retry_stock_receipt($1)", [id])).rejects.toThrow(
      /Delivery not found/,
    );
    await as(alice, "select public.retry_stock_receipt($1)", [id]);
    // Pressed twice: the second press finds it already waiting and is refused.
    await expect(as(alice, "select public.retry_stock_receipt($1)", [id])).rejects.toThrow(
      /isn't waiting on another try/,
    );
    expect(await receipt(id)).toMatchObject({
      shop_status: "pending",
      shop_can_retry: false,
      shop_retried_by: alice.id,
    });

    const [second] = await claim();
    expect([second.id, second.attempt, second.quantity]).toEqual([id, 2, 2]);
    expect(second.shop_key).not.toBe(first.shop_key);
    await service("select public.finish_stock_receipt_try($1, null, false)", [id]);
    expect(await receipt(id)).toMatchObject({ shop_status: "sent", shop_error: null });
    // In the shop now: there is no way to send it again.
    await expect(as(alice, "select public.retry_stock_receipt($1)", [id])).rejects.toThrow(
      /isn't waiting on another try/,
    );
    expect(await claim()).toEqual([]);
  });

  it("refuses a retry when nobody can say whether the shop took it", async () => {
    const unsure = await pushed(
      alice,
      tenantA,
      supplierA,
      rug,
      "66666666-6666-4666-8666-666666666662",
    );
    await claim();
    await service("select public.finish_stock_receipt_try($1, $2, false)", [unsure, "Timed out"]);
    await expect(as(alice, "select public.retry_stock_receipt($1)", [unsure])).rejects.toThrow(
      /can't tell whether the shop added/,
    );

    // A claim the worker never finished is failed for a person to check, not sent again.
    const lost = await pushed(
      alice,
      tenantA,
      supplierA,
      yarn,
      "66666666-6666-4666-8666-666666666663",
    );
    expect((await claim()).map((r) => r.id)).toEqual([lost]);
    await db.query(
      "update public.stock_receipts set shop_synced_at = now() - interval '20 minutes' where id = $1",
      [lost],
    );
    expect(await service("select * from public.claim_stock_receipts(50)")).toEqual([]);
    expect(await receipt(lost)).toMatchObject({
      shop_status: "failed",
      shop_can_retry: false,
      shop_attempts: 1,
    });
    await expect(as(alice, "select public.retry_stock_receipt($1)", [lost])).rejects.toThrow(
      /can't tell whether the shop added/,
    );
  });

  it("keeps the queue to the worker", async () => {
    await expect(as(alice, "select * from public.claim_stock_receipt_tries(5)")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      as(alice, "select public.finish_stock_receipt_try($1, null, true)", [rug]),
    ).rejects.toThrow(/permission denied/);
  });
});
