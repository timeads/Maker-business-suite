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

async function shopOrder(
  tenant: string,
  id: string,
  email: string,
  customer: string,
  extra: Record<string, unknown> = {},
) {
  await service(
    "select public.upsert_commerce_batch($1, 'shopify', $2::jsonb, '[]'::jsonb, $3::jsonb)",
    [
      tenant,
      JSON.stringify([{ external_id: customer, email, first_name: "Sam", last_name: "Shopper" }]),
      JSON.stringify([
        {
          external_id: id,
          name: `#${id}`,
          customer_external_id: customer,
          email,
          processed_at: "2026-11-18T15:00:00Z",
          currency: "USD",
          net_sales: 120,
          total: 130,
          lines: [],
        },
      ]),
    ],
  );
  await service("select public.upsert_shipping_orders($1, 'shopify', $2::jsonb)", [
    tenant,
    JSON.stringify([
      {
        external_id: id,
        recipient: "Sam Shopper",
        address1: "12 Mill Lane",
        city: "Hudson",
        region: "NY",
        postal_code: "12534",
        country_code: "us",
        phone: "555-0100",
        shipping_method: "Standard",
        shipping_paid: 12,
        weight_grams: 1361,
        note: "Leave with the neighbour",
        paid: true,
        ...extra,
        items: [
          { line_id: "l1", title: "Wool rug", variant: "Large", sku: "RUG-L", qty: 2, left: 2 },
          { line_id: "l2", title: "Yarn bundle", variant: null, sku: null, qty: 3, left: 3 },
        ],
      },
    ]),
  ]);
  return (
    await db.query<{ id: string }>(
      "select id from public.shipping_orders where tenant_id = $1 and external_id = $2",
      [tenant, id],
    )
  ).rows[0].id;
}
const orderRow = async (id: string) =>
  (
    await db.query<{
      units_left: number;
      items: { line_id: string; left: number }[];
      on_hold: boolean;
      recipient: string | null;
      address1: string | null;
      country_code: string | null;
      slip_printed_at: string | null;
    }>("select * from public.shipping_orders where id = $1", [id])
  ).rows[0];
const ship = (
  user: User,
  tenant: string,
  orderId: string | null,
  items: object[],
  extra: unknown[] = [false, false, null, null],
) =>
  as<{ n: number }>(
    user,
    "select public.record_shipment($1, $2, 'USPS', 'Ground Advantage', '9400 1000', 'https://tools.usps.com/go/TrackConfirmAction?tLabels=94001000', 8.4, $3::jsonb, '', $4, $5, $6, $7) as n",
    [tenant, orderId, JSON.stringify(items), ...extra],
  ).then((rows) => rows[0].n);

let orderA: string;
let orderB: string;

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
  orderA = await shopOrder(tenantA, "1001", "sam@example.com", "c1");
  orderB = await shopOrder(tenantB, "2001", "pat@example.com", "c9");
});

describe("cross-tenant isolation for shipping", () => {
  it("each workspace sees only its own orders and shipments, and can't write the tables", async () => {
    await ship(bob, tenantB, orderB, []);
    for (const table of ["shipping_orders", "shipments"]) {
      const mine = await as<{ tenant_id: string }>(alice, `select tenant_id from public.${table}`);
      expect(mine.every((row) => row.tenant_id === tenantA)).toBe(true);
      const theirs = await as<{ tenant_id: string }>(bob, `select tenant_id from public.${table}`);
      expect(theirs.length).toBeGreaterThan(0);
      expect(theirs.every((row) => row.tenant_id === tenantB)).toBe(true);
      await expect(as(alice, `update public.${table} set tenant_id = tenant_id`)).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it("nobody ships, holds or voids across workspaces, or calls the worker's functions", async () => {
    await expect(ship(alice, tenantA, orderB, [])).rejects.toThrow(/Order not found/);
    await expect(ship(bob, tenantA, orderA, [])).rejects.toThrow(/Workspace not found/);
    await expect(
      as(bob, "select public.set_shipping_hold($1, true, 'x')", [orderA]),
    ).rejects.toThrow(/Order not found/);
    const theirs = (
      await db.query<{ id: string }>("select id from public.shipments where tenant_id = $1", [
        tenantB,
      ])
    ).rows[0].id;
    await expect(as(alice, "select public.void_shipment($1)", [theirs])).rejects.toThrow(
      /Shipment not found/,
    );
    await expect(
      as(alice, "select public.upsert_shipping_orders($1, 'shopify', '[]'::jsonb)", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    await expect(as(alice, "select * from public.claim_shipments_to_send(5)")).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("sending orders out", () => {
  it("tidies what the shop sent and counts what's left", async () => {
    const row = await orderRow(orderA);
    expect(row.units_left).toBe(5);
    expect(row.country_code).toBe("US");
  });

  it("anyone on the team can hold an order and mark slips printed", async () => {
    await as(carol, "select public.set_shipping_hold($1, true, 'Waiting on yarn')", [orderA]);
    expect((await orderRow(orderA)).on_hold).toBe(true);
    await as(carol, "select public.mark_slips_printed($1, $2)", [tenantA, [orderA, orderB]]);
    expect((await orderRow(orderA)).slip_printed_at).not.toBeNull();
    expect((await orderRow(orderB)).slip_printed_at).toBeNull();
  });

  it("a part shipment leaves the rest waiting; a second one finishes it and lifts the hold", async () => {
    const first = await ship(
      carol,
      tenantA,
      orderA,
      [
        { line_id: "l1", qty: 1 },
        { line_id: "l2", qty: 99 },
      ],
      [true, true, null, null],
    );
    expect(first).toBe(1);
    let row = await orderRow(orderA);
    expect(row.items.map((i) => i.left)).toEqual([1, 0]);
    expect(row.units_left).toBe(1);
    expect(row.on_hold).toBe(false);

    const second = await ship(carol, tenantA, orderA, []);
    expect(second).toBe(2);
    row = await orderRow(orderA);
    expect(row.units_left).toBe(0);
    await expect(ship(carol, tenantA, orderA, [])).rejects.toThrow(/Nothing left/);

    const { rows } = await db.query<{
      items: { qty: number }[];
      destination: string;
      shop_status: string;
    }>(
      "select items, destination, shop_status from public.shipments where tenant_id = $1 order by number",
      [tenantA],
    );
    expect(rows[0].items.map((i) => i.qty)).toEqual([1, 3]);
    expect(rows[0].destination).toBe("Hudson, NY, US");
    expect(rows.map((r) => r.shop_status)).toEqual(["pending", "skipped"]);
  });

  it("the worker takes each waiting shipment once and records how it went", async () => {
    const claimed = await service<{
      id: string;
      order_external_id: string;
      notify_customer: boolean;
    }>("select * from public.claim_shipments_to_send(10)");
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ order_external_id: "1001", notify_customer: true });
    expect(await service("select * from public.claim_shipments_to_send(10)")).toEqual([]);
    await service("select public.finish_shipment_send($1, null)", [claimed[0].id]);
  });

  it("only an owner or admin can undo a shipment, and its items go back on the list", async () => {
    const last = (
      await db.query<{ id: string }>(
        "select id from public.shipments where tenant_id = $1 and number = 2",
        [tenantA],
      )
    ).rows[0].id;
    await expect(as(carol, "select public.void_shipment($1)", [last])).rejects.toThrow(
      /Only owners and admins/,
    );
    await as(alice, "select public.void_shipment($1)", [last]);
    const row = await orderRow(orderA);
    expect(row.items.map((i) => i.left)).toEqual([1, 0]);
    expect(row.units_left).toBe(1);
    await expect(as(alice, "select public.void_shipment($1)", [last])).rejects.toThrow(
      /Shipment not found/,
    );
  });

  it("a parcel with no order is just recorded", async () => {
    const n = await ship(carol, tenantA, null, [], [true, false, "Rae Lindqvist", "Portland, OR"]);
    const { rows } = await db.query<{ recipient: string; shop_status: string; items: unknown[] }>(
      "select recipient, shop_status, items from public.shipments where tenant_id = $1 and number = $2",
      [tenantA, n],
    );
    // Nothing in the shop to mark, so it is never queued.
    expect(rows[0]).toEqual({ recipient: "Rae Lindqvist", shop_status: "skipped", items: [] });
  });

  it("a later sync refreshes the address and keeps the workspace's own marks", async () => {
    await as(carol, "select public.set_shipping_hold($1, true, 'Check address')", [orderA]);
    await shopOrder(tenantA, "1001", "sam@example.com", "c1");
    const row = await orderRow(orderA);
    expect(row.on_hold).toBe(true);
    expect(row.slip_printed_at).not.toBeNull();
    // The shop is the authority on what's left once it has been told.
    expect(row.units_left).toBe(5);
  });
});

describe("the fuller queue: what the shopper chose, holds with a date, pickup, the report", () => {
  type More = {
    shipping_paid: string | null;
    weight_grams: number | null;
    pickup: boolean;
    on_hold: boolean;
    hold_reason: string;
    hold_until: string | null;
    pickup_ready_at: string | null;
    picked_up_at: string | null;
  };
  const more = async (id: string) =>
    (
      await db.query<More>(
        "select shipping_paid::text, weight_grams::int, pickup, on_hold, hold_reason, hold_until::text, pickup_ready_at::text, picked_up_at::text from public.shipping_orders where id = $1",
        [id],
      )
    ).rows[0];
  const day = async (offset: number) =>
    (
      await db.query<{ d: string }>(
        "select ((now() at time zone 'America/New_York')::date + $1::int)::text as d",
        [offset],
      )
    ).rows[0].d;
  let held: string;
  let collect: string;
  let theirs: string;

  beforeAll(async () => {
    held = await shopOrder(tenantA, "1002", "kit@example.com", "c2");
    collect = await shopOrder(tenantA, "1003", "lee@example.com", "c3", {
      pickup: true,
      shipping_method: "Studio pickup",
      shipping_paid: 0,
    });
    theirs = await shopOrder(tenantB, "2002", "moe@example.com", "c8", { pickup: true });
  });

  it("stores what the shopper chose and paid, the weight, and whether it's a pickup", async () => {
    expect(await more(held)).toMatchObject({
      shipping_paid: "12.00",
      weight_grams: 1361,
      pickup: false,
    });
    expect(await more(collect)).toMatchObject({ shipping_paid: "0.00", pickup: true });
    // A sync that doesn't know these (an older worker) leaves them empty rather than failing.
    await service("select public.upsert_shipping_orders($1, 'shopify', $2::jsonb)", [
      tenantA,
      JSON.stringify([{ external_id: "1002", recipient: "Kit", paid: true, items: [] }]),
    ]);
    expect(await more(held)).toMatchObject({
      shipping_paid: null,
      weight_grams: null,
      pickup: false,
    });
    await shopOrder(tenantA, "1002", "kit@example.com", "c2");
  });

  it("anyone on the team holds several orders at once, with a note and a day to come back", async () => {
    const until = await day(3);
    const n = await as<{ n: number }>(
      carol,
      "select public.hold_shipping_orders($1, $2, $3, $4::date) as n",
      [tenantA, [held, collect, theirs], `  ${"x".repeat(400)}  `, until],
    );
    // Only this workspace's orders are touched.
    expect(n[0].n).toBe(2);
    const row = await more(held);
    expect(row).toMatchObject({ on_hold: true, hold_until: until });
    expect(row.hold_reason).toHaveLength(300);
    expect((await more(theirs)).on_hold).toBe(false);
    await expect(
      as(carol, "select public.hold_shipping_orders($1, $2, '', $3::date)", [
        tenantA,
        [held],
        await day(0),
      ]),
    ).rejects.toThrow(/Pick a day after today/);
  });

  it("a hold still running isn't cleared by opening the order; one whose day has come is", async () => {
    const opened = () =>
      as<{ ok: boolean }>(carol, "select public.clear_ended_shipping_hold($1) as ok", [held]);
    expect((await opened())[0].ok).toBe(false);
    expect((await more(held)).on_hold).toBe(true);
    await db.query("update public.shipping_orders set hold_until = $2::date where id = $1", [
      held,
      await day(0),
    ]);
    expect((await opened())[0].ok).toBe(true);
    expect(await more(held)).toMatchObject({ on_hold: false, hold_until: null, hold_reason: "" });
  });

  it("releases in bulk, and a sync keeps a hold and its date", async () => {
    const until = await day(5);
    await as(carol, "select public.hold_shipping_orders($1, $2, 'Waiting on yarn', $3::date)", [
      tenantA,
      [held],
      until,
    ]);
    await shopOrder(tenantA, "1002", "kit@example.com", "c2");
    expect(await more(held)).toMatchObject({ on_hold: true, hold_until: until });
    const n = await as<{ n: number }>(carol, "select public.release_shipping_orders($1, $2) as n", [
      tenantA,
      [held, collect, theirs],
    ]);
    expect(n[0].n).toBe(2);
    expect(await more(held)).toMatchObject({ on_hold: false, hold_until: null, hold_reason: "" });
  });

  it("a pickup is marked ready, then collected; only a manager steps it back", async () => {
    const ready = await as<{ n: number }>(carol, "select public.mark_pickup_ready($1, $2) as n", [
      tenantA,
      [held, collect, theirs],
    ]);
    // Not the order being posted, and not another workspace's pickup.
    expect(ready[0].n).toBe(1);
    expect((await more(collect)).pickup_ready_at).not.toBeNull();
    expect((await more(theirs)).pickup_ready_at).toBeNull();
    await expect(as(carol, "select public.mark_picked_up($1)", [held])).rejects.toThrow(
      /not for pickup/,
    );
    await as(carol, "select public.mark_picked_up($1)", [collect]);
    expect((await more(collect)).picked_up_at).not.toBeNull();
    // A sync leaves the pickup steps alone.
    await shopOrder(tenantA, "1003", "lee@example.com", "c3", { pickup: true });
    expect((await more(collect)).picked_up_at).not.toBeNull();
    // Collected orders can't be put on hold.
    const n = await as<{ n: number }>(
      carol,
      "select public.hold_shipping_orders($1, $2, '', null) as n",
      [tenantA, [collect]],
    );
    expect(n[0].n).toBe(0);

    await expect(as(carol, "select public.undo_pickup($1)", [collect])).rejects.toThrow(
      /Only owners and admins/,
    );
    await as(alice, "select public.undo_pickup($1)", [collect]);
    let row = await more(collect);
    expect(row.picked_up_at).toBeNull();
    expect(row.pickup_ready_at).not.toBeNull();
    await as(alice, "select public.undo_pickup($1)", [collect]);
    row = await more(collect);
    expect(row.pickup_ready_at).toBeNull();
  });

  it("nobody holds, releases, collects or reads the report across workspaces", async () => {
    await expect(
      as(bob, "select public.hold_shipping_orders($1, $2, '', null)", [tenantA, [held]]),
    ).rejects.toThrow(/Workspace not found/);
    await expect(
      as(bob, "select public.release_shipping_orders($1, $2)", [tenantA, [held]]),
    ).rejects.toThrow(/Workspace not found/);
    await expect(
      as(bob, "select public.mark_pickup_ready($1, $2)", [tenantA, [collect]]),
    ).rejects.toThrow(/Workspace not found/);
    for (const fn of ["mark_picked_up", "undo_pickup", "clear_ended_shipping_hold"]) {
      await expect(as(bob, `select public.${fn}($1)`, [collect])).rejects.toThrow(
        /Order not found/,
      );
    }
    await expect(as(bob, "select public.shipping_report($1, 30)", [tenantA])).rejects.toThrow(
      /Workspace not found/,
    );
    // Naming your own workspace doesn't reach someone else's orders either.
    const n = await as<{ n: number }>(
      bob,
      "select public.hold_shipping_orders($1, $2, '', null) as n",
      [tenantB, [held]],
    );
    expect(n[0].n).toBe(0);
    expect((await more(held)).on_hold).toBe(false);
  });

  it("the report sets postage against what shoppers paid, counting each order once", async () => {
    type Report = {
      parcels: number;
      priced: number;
      orders: number;
      postage: number;
      collected: number;
      margin: number;
      avg_days: number | null;
      destinations: { country: string; region: string | null; parcels: number }[];
    };
    const report = async (user: User, tenant: string) =>
      (await as<{ r: Report }>(user, "select public.shipping_report($1, 30) as r", [tenant]))[0].r;
    // So far in A: parcel 1 for order 1001 (8.40), parcel 2 undone, parcel 3 not on an order (8.40).
    const before = await report(carol, tenantA);
    expect(before).toMatchObject({
      parcels: 2,
      priced: 2,
      orders: 1,
      postage: 16.8,
      collected: 12,
      margin: -4.8,
      destinations: [{ country: "US", region: "NY", parcels: 1 }],
    });
    // Two boxes for one order: both postages count, the shopper's shipping once.
    await ship(carol, tenantA, held, [{ line_id: "l1", qty: 2 }]);
    await ship(carol, tenantA, held, []);
    const after = await report(carol, tenantA);
    expect(after).toMatchObject({
      parcels: 4,
      orders: 2,
      postage: 33.6,
      collected: 24,
      margin: -9.6,
      destinations: [{ country: "US", region: "NY", parcels: 3 }],
    });
    // The other workspace's report is its own.
    expect(await report(bob, tenantB)).toMatchObject({ parcels: 1, orders: 1, postage: 8.4 });
  });

  it("forgetting a shopper takes the hold note with their address", async () => {
    await as(carol, "select public.hold_shipping_orders($1, $2, 'Lee asked us to wait', null)", [
      tenantA,
      [collect],
    ]);
    expect((await more(collect)).hold_reason).toBe("Lee asked us to wait");
    await service("select public.redact_customer($1, 'shopify', 'c3', 'lee@example.com')", [
      tenantA,
    ]);
    expect((await more(collect)).hold_reason).toBe("");
  });
});

describe("buying labels: boxes, quotes and the purchase", () => {
  let labelA: string;
  let labelB: string;
  const RATES = [
    {
      id: "rate_ground",
      carrier: "USPS",
      service: "GroundAdvantage",
      name: "USPS Ground Advantage",
      price: "6.40",
      currency: "USD",
      days: 4,
    },
    {
      id: "rate_priority",
      carrier: "USPS",
      service: "Priority",
      name: "USPS Priority Mail",
      price: "9.85",
      currency: "USD",
      days: 2,
    },
  ];
  const quote = (
    tenant: string,
    order: string,
    by: User,
    shipment: string,
    rates: object[] = RATES,
  ) =>
    service<{ id: string }>("select public.save_label_quote($1, $2, $3, $4, $5::jsonb) as id", [
      tenant,
      order,
      by.id,
      shipment,
      JSON.stringify(rates),
    ]).then((rows) => rows[0].id);
  const claim = (user: User, order: string, rate: string) =>
    as<{ c: { quote_id: string; provider_shipment_id: string; rate: { price: string } } }>(
      user,
      "select public.claim_label_purchase($1, $2) as c",
      [order, rate],
    ).then((rows) => rows[0].c);
  const bought = (tenant: string, quoteId: string, tracking = "9400100000000000000001") =>
    service<{ ok: boolean }>(
      "select public.mark_label_bought($1, $2, 'USPS', 'Ground Advantage', $3, 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' || $3, 'https://labels.example/label.png', 'test', 6.40) as ok",
      [tenant, quoteId, tracking],
    ).then((rows) => rows[0].ok);
  const quoteRow = async (id: string) =>
    (
      await db.query<{
        status: string;
        shipment_id: string | null;
        tracking_number: string | null;
        price: string | null;
      }>(
        "select status, shipment_id, tracking_number, price from public.shipping_label_quotes where id = $1",
        [id],
      )
    ).rows[0];
  const boxes = (user: User) =>
    as<{ id: string; name: string; is_default: boolean; tenant_id: string }>(
      user,
      "select id, name, is_default, tenant_id from public.shipping_boxes where archived_at is null order by created_at, name",
    );
  const saveBox = (
    user: User,
    tenant: string,
    id: string | null,
    name: string,
    isDefault = false,
    length = 12,
  ) =>
    as<{ id: string }>(
      user,
      "select public.save_shipping_box($1, $2, $3, 'box', $4, 9, 4, 6.5, $5) as id",
      [tenant, id, name, length, isDefault],
    ).then((rows) => rows[0].id);

  beforeAll(async () => {
    labelA = await shopOrder(tenantA, "5001", "lee@example.com", "c50");
    labelB = await shopOrder(tenantB, "6001", "ash@example.com", "c60");
  });

  it("EasyPost can be saved as a connection, and an unknown provider still can't", async () => {
    const rows = await service<{ id: string }>(
      "select public.save_connection($1, 'easypost', 'easypost-a', 'EasyPost (test key)', '{}', $2::jsonb, $3, $4::jsonb) as id",
      [
        tenantA,
        JSON.stringify({ access_token: "test-key-not-real" }),
        alice.id,
        JSON.stringify({ mode: "test" }),
      ],
    );
    expect(rows[0].id).toBeTruthy();
    // The key is in Vault, not on the row a member can read.
    const seen = await as<Record<string, unknown>>(
      carol,
      "select provider, status, metadata from public.connections where provider = 'easypost'",
    );
    expect(seen).toEqual([{ provider: "easypost", status: "active", metadata: { mode: "test" } }]);
    expect(JSON.stringify(seen).includes("test-key-not-real")).toBe(false);
    expect(await as(bob, "select id from public.connections where provider = 'easypost'")).toEqual(
      [],
    );
    const token = await service<{ token: { access_token: string } }>(
      "select token from public.get_provider_token($1, 'easypost')",
      [tenantA],
    );
    expect(token[0].token.access_token).toBe("test-key-not-real");
    await expect(
      as(alice, "select * from public.get_provider_token($1, 'easypost')", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      service("select public.save_connection($1, 'fedex', 'x', 'x', '{}', '{}'::jsonb, $2)", [
        tenantA,
        alice.id,
      ]),
    ).rejects.toThrow(/connections_provider_check/);
  });

  it("only owners and admins keep the box list; the first box is the usual one", async () => {
    await expect(saveBox(carol, tenantA, null, "Small")).rejects.toThrow(/Only owners and admins/);
    const small = await saveBox(alice, tenantA, null, "Small");
    const big = await saveBox(alice, tenantA, null, "Big", false, 24);
    expect((await boxes(carol)).map((b) => [b.name, b.is_default])).toEqual([
      ["Small", true],
      ["Big", false],
    ]);
    // Making another the usual one takes it from the first: never two, never none.
    await saveBox(alice, tenantA, big, "Big", true, 24);
    expect((await boxes(alice)).map((b) => [b.name, b.is_default])).toEqual([
      ["Small", false],
      ["Big", true],
    ]);
    // Editing the usual box without saying "usual" leaves it the usual one.
    await saveBox(alice, tenantA, big, "Big rug box", false, 26);
    expect((await boxes(alice)).filter((b) => b.is_default).map((b) => b.name)).toEqual([
      "Big rug box",
    ]);
    // Removing the usual box hands that to the oldest one left.
    await expect(as(carol, "select public.archive_shipping_box($1)", [big])).rejects.toThrow(
      /Only owners and admins/,
    );
    await as(alice, "select public.archive_shipping_box($1)", [big]);
    expect((await boxes(alice)).map((b) => [b.name, b.is_default])).toEqual([["Small", true]]);
    await expect(as(alice, "select public.archive_shipping_box($1)", [big])).rejects.toThrow(
      /Box not found/,
    );
    expect(small).toBeTruthy();
  });

  it("box sizes are kept within what a carrier takes", async () => {
    for (const length of [0, -1, 109]) {
      await expect(saveBox(alice, tenantA, null, "Odd", false, length)).rejects.toThrow(/check/);
    }
    await expect(saveBox(alice, tenantA, null, "   ")).rejects.toThrow(/check/);
    await expect(
      as(alice, "select public.save_shipping_box($1, null, 'Crate', 'crate', 12, 9, 4, 0, false)", [
        tenantA,
      ]),
    ).rejects.toThrow(/check/);
  });

  it("boxes stay inside their workspace", async () => {
    const theirs = await saveBox(bob, tenantB, null, "Bob's box");
    const mine = await boxes(alice);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((b) => b.tenant_id === tenantA)).toBe(true);
    expect((await boxes(bob)).map((b) => b.name)).toEqual(["Bob's box"]);
    await expect(saveBox(alice, tenantB, null, "Sneaky")).rejects.toThrow(/Only owners and admins/);
    await expect(saveBox(alice, tenantA, theirs, "Sneaky")).rejects.toThrow(/Box not found/);
    await expect(as(alice, "select public.archive_shipping_box($1)", [theirs])).rejects.toThrow(
      /Box not found/,
    );
    await expect(
      as(
        alice,
        "insert into public.shipping_boxes (tenant_id, name, length_in, width_in, height_in) values ($1, 'x', 1, 1, 1)",
        [tenantA],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(as(alice, "update public.shipping_boxes set name = 'x'")).rejects.toThrow(
      /permission denied/,
    );
    // Bob's default is untouched by anything Alice did.
    expect((await boxes(bob))[0].is_default).toBe(true);
  });

  it("only the server writes quotes; members read their own workspace's and nobody else's", async () => {
    const mine = await quote(tenantA, labelA, carol, "shp_a1");
    await quote(tenantB, labelB, bob, "shp_b1");
    const seen = await as<{ id: string; tenant_id: string }>(
      carol,
      "select id, tenant_id from public.shipping_label_quotes",
    );
    expect(seen).toEqual([{ id: mine, tenant_id: tenantA }]);
    const theirs = await as<{ tenant_id: string }>(
      bob,
      "select tenant_id from public.shipping_label_quotes",
    );
    expect(theirs).toEqual([{ tenant_id: tenantB }]);

    for (const call of [
      [
        "select public.save_label_quote($1, $2, $3, 'shp_forged', '[]'::jsonb)",
        [tenantA, labelA, alice.id],
      ],
      [
        "select public.mark_label_bought($1, $2, 'USPS', '', 't', null, null, 'live', 1)",
        [tenantA, mine],
      ],
      ["select public.release_label_purchase($1, $2)", [tenantA, mine]],
      [
        "insert into public.shipping_label_quotes (tenant_id, shipping_order_id, provider_shipment_id) values ($1, $2, 'shp_forged')",
        [tenantA, labelA],
      ],
      ["update public.shipping_label_quotes set status = 'bought' where tenant_id = $1", [tenantA]],
    ] as [string, unknown[]][]) {
      await expect(as(alice, call[0], call[1]), call[0]).rejects.toThrow(/permission denied/);
    }
    // Even the server can't file a quote against another workspace's order, or for a stranger.
    await expect(quote(tenantA, labelB, alice, "shp_x")).rejects.toThrow(/Order not found/);
    await expect(quote(tenantA, labelA, bob, "shp_x")).rejects.toThrow(/Workspace not found/);
    // A quote holds prices and EasyPost's ids. No name, no street.
    const { rows } = await db.query("select * from public.shipping_label_quotes where id = $1", [
      mine,
    ]);
    expect(JSON.stringify(rows[0])).not.toMatch(/Sam Shopper|Mill Lane|12534|555-0100/);
  });

  it("asking for rates again replaces the open quote instead of piling them up", async () => {
    const again = await quote(tenantA, labelA, carol, "shp_a2");
    const { rows } = await db.query<{ id: string; provider_shipment_id: string }>(
      "select id, provider_shipment_id from public.shipping_label_quotes where shipping_order_id = $1",
      [labelA],
    );
    expect(rows).toEqual([{ id: again, provider_shipment_id: "shp_a2" }]);
  });

  it("can't buy a rate that wasn't quoted for this order", async () => {
    const other = await shopOrder(tenantA, "5002", "kit@example.com", "c51");
    await quote(tenantA, other, carol, "shp_other", [{ ...RATES[0], id: "rate_other_order" }]);
    // A rate id made up in the browser, and one that belongs to a different order.
    await expect(claim(carol, labelA, "rate_made_up")).rejects.toThrow(/not quoted for this order/);
    await expect(claim(carol, labelA, "rate_other_order")).rejects.toThrow(
      /not quoted for this order/,
    );
    // Another workspace's order, even with its own real rate id.
    await expect(claim(alice, labelB, "rate_ground")).rejects.toThrow(/Order not found/);
    await expect(claim(bob, labelA, "rate_ground")).rejects.toThrow(/Order not found/);
    const { rows } = await db.query(
      "select 1 from public.shipping_label_quotes where status <> 'quoted'",
    );
    expect(rows).toHaveLength(0);
  });

  it("rates run out after twenty minutes", async () => {
    await db.query(
      "update public.shipping_label_quotes set created_at = now() - interval '21 minutes' where shipping_order_id = $1",
      [labelA],
    );
    await expect(claim(carol, labelA, "rate_ground")).rejects.toThrow(/not quoted for this order/);
    await db.query(
      "update public.shipping_label_quotes set created_at = now() where shipping_order_id = $1",
      [labelA],
    );
  });

  it("a second press is refused while the first is being bought; a refusal by EasyPost frees it", async () => {
    const first = await claim(carol, labelA, "rate_ground");
    expect(first.provider_shipment_id).toBe("shp_a2");
    expect(first.rate.price).toBe("6.40");
    // The same press again, and a team-mate with fresh rates of their own.
    await expect(claim(carol, labelA, "rate_ground")).rejects.toThrow(/still being finished/);
    await quote(tenantA, labelA, alice, "shp_a3");
    await expect(claim(alice, labelA, "rate_priority")).rejects.toThrow(/still being finished/);

    // EasyPost said no: nothing was charged, so buying is possible again.
    expect(
      (
        await service<{ ok: boolean }>("select public.release_label_purchase($1, $2) as ok", [
          tenantA,
          first.quote_id,
        ])
      )[0].ok,
    ).toBe(true);
    expect((await quoteRow(first.quote_id)).status).toBe("released");
    // A released quote can't be marked as bought afterwards, nor released twice.
    expect(await bought(tenantA, first.quote_id)).toBe(false);
    expect(
      (
        await service<{ ok: boolean }>("select public.release_label_purchase($1, $2) as ok", [
          tenantA,
          first.quote_id,
        ])
      )[0].ok,
    ).toBe(false);
  });

  it("a bought label is kept before the parcel exists, then recorded through record_shipment", async () => {
    const mine = await claim(alice, labelA, "rate_priority");
    expect(mine.provider_shipment_id).toBe("shp_a3");
    // Another workspace's server call can't touch it.
    expect(await bought(tenantB, mine.quote_id)).toBe(false);
    expect(await bought(tenantA, mine.quote_id)).toBe(true);
    const kept = await quoteRow(mine.quote_id);
    expect(kept).toMatchObject({
      status: "bought",
      shipment_id: null,
      tracking_number: "9400100000000000000001",
      price: "6.40",
    });
    // Paid for but not yet a parcel: buying again is refused, whoever asks.
    await quote(tenantA, labelA, carol, "shp_a4");
    await expect(claim(carol, labelA, "rate_ground")).rejects.toThrow(/still being finished/);

    await expect(
      as(bob, "select public.record_label_shipment($1, false, false)", [mine.quote_id]),
    ).rejects.toThrow(/Label not found/);
    const n = (
      await as<{ n: number }>(carol, "select public.record_label_shipment($1, true, true) as n", [
        mine.quote_id,
      ])
    )[0].n;
    const { rows } = await db.query<Record<string, unknown>>(
      "select id, carrier, service, tracking_number, tracking_url, cost, items, shop_status, notify_customer, label_provider, label_shipment_id, label_url, label_mode, recipient from public.shipments where tenant_id = $1 and number = $2",
      [tenantA, n],
    );
    expect(rows[0]).toMatchObject({
      carrier: "USPS",
      service: "Ground Advantage",
      tracking_number: "9400100000000000000001",
      cost: "6.40",
      shop_status: "pending",
      notify_customer: true,
      label_provider: "easypost",
      label_shipment_id: "shp_a3",
      label_url: "https://labels.example/label.png",
      label_mode: "test",
      recipient: "Sam Shopper",
    });
    expect(
      (rows[0].items as { line_id: string; qty: number }[]).map((i) => [i.line_id, i.qty]),
    ).toEqual([
      ["l1", 2],
      ["l2", 3],
    ]);
    expect((await orderRow(labelA)).units_left).toBe(0);
    expect(await quoteRow(mine.quote_id)).toMatchObject({
      status: "recorded",
      shipment_id: rows[0].id,
    });
    // Recording it twice isn't possible.
    await expect(
      as(carol, "select public.record_label_shipment($1, false, false)", [mine.quote_id]),
    ).rejects.toThrow(/Label not found/);
    await expect(claim(carol, labelA, "rate_ground")).rejects.toThrow(/Nothing left to send/);
  });

  it("refuses another label for the same order inside thirty seconds", async () => {
    // The shop syncs and says there is still something to send.
    await shopOrder(tenantA, "5001", "lee@example.com", "c50");
    expect((await orderRow(labelA)).units_left).toBe(5);
    await expect(claim(carol, labelA, "rate_ground")).rejects.toThrow(/bought moments ago/);
    await db.query(
      "update public.shipments set shipped_at = now() - interval '31 seconds' where label_shipment_id = 'shp_a3'",
    );
    const later = await claim(carol, labelA, "rate_ground");
    expect(later.provider_shipment_id).toBe("shp_a4");
    await service("select public.release_label_purchase($1, $2)", [tenantA, later.quote_id]);
  });

  it("voiding a label is for owners and admins; it marks the refund and puts the items back", async () => {
    await db.query(
      "update public.shipping_orders set items = jsonb_build_array(jsonb_build_object('line_id', 'l1', 'title', 'Wool rug', 'variant', 'Large', 'qty', 2, 'left', 0)), units_left = 0 where id = $1",
      [labelA],
    );
    const parcel = (
      await db.query<{ id: string }>(
        "select id from public.shipments where label_shipment_id = 'shp_a3'",
      )
    ).rows[0].id;
    await expect(as(carol, "select public.void_label_shipment($1)", [parcel])).rejects.toThrow(
      /Only owners and admins/,
    );
    await expect(as(bob, "select public.void_label_shipment($1)", [parcel])).rejects.toThrow(
      /Shipment not found/,
    );
    const untouched = await db.query<{
      voided_at: string | null;
      label_refund_status: string | null;
    }>("select voided_at, label_refund_status from public.shipments where id = $1", [parcel]);
    expect(untouched.rows[0]).toEqual({ voided_at: null, label_refund_status: null });

    await as(alice, "select public.void_label_shipment($1)", [parcel]);
    const { rows } = await db.query<{
      voided_at: string | null;
      label_refund_status: string;
      label_refund_at: string | null;
    }>(
      "select voided_at, label_refund_status, label_refund_at from public.shipments where id = $1",
      [parcel],
    );
    expect(rows[0].voided_at).not.toBeNull();
    expect(rows[0].label_refund_status).toBe("requested");
    expect(rows[0].label_refund_at).not.toBeNull();
    expect((await orderRow(labelA)).units_left).toBe(2);
    await expect(as(alice, "select public.void_label_shipment($1)", [parcel])).rejects.toThrow(
      /Shipment not found/,
    );
  });

  it("a label bought after the order was marked as sent is still kept, without a name or address", async () => {
    const late = await shopOrder(tenantA, "5003", "jo@example.com", "c52");
    await quote(tenantA, late, carol, "shp_late");
    const mine = await claim(carol, late, "rate_ground");
    // Someone records the parcel by hand while EasyPost is being asked.
    await ship(alice, tenantA, late, []);
    expect(await bought(tenantA, mine.quote_id, "9400100000000000000009")).toBe(true);
    const n = (
      await as<{ n: number }>(carol, "select public.record_label_shipment($1, true, true) as n", [
        mine.quote_id,
      ])
    )[0].n;
    const { rows } = await db.query<Record<string, unknown>>(
      "select shipping_order_id, order_name, recipient, destination, note, shop_status, label_shipment_id, tracking_number from public.shipments where tenant_id = $1 and number = $2",
      [tenantA, n],
    );
    expect(rows[0]).toMatchObject({
      shipping_order_id: null,
      order_name: "#5003",
      recipient: null,
      destination: null,
      shop_status: "skipped",
      label_shipment_id: "shp_late",
      tracking_number: "9400100000000000000009",
    });
    expect(String(rows[0].note)).toMatch(/already marked as sent/);
    expect((await quoteRow(mine.quote_id)).status).toBe("recorded");
  });

  it("one label can never become two parcels, and a cancelled order can't have one bought", async () => {
    await expect(
      db.query(
        "update public.shipments set label_provider = 'easypost', label_shipment_id = 'shp_late' where tenant_id = $1 and number = 1",
        [tenantA],
      ),
    ).rejects.toThrow(/shipments_one_parcel_per_label/);
    await expect(
      db.query(
        "update public.shipments set label_url = 'http://plain.example/label.png' where label_shipment_id = 'shp_late'",
      ),
    ).rejects.toThrow(/check/);
    const gone = await shopOrder(tenantA, "5004", "max@example.com", "c53");
    await quote(tenantA, gone, carol, "shp_gone");
    await db.query("update public.shipping_orders set cancelled = true where id = $1", [gone]);
    await expect(claim(carol, gone, "rate_ground")).rejects.toThrow(/cancelled/);
  });
});

describe("privacy", () => {
  it("forgetting a shopper blanks their address on orders and shipments, in that workspace only", async () => {
    await service("select public.redact_customer($1, 'shopify', 'c1', 'sam@example.com')", [
      tenantA,
    ]);
    const row = await orderRow(orderA);
    expect(row.recipient).toBeNull();
    expect(row.address1).toBeNull();
    const { rows } = await db.query<{ recipient: string | null; destination: string | null }>(
      "select recipient, destination from public.shipments where shipping_order_id = $1",
      [orderA],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.recipient === null && r.destination === null)).toBe(true);
    expect((await orderRow(orderB)).recipient).toBe("Sam Shopper");
  });

  it("disconnecting the shop removes what was held for packing", async () => {
    await service("select public.purge_provider_data($1, 'shopify')", [tenantB]);
    const { rows } = await db.query("select id from public.shipping_orders where tenant_id = $1", [
      tenantB,
    ]);
    expect(rows).toHaveLength(0);
    // The record that a parcel went out stays, without its order.
    const kept = await db.query(
      "select shipping_order_id, recipient, destination from public.shipments where tenant_id = $1",
      [tenantB],
    );
    expect(kept.rows).toEqual([{ shipping_order_id: null, recipient: null, destination: null }]);
  });
});
