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
  "purchase_order_shipments",
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

describe("what's owed to suppliers", () => {
  const entry = (
    user: User,
    tenant: string,
    supplier: string,
    type: string,
    date: string,
    amount: number,
    more: { stated?: number; ref?: string } = {},
  ) =>
    as<{ id: string }>(
      user,
      "select public.save_ledger_entry($1, $2, $3, $4::date, $5, $6, $7, '') as id",
      [tenant, supplier, type, date, amount, more.stated ?? null, more.ref ?? null],
    ).then((rows) => rows[0].id);

  it("keeps an account of invoices, payments, statements and credits", async () => {
    await entry(alice, tenantA, supplierA, "statement", "2026-10-01", 0, { stated: 1200.5 });
    const invoice = await entry(alice, tenantA, supplierA, "invoice", "2026-10-05", 300, {
      ref: "INV-77",
    });
    await entry(alice, tenantA, supplierA, "payment", "2026-10-09", 500);
    await entry(alice, tenantA, supplierA, "adjustment", "2026-10-10", -25);
    // Typing the same invoice number again corrects it; it isn't added twice.
    const again = await entry(alice, tenantA, supplierA, "invoice", "2026-10-06", 310.4, {
      ref: "inv-77",
    });
    expect(again).toBe(invoice);
    const rows = await as<{ type: string; amount: string; stated_balance: string | null }>(
      alice,
      "select type, amount, stated_balance from public.supplier_ledger where supplier_id = $1 order by entry_date",
      [supplierA],
    );
    expect(
      rows.map((r) => [r.type, Number(r.amount), r.stated_balance && Number(r.stated_balance)]),
    ).toEqual([
      ["statement", 0, 1200.5],
      ["invoice", 310.4, null],
      ["payment", 500, null],
      ["adjustment", -25, null],
    ]);

    await as(alice, "select public.mark_bill_paid($1, $2, true)", [tenantA, invoice]);
    const marked = await as<{ payment_sent_at: string | null }>(
      alice,
      "select payment_sent_at from public.supplier_ledger where id = $1",
      [invoice],
    );
    expect(marked[0].payment_sent_at).not.toBeNull();
    await as(alice, "select public.set_supplier_terms($1, $2, 45)", [tenantA, supplierA]);
  });

  it("refuses entries that make no sense", async () => {
    await expect(entry(alice, tenantA, supplierA, "invoice", "2026-10-05", 0)).rejects.toThrow(
      /amount_needed/,
    );
    await expect(entry(alice, tenantA, supplierA, "payment", "2026-10-05", -5)).rejects.toThrow(
      /amount_needed/,
    );
    await expect(entry(alice, tenantA, supplierA, "gift", "2026-10-05", 5)).rejects.toThrow(
      /not valid/,
    );
    await expect(entry(alice, tenantA, supplierA, "invoice", "1990-01-01", 5)).rejects.toThrow(
      /not valid/,
    );
  });

  it("is for owners and admins of that workspace only", async () => {
    // A plain member can't read the account or write to it.
    expect(await as(carol, "select id from public.supplier_ledger")).toEqual([]);
    await expect(entry(carol, tenantA, supplierA, "invoice", "2026-10-05", 10)).rejects.toThrow(
      /Only owners|not allowed|permission/i,
    );
    // Another workspace sees nothing and can't touch it.
    expect(await as(bob, "select id from public.supplier_ledger")).toEqual([]);
    await expect(entry(bob, tenantB, supplierA, "invoice", "2026-10-05", 10)).rejects.toThrow(
      /Supplier not found/,
    );
    await expect(entry(bob, tenantA, supplierA, "invoice", "2026-10-05", 10)).rejects.toThrow(
      /Workspace not found|Only owners/,
    );
    const mine = await as<{ id: string }>(
      alice,
      "select id from public.supplier_ledger where supplier_id = $1 limit 1",
      [supplierA],
    );
    await expect(
      as(bob, "select public.remove_ledger_entry($1, $2)", [tenantB, mine[0].id]),
    ).rejects.toThrow(/Entry not found/);
    await expect(
      as(bob, "select public.mark_bill_paid($1, $2, true)", [tenantB, mine[0].id]),
    ).rejects.toThrow(/Entry not found/);
    await expect(
      as(bob, "select public.set_supplier_terms($1, $2, 10)", [tenantB, supplierA]),
    ).rejects.toThrow(/Supplier not found/);
    await expect(
      as(
        alice,
        "insert into public.supplier_ledger (tenant_id, supplier_id, type, entry_date, amount) values ($1, $2, 'invoice', current_date, 1)",
        [tenantA, supplierA],
      ),
    ).rejects.toThrow(/permission denied/);

    await as(alice, "select public.remove_ledger_entry($1, $2)", [tenantA, mine[0].id]);
  });
});

describe("stock, round two: cases, drafts in one go, order money and tracking", () => {
  let dye: string;
  let bobSupplier: string;
  let bobItem: string;
  const KEY = "11111111-2222-4333-8444-555555555555";
  const poByNumber = async (tenant: string, number: number) =>
    (
      await db.query<{
        id: string;
        status: string;
        supplier_id: string;
        expected_on: string | null;
        shipping_cost: string;
        tax_rate_pct: string;
        adjustments: { label: string; amount: string }[];
      }>(
        "select id, status, supplier_id, expected_on::text, shipping_cost, tax_rate_pct, adjustments from public.purchase_orders where tenant_id = $1 and number = $2",
        [tenant, number],
      )
    ).rows[0];
  const lineRows = async (poId: string) =>
    (
      await db.query<{
        stock_item_id: string;
        qty_ordered: number;
        unit_cost: string;
        supplier_sku: string | null;
        note: string;
      }>(
        "select stock_item_id, qty_ordered, unit_cost, supplier_sku, note from public.purchase_order_lines where po_id = $1 and qty_ordered > 0 order by qty_ordered",
        [poId],
      )
    ).rows;
  const draft = (user: User, tenant: string, key: string, orders: object[]) =>
    as<{ numbers: number[] }>(
      user,
      "select public.draft_purchase_orders($1, $2, $3::jsonb) as numbers",
      [tenant, key, JSON.stringify(orders)],
    ).then((rows) => rows[0].numbers);

  beforeAll(async () => {
    dye = await newSupplier(alice, tenantA, "Dye Works");
    bobSupplier = (
      await db.query<{ id: string }>(
        "select id from public.suppliers where tenant_id = $1 and name = 'Clay Co'",
        [tenantB],
      )
    ).rows[0].id;
    bobItem = await itemId(tenantB, "b-v1");
  });

  it("an item's case size, smallest order and supplier code are the workspace's own, kept across syncs", async () => {
    await as(
      alice,
      "select public.save_stock_item_plan($1, $2, $3, 14, null, 3, false, 36, 72, ' HM-77 ')",
      [tenantA, yarn, supplierA],
    );
    await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
      tenantA,
      JSON.stringify(items("a")),
    ]);
    const { rows } = await db.query(
      "select case_pack, moq, supplier_sku, hidden, supplier_id, lead_time_days, safety_stock from public.stock_items where id = $1",
      [yarn],
    );
    expect(rows[0]).toEqual({
      case_pack: 36,
      moq: 72,
      supplier_sku: "HM-77",
      hidden: false,
      supplier_id: supplierA,
      lead_time_days: 14,
      safety_stock: 3,
    });
    // Planning is for owners and admins of that workspace.
    await expect(
      as(
        carol,
        "select public.save_stock_item_plan($1, $2, null, null, null, 0, false, null, null, '')",
        [tenantA, yarn],
      ),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      as(bob, "select public.save_stock_item_plan($1, $2, null, null, null, 0, true, 5, 5, 'X')", [
        tenantB,
        yarn,
      ]),
    ).rejects.toThrow(/Item not found/);
    await expect(
      as(
        alice,
        "select public.save_stock_item_plan($1, $2, $3, null, null, 0, false, null, null, '')",
        [tenantA, yarn, bobSupplier],
      ),
    ).rejects.toThrow(/Supplier not found/);
    await expect(
      as(
        alice,
        "select public.save_stock_item_plan($1, $2, null, null, null, 0, false, 0, null, '')",
        [tenantA, rug],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('"don\'t reorder" can be set for several items at once, brought back, and survives a sync', async () => {
    const hide = (user: User, tenant: string, ids: string[], hidden: boolean) =>
      as<{ n: number }>(user, "select public.set_stock_items_hidden($1, $2, $3) as n", [
        tenant,
        ids,
        hidden,
      ]).then((rows) => rows[0].n);
    expect(await hide(alice, tenantA, [rug, yarn], true)).toBe(2);
    // Pressing it again changes nothing.
    expect(await hide(alice, tenantA, [rug, yarn], true)).toBe(0);
    await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
      tenantA,
      JSON.stringify(items("a")),
    ]);
    const hidden = async () =>
      (
        await db.query<{ hidden: boolean; case_pack: number | null }>(
          "select hidden, case_pack from public.stock_items where id = any($1) order by case_pack nulls first",
          [[rug, yarn]],
        )
      ).rows;
    // Hidden stays through the sync, and hiding left the rest of the planning alone.
    expect(await hidden()).toEqual([
      { hidden: true, case_pack: null },
      { hidden: true, case_pack: 36 },
    ]);
    // Another workspace's owner can't reach these items, and a member can't hide anything.
    expect(await hide(bob, tenantB, [rug, yarn], false)).toBe(0);
    await expect(hide(carol, tenantA, [rug], false)).rejects.toThrow(/Only owners and admins/);
    await expect(hide(bob, tenantA, [rug], false)).rejects.toThrow(
      /Workspace not found|Only owners/,
    );
    expect((await hidden()).every((row) => row.hidden)).toBe(true);
    expect(await hide(alice, tenantA, [rug, yarn], false)).toBe(2);
  });

  it("drafts one order per supplier in one go, and a second press makes nothing new", async () => {
    const orders = [
      {
        supplier_id: supplierA,
        expected_on: "2027-02-01",
        lines: [{ stock_item_id: yarn, qty: 72, unit_cost: "8.50" }],
      },
      {
        supplier_id: dye,
        expected_on: "",
        lines: [
          { stock_item_id: rug, qty: 6, unit_cost: "60.00", supplier_sku: "RUG-X", note: "" },
        ],
      },
    ];
    const before = (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.purchase_orders where tenant_id = $1",
        [tenantA],
      )
    ).rows[0].n;
    const first = await draft(alice, tenantA, KEY, orders);
    expect(first).toHaveLength(2);
    expect(first[1]).toBe(first[0] + 1);
    // The double click: same key, same orders back, nothing added.
    expect(await draft(alice, tenantA, KEY, orders)).toEqual(first);
    // Even if what's ticked has changed in between, the key still names the first press.
    expect(await draft(alice, tenantA, KEY, [orders[0]])).toEqual(first);
    const after = (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.purchase_orders where tenant_id = $1",
        [tenantA],
      )
    ).rows[0].n;
    expect(after - before).toBe(2);

    const toMill = await poByNumber(tenantA, first[0]);
    expect([toMill.status, toMill.supplier_id, toMill.expected_on]).toEqual([
      "draft",
      supplierA,
      "2027-02-01",
    ]);
    // A line with no code of its own takes the item's.
    expect(await lineRows(toMill.id)).toEqual([
      { stock_item_id: yarn, qty_ordered: 72, unit_cost: "8.50", supplier_sku: "HM-77", note: "" },
    ]);
    const toDye = await poByNumber(tenantA, first[1]);
    expect(toDye.expected_on).toBeNull();
    expect((await lineRows(toDye.id))[0].supplier_sku).toBe("RUG-X");

    // A new key is a new press.
    const again = await draft(alice, tenantA, "99999999-2222-4333-8444-555555555555", [orders[1]]);
    expect(again).toEqual([first[1] + 1]);
  });

  it("only owners and admins draft orders, and never with another workspace's supplier or items", async () => {
    const one = (supplier: string, item: string) => [
      {
        supplier_id: supplier,
        expected_on: "",
        lines: [{ stock_item_id: item, qty: 1, unit_cost: 1 }],
      },
    ];
    const key = "aaaaaaaa-2222-4333-8444-555555555555";
    await expect(draft(carol, tenantA, key, one(supplierA, rug))).rejects.toThrow(
      /Only owners and admins/,
    );
    await expect(draft(bob, tenantA, key, one(supplierA, rug))).rejects.toThrow(
      /Workspace not found|Only owners/,
    );
    await expect(draft(bob, tenantB, key, one(supplierA, bobItem))).rejects.toThrow(
      /Supplier not found/,
    );
    await expect(draft(bob, tenantB, key, one(bobSupplier, rug))).rejects.toThrow(/Item not found/);
    await expect(
      as(alice, "select public.draft_purchase_orders($1, null, '[]'::jsonb)", [tenantA]),
    ).rejects.toThrow(/request key/);
    // A key used in one workspace means nothing in another.
    const theirs = await draft(bob, tenantB, KEY, one(bobSupplier, bobItem));
    expect(theirs).toHaveLength(1);
    expect((await poByNumber(tenantB, theirs[0])).supplier_id).toBe(bobSupplier);
    // None of those refusals left anything behind.
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from public.purchase_orders where request_key = $1",
          [key],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("saves shipping, tax and named adjustments, and lets lines change until the order is closed", async () => {
    const [number] = await draft(alice, tenantA, "bbbbbbbb-2222-4333-8444-555555555555", [
      {
        supplier_id: supplierA,
        expected_on: "",
        lines: [
          { stock_item_id: yarn, qty: 36, unit_cost: "8.50" },
          { stock_item_id: rug, qty: 2, unit_cost: "60" },
        ],
      },
    ]);
    const order = await poByNumber(tenantA, number);
    const save = (user: User, lines: object[], shipping: unknown, tax: unknown, adj: object[]) =>
      as(
        user,
        "select public.save_purchase_order($1, $2::jsonb, 'Thanks', '2027-03-01', $3, $4, $5::jsonb)",
        [order.id, JSON.stringify(lines), shipping, tax, JSON.stringify(adj)],
      );
    const yarnLine = { stock_item_id: yarn, qty: 72, unit_cost: "8.25", note: "Blue only" };
    await save(
      alice,
      [yarnLine, { stock_item_id: rug, qty: 2, unit_cost: "60" }],
      "25.5",
      "8.875",
      [
        { label: " Pallet fee ", amount: "12.345" },
        { label: "Loyalty discount", amount: -10 },
        { label: "", amount: 5 },
        { label: "Nothing", amount: 0 },
      ],
    );
    const saved = await poByNumber(tenantA, number);
    expect(Number(saved.shipping_cost)).toBe(25.5);
    expect(Number(saved.tax_rate_pct)).toBe(8.875);
    expect(saved.adjustments).toEqual([
      { label: "Pallet fee", amount: "12.35" },
      { label: "Loyalty discount", amount: "-10.00" },
    ]);
    expect(saved.expected_on).toBe("2027-03-01");
    expect((await lineRows(order.id)).map((l) => [l.qty_ordered, l.unit_cost, l.note])).toEqual([
      [2, "60.00", ""],
      [72, "8.25", "Blue only"],
    ]);

    await expect(save(alice, [yarnLine], -1, 0, [])).rejects.toThrow(/not valid/);
    await expect(save(alice, [yarnLine], 0, 101, [])).rejects.toThrow(/not valid/);
    await expect(save(carol, [yarnLine], 0, 0, [])).rejects.toThrow(/Only owners and admins/);
    await expect(save(bob, [yarnLine], 0, 0, [])).rejects.toThrow(/Order not found/);

    // After it has gone out, quantities and costs can still be put right...
    await as(alice, "select public.set_purchase_order_status($1, 'ordered')", [order.id]);
    await as(
      carol,
      "select public.receive_po_line(l.id, 30, false) from public.purchase_order_lines l where l.po_id = $1 and l.stock_item_id = $2",
      [order.id, yarn],
    );
    // ...including taking a line off (the rug never shipped) and re-pricing another.
    await save(alice, [{ ...yarnLine, qty: 60, unit_cost: "8.00" }], 0, 0, []);
    const { rows: now } = await db.query<{
      stock_item_id: string;
      qty_ordered: number;
      qty_received: number;
      unit_cost: string;
    }>(
      "select stock_item_id, qty_ordered, qty_received, unit_cost from public.purchase_order_lines where po_id = $1 order by qty_ordered",
      [order.id],
    );
    expect(now).toEqual([
      { stock_item_id: rug, qty_ordered: 0, qty_received: 0, unit_cost: "60.00" },
      // What was checked in is kept whatever happens to the line.
      { stock_item_id: yarn, qty_ordered: 60, qty_received: 30, unit_cost: "8.00" },
    ]);
    expect((await poByNumber(tenantA, number)).status).toBe("partial");
    // ...but an order that has gone out can't be emptied, and a closed one is finished.
    await expect(save(alice, [], 0, 0, [])).rejects.toThrow(/Add something/);
    await as(alice, "select public.set_purchase_order_status($1, 'closed')", [order.id]);
    await expect(save(alice, [yarnLine], 0, 0, [])).rejects.toThrow(/finished/);
  });

  it("tracks what's on its way: tracking numbers per order, each workspace's own", async () => {
    const [number] = await draft(alice, tenantA, "cccccccc-2222-4333-8444-555555555555", [
      {
        supplier_id: supplierA,
        expected_on: "2027-01-10",
        lines: [{ stock_item_id: yarn, qty: 36, unit_cost: "8.50" }],
      },
    ]);
    const order = await poByNumber(tenantA, number);
    const add = (user: User, poId: string, tracking: string, arrived: string | null = null) =>
      as<{ id: string }>(
        user,
        "select public.save_po_shipment($1, null, 'UPS', $2, '2027-01-08', $3::date, 'By sea') as id",
        [poId, tracking, arrived],
      ).then((rows) => rows[0].id);
    // Nothing to track until the order has been sent.
    await expect(add(alice, order.id, "1Z999AA10123456784")).rejects.toThrow(/have been sent/);
    await as(alice, "select public.set_purchase_order_status($1, 'ordered')", [order.id]);
    const first = await add(alice, order.id, " 1z999 aa1-0123456784 ");
    // The same number again (a second press, or typed with spaces) is the same parcel.
    expect(await add(alice, order.id, "1Z999AA10123456784", "2027-01-09")).toBe(first);
    const second = await add(alice, order.id, "1Z999AA10123456999");
    await expect(add(alice, order.id, "x")).rejects.toThrow(/not valid/);

    // Bob's own order, so both workspaces have rows to keep apart.
    const [bobNumber] = await draft(bob, tenantB, "dddddddd-2222-4333-8444-555555555555", [
      {
        supplier_id: bobSupplier,
        expected_on: "",
        lines: [{ stock_item_id: bobItem, qty: 3, unit_cost: 4 }],
      },
    ]);
    const bobOrder = await poByNumber(tenantB, bobNumber);
    await as(bob, "select public.set_purchase_order_status($1, 'ordered')", [bobOrder.id]);
    await add(bob, bobOrder.id, "1Z999AA10123456784");

    const mine = await as<{ tenant_id: string; tracking: string; arrived_on: string | null }>(
      alice,
      "select tenant_id, tracking, arrived_on::text from public.purchase_order_shipments order by created_at",
    );
    expect(mine.map((row) => [row.tenant_id, row.tracking, row.arrived_on])).toEqual([
      [tenantA, "1Z999AA10123456784", "2027-01-09"],
      [tenantA, "1Z999AA10123456999", null],
    ]);
    const theirs = await as<{ tenant_id: string }>(
      bob,
      "select tenant_id from public.purchase_order_shipments",
    );
    expect(theirs).toEqual([{ tenant_id: tenantB }]);
    // The whole team can see tracking; nobody writes the table directly.
    expect(await as(carol, "select id from public.purchase_order_shipments")).toHaveLength(2);
    for (const user of [alice, bob, carol]) {
      await expect(
        as(user, "update public.purchase_order_shipments set note = 'x'"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(
          user,
          "insert into public.purchase_order_shipments (tenant_id, po_id, tracking) values ($1, $2, 'ABCD1234')",
          [tenantA, order.id],
        ),
      ).rejects.toThrow(/permission denied/);
    }

    // Adding, changing and removing are for that workspace's owners and admins.
    await expect(add(carol, order.id, "1Z999AA10123450000")).rejects.toThrow(
      /Only owners and admins/,
    );
    await expect(add(bob, order.id, "1Z999AA10123450000")).rejects.toThrow(/Order not found/);
    await expect(
      as(bob, "select public.save_po_shipment($1, $2, 'UPS', 'HIJACK123', null, null, '')", [
        bobOrder.id,
        first,
      ]),
    ).rejects.toThrow(/Tracking number not found/);
    await expect(as(bob, "select public.remove_po_shipment($1)", [second])).rejects.toThrow(
      /Tracking number not found/,
    );
    await expect(as(carol, "select public.remove_po_shipment($1)", [second])).rejects.toThrow(
      /Only owners and admins/,
    );

    // Taking a number off keeps the row, hides nothing from the record, and frees the number.
    await as(alice, "select public.remove_po_shipment($1)", [second]);
    await expect(as(alice, "select public.remove_po_shipment($1)", [second])).rejects.toThrow(
      /Tracking number not found/,
    );
    const left = await as<{ id: string; removed: boolean }>(
      alice,
      "select id, removed_at is not null as removed from public.purchase_order_shipments order by created_at",
    );
    expect(left).toEqual([
      { id: first, removed: false },
      { id: second, removed: true },
    ]);
    expect(await add(alice, order.id, "1Z999AA10123456999")).not.toBe(second);
  });
});
