import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };

let db: PGlite;
let alice: User;
let bob: User;
let carol: User; // plain member of tenant A
let tenantA: string;
let tenantB: string;
let supplierA: string;
let rug: string;
let yarn: string;

const TABLES = [
  "suppliers",
  "stock_items",
  "purchase_orders",
  "purchase_order_lines",
  "stock_receipts",
];

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
    await db.query<{ id: string }>(
      "select id from public.stock_items where tenant_id = $1 and external_id = $2",
      [tenant, external],
    )
  ).rows[0].id;

const newSupplier = (user: User, tenant: string, name: string) =>
  as<{ id: string }>(
    user,
    "select public.save_supplier($1, null, $2, 'orders@mill.test', 21, 45, 10, 'order', '') as id",
    [tenant, name],
  ).then((rows) => rows[0].id);

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
  await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
    tenantA,
    JSON.stringify(items("a")),
  ]);
  await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
    tenantB,
    JSON.stringify(items("b")),
  ]);
  supplierA = await newSupplier(alice, tenantA, "Hill Mill");
  await newSupplier(bob, tenantB, "Clay Co");
  rug = await itemId(tenantA, "a-v1");
  yarn = await itemId(tenantA, "a-v2");
});

describe("cross-tenant isolation for stock", () => {
  it("each workspace sees only its own rows, and clients can't write tables directly", async () => {
    await as(alice, "select public.create_purchase_order($1, $2, $3::jsonb, '')", [
      tenantA,
      supplierA,
      JSON.stringify([{ stock_item_id: rug, qty: 5, unit_cost: 60 }]),
    ]);
    for (const table of TABLES) {
      const mine = await as<{ tenant_id: string }>(alice, `select tenant_id from public.${table}`);
      expect(mine.every((row) => row.tenant_id === tenantA)).toBe(true);
      const theirs = await as<{ tenant_id: string }>(bob, `select tenant_id from public.${table}`);
      expect(theirs.every((row) => row.tenant_id === tenantB)).toBe(true);
      await expect(as(alice, `update public.${table} set tenant_id = tenant_id`)).rejects.toThrow(
        /permission denied/,
      );
    }
    expect((await as(alice, "select id from public.stock_items")).length).toBe(2);
  });

  it("nobody can plan, order or receive across workspaces", async () => {
    const bobSupplier = (
      await db.query<{ id: string }>("select id from public.suppliers where tenant_id = $1", [
        tenantB,
      ])
    ).rows[0].id;
    await expect(
      as(bob, "select public.assign_stock_supplier($1, $2, $3)", [tenantA, [rug], bobSupplier]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      as(alice, "select public.assign_stock_supplier($1, $2, $3)", [tenantA, [rug], bobSupplier]),
    ).rejects.toThrow(/Supplier not found/);
    await expect(
      as(bob, "select public.create_purchase_order($1, $2, $3::jsonb, '')", [
        tenantB,
        bobSupplier,
        JSON.stringify([{ stock_item_id: rug, qty: 1, unit_cost: 1 }]),
      ]),
    ).rejects.toThrow(/Item not found/);
    const line = (
      await db.query<{ id: string }>(
        "select id from public.purchase_order_lines where tenant_id = $1 limit 1",
        [tenantA],
      )
    ).rows[0].id;
    await expect(as(bob, "select public.receive_po_line($1, 1, false)", [line])).rejects.toThrow(
      /Order not found/,
    );
    await expect(
      as(alice, "select public.upsert_stock_items($1, 'shopify', '[]'::jsonb)", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    await expect(as(alice, "select * from public.claim_stock_receipts(5)")).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("syncing stock items", () => {
  it("a later sync updates the count and keeps the workspace's own planning", async () => {
    await as(alice, "select public.plan_stock_items($1, $2, $3, 14, null, 3, false)", [
      tenantA,
      [yarn],
      supplierA,
    ]);
    const changed = items("a");
    changed[1].on_hand = 22;
    await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
      tenantA,
      JSON.stringify(changed),
    ]);
    const { rows } = await db.query(
      "select on_hand, supplier_id, lead_time_days, coverage_days, safety_stock from public.stock_items where id = $1",
      [yarn],
    );
    expect(rows[0]).toEqual({
      on_hand: 22,
      supplier_id: supplierA,
      lead_time_days: 14,
      coverage_days: null,
      safety_stock: 3,
    });
  });

  it("the shop's vendors come in as suppliers, without undoing a choice made by hand", async () => {
    const batch = [
      { external_id: "v-1", title: "Loop pile yarn", on_hand: 4, vendor: " Karida Mills " },
      { external_id: "v-2", title: "Cut pile yarn", on_hand: 9, vendor: "Karida Mills" },
      { external_id: "v-3", title: "Backing cloth", on_hand: 2, vendor: "Loom & Co", price: 18.5 },
      { external_id: "v-4", title: "Gift card", on_hand: 0, vendor: "" },
    ];
    const sync = () =>
      service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
        tenantA,
        JSON.stringify(batch),
      ]);
    await sync();
    await sync();
    const made = await as<{ name: string }>(
      alice,
      "select name from public.suppliers where name in ('Karida Mills', 'Loom & Co') order by name",
    );
    expect(made).toEqual([{ name: "Karida Mills" }, { name: "Loom & Co" }]);
    const filed = await as<{ external_id: string; supplier: string | null; price: string | null }>(
      alice,
      `select si.external_id, s.name as supplier, si.price from public.stock_items si
       left join public.suppliers s on s.id = si.supplier_id
       where si.external_id like 'v-%' order by si.external_id`,
    );
    expect(filed.map((row) => row.supplier)).toEqual([
      "Karida Mills",
      "Karida Mills",
      "Loom & Co",
      null,
    ]);
    expect(Number(filed[2].price)).toBe(18.5);

    // Someone moves an item to another supplier: the next sync leaves it there.
    await db.query(
      "update public.stock_items set supplier_id = $1 where tenant_id = $2 and external_id = 'v-1'",
      [supplierA, tenantA],
    );
    await sync();
    const { rows } = await db.query<{ supplier_id: string }>(
      "select supplier_id from public.stock_items where tenant_id = $1 and external_id = 'v-1'",
      [tenantA],
    );
    expect(rows[0].supplier_id).toBe(supplierA);
    // None of it reaches the other workspace.
    expect(
      await as(
        bob,
        "select name from public.suppliers where name in ('Karida Mills', 'Loom & Co')",
      ),
    ).toEqual([]);
  });

  it("counts sales per item per local day, by SKU or by product and option", async () => {
    const order = (id: string, at: string, lines: object[], extra: object = {}) => ({
      external_id: id,
      name: `#${id}`,
      processed_at: at,
      currency: "USD",
      net_sales: 10,
      total: 10,
      lines,
      ...extra,
    });
    await service(
      "select public.upsert_commerce_batch($1, 'shopify', '[]'::jsonb, '[]'::jsonb, $2::jsonb)",
      [
        tenantA,
        JSON.stringify([
          // 03:30 UTC is still the evening before in New York.
          order("s1", new Date(Date.now() - 2 * 86_400_000).toISOString(), [
            { external_id: "l1", title: "Wool rug", sku: "a-RUG-L", quantity: 2, unit_price: 5 },
            {
              external_id: "l2",
              title: "Yarn bundle",
              product_external_id: "a-p2",
              quantity: 3,
              unit_price: 5,
            },
          ]),
          order("s2", new Date(Date.now() - 86_400_000).toISOString(), [
            { external_id: "l3", title: "Wool rug", sku: "a-RUG-L", quantity: 1, unit_price: 5 },
          ]),
          order(
            "s3",
            new Date(Date.now() - 86_400_000).toISOString(),
            [{ external_id: "l4", title: "Wool rug", sku: "a-RUG-L", quantity: 9, unit_price: 5 }],
            { cancelled_at: new Date().toISOString() },
          ),
        ]),
      ],
    );
    const rows = await as<{ stock_item_id: string; units: string }>(
      alice,
      "select stock_item_id, sum(units) as units from public.stock_sales_by_day($1, 30) group by 1",
      [tenantA],
    );
    const units = Object.fromEntries(rows.map((r) => [r.stock_item_id, Number(r.units)]));
    expect(units[rug]).toBe(3);
    expect(units[yarn]).toBe(3);
    expect(await as(bob, "select * from public.stock_sales_by_day($1, 30)", [tenantA])).toEqual([]);
  });
});

describe("purchase orders", () => {
  const po = async (number: number) =>
    (
      await db.query<{ id: string; status: string; closed_at: string | null }>(
        "select id, status, closed_at from public.purchase_orders where tenant_id = $1 and number = $2",
        [tenantA, number],
      )
    ).rows[0];
  const lines = async (poId: string) =>
    (
      await db.query<{
        id: string;
        stock_item_id: string;
        qty_ordered: number;
        qty_received: number;
      }>(
        "select id, stock_item_id, qty_ordered, qty_received from public.purchase_order_lines where po_id = $1 order by qty_ordered desc",
        [poId],
      )
    ).rows;

  it("numbers orders per workspace and only lets owners and admins raise them", async () => {
    const rows = await as<{ n: number }>(
      alice,
      "select public.create_purchase_order($1, $2, $3::jsonb, 'Spring restock') as n",
      [
        tenantA,
        supplierA,
        JSON.stringify([
          { stock_item_id: rug, qty: 10, unit_cost: 60 },
          { stock_item_id: yarn, qty: 40, unit_cost: 8.5 },
        ]),
      ],
    );
    expect(rows[0].n).toBe(2);
    await expect(
      as(carol, "select public.create_purchase_order($1, $2, '[]'::jsonb, '')", [
        tenantA,
        supplierA,
      ]),
    ).rejects.toThrow(/Only owners and admins/);
  });

  it("a draft's lines can be rewritten; a line left out drops to zero", async () => {
    const order = await po(2);
    await as(alice, "select public.update_purchase_order($1, $2::jsonb, 'Changed', '2027-01-15')", [
      order.id,
      JSON.stringify([{ stock_item_id: rug, qty: 12, unit_cost: 58 }]),
    ]);
    const now = await lines(order.id);
    expect(now.map((l) => l.qty_ordered)).toEqual([12, 0]);
    await as(alice, "select public.update_purchase_order($1, $2::jsonb, 'Changed', '2027-01-15')", [
      order.id,
      JSON.stringify([
        { stock_item_id: rug, qty: 12, unit_cost: 58 },
        { stock_item_id: yarn, qty: 40, unit_cost: 8.5 },
      ]),
    ]);
  });

  it("receiving moves the order to partial then closed, bumps the count and queues the shop update", async () => {
    const order = await po(2);
    const [yarnLine, rugLine] = await lines(order.id);
    await expect(
      as(carol, "select public.receive_po_line($1, 5, true)", [rugLine.id]),
    ).rejects.toThrow(/isn't waiting on a delivery/);
    await as(alice, "select public.set_purchase_order_status($1, 'ordered')", [order.id]);
    await expect(
      as(alice, "select public.update_purchase_order($1, $2::jsonb, '', null)", [
        order.id,
        JSON.stringify([]),
      ]),
    ).resolves.toBeDefined();
    // Lines of an order that has gone out stay as they were.
    expect((await lines(order.id)).map((l) => l.qty_ordered)).toEqual([40, 12]);

    const before = (
      await db.query<{ on_hand: number }>("select on_hand from public.stock_items where id = $1", [
        rug,
      ])
    ).rows[0].on_hand;
    // Anyone on the team can check a delivery in.
    await as(carol, "select public.receive_po_line($1, 5, true)", [rugLine.id]);
    expect((await po(2)).status).toBe("partial");
    await as(carol, "select public.receive_po_line($1, 7, false)", [rugLine.id]);
    await as(carol, "select public.receive_po_line($1, 40, true)", [yarnLine.id]);
    const closed = await po(2);
    expect(closed.status).toBe("closed");
    expect(closed.closed_at).not.toBeNull();
    const after = (
      await db.query<{ on_hand: number }>("select on_hand from public.stock_items where id = $1", [
        rug,
      ])
    ).rows[0].on_hand;
    expect(after - before).toBe(12);
    await expect(
      as(carol, "select public.receive_po_line($1, 1, false)", [rugLine.id]),
    ).rejects.toThrow(/isn't waiting on a delivery/);

    const claimed = await service<{ id: string; quantity: number; inventory_item_id: string }>(
      "select * from public.claim_stock_receipts(10)",
    );
    expect(claimed.map((r) => [r.inventory_item_id, r.quantity]).sort()).toEqual([
      ["a-i1", 5],
      ["a-i2", 40],
    ]);
    expect(await service("select * from public.claim_stock_receipts(10)")).toEqual([]);
    await service("select public.finish_stock_receipt($1, null)", [claimed[0].id]);
    await service("select public.finish_stock_receipt($1, 'Shop said no')", [claimed[1].id]);
    const { rows } = await db.query<{ shop_status: string }>(
      "select shop_status from public.stock_receipts where tenant_id = $1 order by shop_status",
      [tenantA],
    );
    expect(rows.map((r) => r.shop_status)).toEqual(["failed", "sent", "skipped"]);
  });

  it("an empty draft can't be sent, and finished orders can't be reopened", async () => {
    const rows = await as<{ n: number }>(
      alice,
      "select public.create_purchase_order($1, $2, '[]'::jsonb, '') as n",
      [tenantA, supplierA],
    );
    const empty = await po(rows[0].n);
    await expect(
      as(alice, "select public.set_purchase_order_status($1, 'ordered')", [empty.id]),
    ).rejects.toThrow(/Add something/);
    await as(alice, "select public.set_purchase_order_status($1, 'cancelled')", [empty.id]);
    await expect(
      as(alice, "select public.set_purchase_order_status($1, 'ordered')", [empty.id]),
    ).rejects.toThrow(/isn't possible/);
  });
});
