import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { addressKey, groupKey } from "../../src/lib/shipping/merge";
import { asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of tenant A
let bob: User; // owner of tenant B
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

/** An order for Sam at 12 Mill Lane, placed `day` of November. */
async function shopOrder(tenant: string, id: string, day: number, extra: object = {}) {
  await service(
    "select public.upsert_commerce_batch($1, 'shopify', $2::jsonb, '[]'::jsonb, $3::jsonb)",
    [
      tenant,
      JSON.stringify([
        { external_id: "c1", email: "sam@example.com", first_name: "Sam", last_name: "Shopper" },
      ]),
      JSON.stringify([
        {
          external_id: id,
          name: `#${id}`,
          customer_external_id: "c1",
          email: "sam@example.com",
          processed_at: `2026-11-${String(day).padStart(2, "0")}T15:00:00Z`,
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
        shipping_method: "Standard",
        shipping_paid: 12,
        weight_grams: 1361,
        paid: true,
        items: [
          { line_id: "l1", title: "Wool rug", variant: "Large", sku: "RUG-L", qty: 2, left: 2 },
          { line_id: "l2", title: "Yarn bundle", variant: null, sku: null, qty: 3, left: 3 },
        ],
        ...extra,
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
const left = async (id: string) =>
  (
    await db.query<{ units_left: number }>(
      "select units_left from public.shipping_orders where id = $1",
      [id],
    )
  ).rows[0].units_left;

const RATES = [
  { id: "rate_ground", carrier: "USPS", service: "GroundAdvantage", price: "6.40" },
  { id: "rate_priority", carrier: "USPS", service: "Priority", price: "9.85" },
];
let made = 0;
const quoteGroup = (tenant: string, primary: string, riders: string[], by: User) =>
  service<{ id: string }>(
    "select public.save_group_label_quote($1, $2, $3, $4, $5::jsonb, 'shipment', 1, $6::uuid[]) as id",
    [tenant, primary, by.id, `shp_group_${++made}`, JSON.stringify(RATES), riders],
  ).then((rows) => rows[0].id);
const quoteOne = (tenant: string, order: string, by: User) =>
  service<{ id: string }>("select public.save_label_quote($1, $2, $3, $4, $5::jsonb) as id", [
    tenant,
    order,
    by.id,
    `shp_one_${++made}`,
    JSON.stringify(RATES),
  ]).then((rows) => rows[0].id);
const claimGroup = (user: User, primary: string, riders: string[], rate = "rate_ground") =>
  as<{ c: { quote_id: string; riders: string[] } }>(
    user,
    "select public.claim_group_label_purchase($1, $2::uuid[], $3) as c",
    [primary, riders, rate],
  ).then((rows) => rows[0].c);
const claimOne = (user: User, order: string, rate = "rate_ground") =>
  as<{ c: { quote_id: string } }>(user, "select public.claim_label_purchase($1, $2) as c", [
    order,
    rate,
  ]).then((rows) => rows[0].c);
const bought = (tenant: string, quoteId: string, parcels: object[] | null = null) =>
  service<{ ok: boolean }>(
    "select public.mark_label_bought($1, $2, 'USPS', 'Ground Advantage', '9400100000000000000021', 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400100000000000000021', 'https://labels.example/one.png', 'test', 14.20, $3::jsonb) as ok",
    [tenant, quoteId, parcels ? JSON.stringify(parcels) : null],
  ).then((rows) => rows[0].ok);
const record = (user: User, quoteId: string, push = true) =>
  as<{ n: number }>(user, "select public.record_label_shipment($1, $2, $2) as n", [
    quoteId,
    push,
  ]).then((rows) => rows[0].n);
const setGroup = (user: User, tenant: string, ids: string[], action: string) =>
  as(user, "select public.set_shipping_group($1, $2::uuid[], $3)", [tenant, ids, action]);
type Parcel = {
  id: string;
  number: number;
  shipping_order_id: string | null;
  order_name: string | null;
  cost: string | null;
  tracking_number: string;
  merged_with: string | null;
  label_provider: string | null;
  shop_status: string;
  voided_at: string | null;
  note: string;
};
const parcelsOf = async (orderIds: string[]) =>
  (
    await db.query<Parcel>(
      "select * from public.shipments where shipping_order_id = any($1::uuid[]) order by number",
      [orderIds],
    )
  ).rows;
const release = (tenant: string, quoteId: string) =>
  service("select public.release_label_purchase($1, $2)", [tenant, quoteId]);

let otherB: string;

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
  otherB = await shopOrder(tenantB, "9001", 1);
});

describe("the same address, in the database and in the app", () => {
  it("gives the very same key for every spelling", async () => {
    const cases = [
      ["Jane Doe", "12 Oak Street", "Apt 3", "19107-1234", "US"],
      ["jane doe", "12 Oak St.", "#3", "19107", "US"],
      ["JANE DOE", "12 OAK STREET", "APT 3", "19107", "us"],
      ["Jane Doe", "12 Oak St Apt 3", null, "19107", "US"],
      ["Jane Doe", "12 Oak St, #3", "", "19107", "US"],
      ["Jane Doe", "12 Oak Street", "Apt 4", "19107", "US"],
      ["John Doe", "12 Oak Street", "Apt 3", "19107", "US"],
      ["Jane Doe", "12 North Oak Street", null, "19107", "US"],
      ["Jane Doe", "12 N. Oak St", null, "19107", "US"],
      ["José Núñez-O’Brien", "9 Boulevard Way / Suite 2", "Floor 3", " 12534 ", null],
      ["Zoë Ångström", "1 Parkway Terrace", "Unit 7, No 2", "SW1A 1AA", "GB"],
      ["Zoe Angstrom", "1 Pkwy Ter", "7 2", "sw1a1aa", "gb"],
      ["Mette Sørensen", "Vesterbrogade 1 East", null, "1620", "DK"],
      ["Wayne Northway", "5 Streetcar Highway South", "apartment 2", "90210-1", "US"],
      [null, "5 Court Place Circle Square Trail", null, null, "US"],
      ["No Address", null, "Apt 3", "19107", "US"],
      ["Blank Address", "   ", null, "19107", "US"],
    ] as const;
    const keys: (string | null)[] = [];
    for (const [recipient, address1, address2, postal_code, country_code] of cases) {
      const { rows } = await db.query<{ key: string | null }>(
        "select private.shipping_address_key($1, $2, $3, $4, $5) as key",
        [recipient, address1, address2, postal_code, country_code],
      );
      expect(rows[0].key).toBe(
        addressKey({ recipient, address1, address2, postal_code, country_code }),
      );
      keys.push(rows[0].key);
    }
    // The first five are one place; the sixth and seventh are not.
    expect(new Set(keys.slice(0, 5)).size).toBe(1);
    expect(keys[5]).not.toBe(keys[0]);
    expect(keys[6]).not.toBe(keys[0]);
    expect(keys[7]).toBe(keys[8]);
    expect(keys[10]).toBe(keys[11]);
    expect(keys[15]).toBeNull();
    expect(keys[16]).toBeNull();
  });
});

describe("cross-tenant isolation for ship together", () => {
  let a1: string;
  let a2: string;
  let b2: string;

  it("each workspace sees only its own groups and can't write the table", async () => {
    a1 = await shopOrder(tenantA, "1001", 1);
    a2 = await shopOrder(tenantA, "1002", 2);
    b2 = await shopOrder(tenantB, "9002", 2);
    await setGroup(carol, tenantA, [a1, a2], "save");
    await setGroup(bob, tenantB, [otherB, b2], "save");

    const mine = await as<{ tenant_id: string }>(alice, "select * from public.shipping_groups");
    expect(mine).toHaveLength(1);
    expect(mine[0].tenant_id).toBe(tenantA);
    const theirs = await as<{ tenant_id: string }>(bob, "select * from public.shipping_groups");
    expect(theirs).toHaveLength(1);
    expect(theirs[0].tenant_id).toBe(tenantB);

    await expect(
      as(alice, "update public.shipping_groups set dismissed_at = now()"),
    ).rejects.toThrow(/permission denied/);
    await expect(as(alice, "delete from public.shipping_groups")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      as(
        alice,
        "insert into public.shipping_groups (tenant_id, order_ids, order_key) values ($1, $2::uuid[], 'x')",
        [tenantA, [a1, a2]],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("nobody can group, quote or buy across workspaces", async () => {
    // Another workspace's orders, under their own workspace or mine.
    await expect(setGroup(alice, tenantB, [otherB, b2], "save")).rejects.toThrow(
      /Workspace not found/,
    );
    await expect(setGroup(alice, tenantA, [otherB, b2], "save")).rejects.toThrow(/Order not found/);
    await expect(setGroup(alice, tenantA, [a1, otherB], "approve")).rejects.toThrow(
      /Order not found/,
    );
    // The server can't be talked into a quote that mixes workspaces.
    await expect(quoteGroup(tenantA, a1, [otherB], alice)).rejects.toThrow(/Order not found/);
    await expect(quoteGroup(tenantB, otherB, [b2], alice)).rejects.toThrow(/Workspace not found/);
    // A real quote in B can't be claimed from A, and A can't pull B's order into its own label.
    await quoteGroup(tenantB, otherB, [b2], bob);
    await expect(claimGroup(alice, otherB, [b2])).rejects.toThrow(/Order not found/);
    await quoteGroup(tenantA, a1, [a2], alice);
    await expect(claimGroup(alice, a1, [a2, b2])).rejects.toThrow(/Order not found/);
    // Only the server stores quotes.
    await expect(
      as(
        alice,
        "select public.save_group_label_quote($1, $2, $3, 'shp_forged', '[]'::jsonb, 'shipment', 1, $4::uuid[])",
        [tenantA, a1, alice.id, [a2]],
      ),
    ).rejects.toThrow(/permission denied/);
    expect(await left(b2)).toBe(5);
  });
});

describe("what people decide about a group", () => {
  let o1: string;
  let o2: string;
  let o3: string;
  const groups = () =>
    db
      .query<{
        order_ids: string[];
        order_key: string;
        saved_at: string | null;
        dismissed_at: string | null;
        approved_at: string | null;
      }>(
        "select * from public.shipping_groups where tenant_id = $1 and order_ids && $2::uuid[] order by created_at, order_key",
        [tenantA, [o1, o2, o3]],
      )
      .then((result) => result.rows);

  it("remembers 'not now' once, by the orders in the group, whatever order they were picked in", async () => {
    o1 = await shopOrder(tenantA, "2001", 1);
    o2 = await shopOrder(tenantA, "2002", 2);
    o3 = await shopOrder(tenantA, "2003", 3);
    await setGroup(carol, tenantA, [o2, o1], "dismiss");
    await setGroup(carol, tenantA, [o1, o2, o1], "dismiss");
    const rows = await groups();
    expect(rows).toHaveLength(1);
    expect(rows[0].dismissed_at).not.toBeNull();
    // The same key the app works out, so a third order joining is a new suggestion.
    expect(rows[0].order_key).toBe(groupKey([o1, o2]));
    expect(rows[0].order_key).not.toBe(groupKey([o1, o2, o3]));
  });

  it("keeps an order in one saved group at a time, and separating lets them go", async () => {
    await setGroup(carol, tenantA, [o1, o2], "save");
    let rows = await groups();
    // Saving a group someone waved away brings it back.
    expect(rows[0]).toMatchObject({ dismissed_at: null });
    expect(rows[0].saved_at).not.toBeNull();

    await setGroup(carol, tenantA, [o1, o2, o3], "save");
    rows = await groups();
    expect(rows.filter((row) => row.saved_at).map((row) => row.order_ids.length)).toEqual([3]);

    await setGroup(carol, tenantA, [o1, o3], "approve");
    await setGroup(carol, tenantA, [o1, o3], "separate");
    rows = await groups();
    expect(rows.some((row) => row.saved_at)).toBe(false);
    expect(rows.some((row) => row.approved_at)).toBe(false);
  });

  it("takes two to ten real orders and a known action", async () => {
    await expect(setGroup(carol, tenantA, [o1], "save")).rejects.toThrow(/two to ten/);
    await expect(setGroup(carol, tenantA, [o1, o1], "save")).rejects.toThrow(/two to ten/);
    await expect(setGroup(carol, tenantA, [o1, o2], "explode")).rejects.toThrow(/Unknown action/);
    await expect(
      setGroup(carol, tenantA, [o1, "00000000-0000-4000-8000-000000000000"], "save"),
    ).rejects.toThrow(/Order not found/);
  });

  it("forgets a group when one of its orders goes", async () => {
    const gone = await shopOrder(tenantA, "2004", 4);
    await setGroup(carol, tenantA, [o1, gone], "save");
    await db.query("delete from public.orders where tenant_id = $1 and external_id = '2004'", [
      tenantA,
    ]);
    const { rows } = await db.query(
      "select 1 from public.shipping_groups where $1 = any(order_ids)",
      [gone],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("one label for several orders", () => {
  let first: string;
  let second: string;
  let third: string;
  let quote: string;
  const TWO_BOXES = [
    {
      shipment_id: "shp_g1",
      tracking_number: "9400100000000000000021",
      tracking_url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400100000000000000021",
      label_url: "https://labels.example/g1.png",
    },
    {
      shipment_id: "shp_g2",
      tracking_number: "9400100000000000000022",
      tracking_url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400100000000000000022",
      label_url: "https://labels.example/g2.png",
    },
  ];

  it("a quote for several orders can only be bought for exactly those orders", async () => {
    first = await shopOrder(tenantA, "3001", 1);
    second = await shopOrder(tenantA, "3002", 2);
    third = await shopOrder(tenantA, "3003", 3, {
      // Part of it went earlier: it rides along with what is left.
      items: [
        { line_id: "l1", title: "Wool rug", variant: "Large", sku: "RUG-L", qty: 2, left: 0 },
        { line_id: "l2", title: "Yarn bundle", variant: null, sku: null, qty: 3, left: 1 },
      ],
    });
    await setGroup(carol, tenantA, [first, second, third], "save");
    quote = await quoteGroup(tenantA, first, [third, second], carol);

    // Not as a label for the first order alone: that would leave the others unsent.
    await expect(claimOne(carol, first)).rejects.toThrow(/not quoted/);
    // Not for fewer or other orders than were priced.
    await expect(claimGroup(carol, first, [second])).rejects.toThrow(/not quoted/);
    // Not on an order that isn't the oldest.
    await expect(claimGroup(carol, second, [first, third])).rejects.toThrow(/oldest/);
    await expect(claimGroup(carol, first, [])).rejects.toThrow(/two to ten/);
    await expect(claimGroup(carol, first, [first])).rejects.toThrow(/two to ten/);
    await expect(claimGroup(carol, first, [second, third], "rate_made_up")).rejects.toThrow(
      /not quoted/,
    );
    expect(
      (await db.query("select status from public.shipping_label_quotes where id = $1", [quote]))
        .rows[0],
    ).toEqual({ status: "quoted" });
  });

  it("refuses the purchase while any order is on hold, a pickup, cancelled, sent or without an address", async () => {
    const riders = [second, third];
    const withSecond = async (change: string, undo: string, message: RegExp) => {
      await db.query(`update public.shipping_orders set ${change} where id = $1`, [second]);
      await expect(claimGroup(carol, first, riders)).rejects.toThrow(message);
      await db.query(`update public.shipping_orders set ${undo} where id = $1`, [second]);
    };
    await withSecond("on_hold = true", "on_hold = false", /on hold/);
    await withSecond(
      "on_hold = true, hold_until = current_date + 30",
      "on_hold = false, hold_until = null",
      /on hold/,
    );
    await withSecond("pickup = true", "pickup = false", /pickup/);
    await withSecond("cancelled = true", "cancelled = false", /cancelled/);
    await withSecond("units_left = 0", "units_left = 5", /Nothing left/);
    await withSecond("address1 = null", "address1 = '12 Mill Lane'", /no shipping address/);
    // A hold whose day has come is back in the queue, so it may go.
    await db.query(
      "update public.shipping_orders set on_hold = true, hold_until = current_date - 1 where id = $1",
      [third],
    );
  });

  it("refuses orders that no longer read as one place, until someone says they are", async () => {
    await db.query("update public.shipping_orders set address1 = '14 Mill Lane' where id = $1", [
      second,
    ]);
    await expect(claimGroup(carol, first, [second, third])).rejects.toThrow(/ADDRESS_MISMATCH/);
    // Approving some other set doesn't count.
    await setGroup(carol, tenantA, [first, second], "approve");
    await expect(claimGroup(carol, first, [second, third])).rejects.toThrow(/ADDRESS_MISMATCH/);
    await setGroup(carol, tenantA, [third, first, second], "approve");
  });

  it("locks every order: nothing else can be bought for any of them while this is unfinished", async () => {
    const claim = await claimGroup(carol, first, [third, second]);
    expect(claim.quote_id).toBe(quote);
    expect([...claim.riders].sort()).toEqual([second, third].sort());

    // A second press, by anyone.
    await quoteGroup(tenantA, first, [second, third], alice);
    await expect(claimGroup(alice, first, [second, third])).rejects.toThrow(/still being finished/);
    // A label for one of the orders riding along, on its own.
    await quoteOne(tenantA, second, alice);
    await expect(claimOne(alice, second)).rejects.toThrow(/still being finished/);
    // Or a different group that shares one of them.
    const extra = await shopOrder(tenantA, "3004", 4);
    await quoteGroup(tenantA, third, [extra], alice);
    await expect(claimGroup(alice, third, [extra])).rejects.toThrow(/still being finished/);
  });

  it("records every order in one go: one parcel with the label and cost, the rest pointing at it", async () => {
    expect(await bought(tenantA, quote, TWO_BOXES)).toBe(true);
    await expect(record(bob, quote)).rejects.toThrow(/Label not found/);
    const number = await record(carol, quote);

    const parcels = await parcelsOf([first, second, third]);
    expect(parcels).toHaveLength(3);
    const lead = parcels.find((parcel) => parcel.shipping_order_id === first)!;
    expect(lead).toMatchObject({
      number,
      order_name: "#3001 + #3002 + #3003",
      cost: "14.20",
      label_provider: "easypost",
      merged_with: null,
      shop_status: "pending",
    });
    for (const rider of parcels.filter((parcel) => parcel.id !== lead.id)) {
      expect(rider).toMatchObject({
        cost: null,
        label_provider: null,
        merged_with: lead.id,
        tracking_number: "9400100000000000000021",
        shop_status: "pending",
        note: "Sent together with #3001",
      });
    }
    expect(parcels.map((parcel) => parcel.order_name)).toEqual([
      "#3001 + #3002 + #3003",
      "#3002",
      "#3003",
    ]);
    expect([await left(first), await left(second), await left(third)]).toEqual([0, 0, 0]);
    // The part-sent order's parcel holds only what was left; its hold is over.
    const { rows } = await db.query<{
      items: { line_id: string; qty: number }[];
      on_hold: boolean;
    }>(
      "select s.items, so.on_hold from public.shipments s join public.shipping_orders so on so.id = s.shipping_order_id where so.id = $1",
      [third],
    );
    expect(rows[0].items.map((item) => [item.line_id, item.qty])).toEqual([["l2", 1]]);
    expect(rows[0].on_hold).toBe(false);

    expect(
      (
        await db.query(
          "select status, shipment_id from public.shipping_label_quotes where id = $1",
          [quote],
        )
      ).rows[0],
    ).toEqual({ status: "recorded", shipment_id: lead.id });
    // Nothing is waiting to ship together any more.
    expect(
      (
        await db.query("select 1 from public.shipping_groups where order_ids && $1::uuid[]", [
          [first, second, third],
        ])
      ).rows,
    ).toHaveLength(0);
    // Recording twice does nothing.
    await expect(record(carol, quote)).rejects.toThrow(/Label not found/);
  });

  it("tells the shop about each order on its own, with every box's tracking number", async () => {
    const sends = await service<{
      order_external_id: string;
      tracking_numbers: string[];
      tracking_urls: string[];
      notify_customer: boolean;
      items: { line_id: string }[];
    }>("select * from public.claim_shipments_to_send(50)");
    const mine = sends.filter((send) => ["3001", "3002", "3003"].includes(send.order_external_id));
    expect(mine.map((send) => send.order_external_id).sort()).toEqual(["3001", "3002", "3003"]);
    for (const send of mine) {
      expect(send.tracking_numbers).toEqual(["9400100000000000000021", "9400100000000000000022"]);
      expect(send.tracking_urls).toHaveLength(2);
      expect(send.notify_customer).toBe(true);
    }
    expect(mine.find((send) => send.order_external_id === "3003")!.items).toHaveLength(1);
  });

  it("counts one parcel and one postage, and every order's shipping paid", async () => {
    const [{ r }] = await as<{
      r: { parcels: number; priced: number; orders: number; postage: number; collected: number };
    }>(alice, "select public.shipping_report($1, 30) as r", [tenantA]);
    expect(r).toMatchObject({ parcels: 1, priced: 1, orders: 3, postage: 14.2, collected: 36 });
  });

  it("only an owner or admin can undo it, only from the parcel with the label, and every order comes back", async () => {
    const parcels = await parcelsOf([first, second, third]);
    const lead = parcels.find((parcel) => parcel.merged_with === null)!;
    const rider = parcels.find((parcel) => parcel.merged_with !== null)!;
    await expect(as(carol, "select public.void_label_shipment($1)", [lead.id])).rejects.toThrow(
      /Only owners and admins/,
    );
    await expect(as(alice, "select public.void_shipment($1)", [rider.id])).rejects.toThrow(
      /sent together/,
    );
    await expect(as(bob, "select public.void_label_shipment($1)", [lead.id])).rejects.toThrow(
      /Shipment not found/,
    );
    // One of them has already reached the shop.
    await service("select public.finish_shipment_send($1, null)", [rider.id]);

    const [{ status }] = await as<{ status: string }>(
      alice,
      "select public.void_label_shipment($1) as status",
      [lead.id],
    );
    // So the person is told to cancel that fulfilment in the shop too.
    expect(status).toBe("sent");
    const after = await parcelsOf([first, second, third]);
    expect(after.every((parcel) => parcel.voided_at !== null)).toBe(true);
    expect(after.filter((parcel) => parcel.shop_status === "skipped")).toHaveLength(2);
    expect([await left(first), await left(second), await left(third)]).toEqual([5, 5, 1]);
    // The refund is asked for once, on the parcel that carries the label.
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.shipments where shipping_order_id = any($1::uuid[]) and label_refund_status = 'requested'",
      [[first, second, third]],
    );
    expect(rows[0].n).toBe(1);
    // Nothing voided is sent to the shop.
    const sends = await service<{ order_external_id: string }>(
      "select * from public.claim_shipments_to_send(50)",
    );
    expect(sends.filter((send) => send.order_external_id.startsWith("300"))).toHaveLength(0);
  });
});

describe("when something changes after the label is paid for", () => {
  it("an order sent another way in the meantime is left out, and the rest are still recorded", async () => {
    const lead = await shopOrder(tenantA, "4001", 1);
    const rider = await shopOrder(tenantA, "4002", 2);
    const late = await shopOrder(tenantA, "4003", 3);
    const quote = await quoteGroup(tenantA, lead, [rider, late], carol);
    await claimGroup(carol, lead, [rider, late]);
    await bought(tenantA, quote);
    // Someone records the last order by hand before the label is recorded.
    await as(
      carol,
      "select public.record_shipment($1, $2, 'UPS', '', '1Z', null, null, '[]'::jsonb, '', false, false)",
      [tenantA, late],
    );
    await record(carol, quote, false);

    const parcels = await parcelsOf([lead, rider, late]);
    const main = parcels.find((parcel) => parcel.label_provider === "easypost")!;
    expect(main.order_name).toBe("#4001 + #4002");
    expect(parcels.filter((parcel) => parcel.merged_with === main.id)).toHaveLength(1);
    expect(parcels.find((parcel) => parcel.shipping_order_id === late)).toMatchObject({
      merged_with: null,
      tracking_number: "1Z",
    });
    // Asked not to tell the shop: none of them is queued.
    expect(parcels.every((parcel) => parcel.shop_status === "skipped")).toBe(true);
    expect([await left(lead), await left(rider), await left(late)]).toEqual([0, 0, 0]);
  });

  it("a recording that fails part-way leaves nothing half done, and the paid label is still there to finish", async () => {
    const lead = await shopOrder(tenantA, "4101", 1);
    const rider = await shopOrder(tenantA, "4102", 2);
    const quote = await quoteGroup(tenantA, lead, [rider], carol);
    await claimGroup(carol, lead, [rider]);
    await bought(tenantA, quote);
    // Something unexpected goes wrong while the second order is being recorded.
    await db.exec(`
      create function public.test_break_rider() returns trigger language plpgsql as $$
      begin
        if new.note like 'Sent together with %' then raise exception 'disk full'; end if;
        return new;
      end $$;
      create trigger test_break_rider before insert on public.shipments
        for each row execute function public.test_break_rider();`);
    await expect(record(carol, quote)).rejects.toThrow(/disk full/);
    expect(await parcelsOf([lead, rider])).toHaveLength(0);
    expect([await left(lead), await left(rider)]).toEqual([5, 5]);
    const { rows } = await db.query<{ status: string; tracking_number: string }>(
      "select status, tracking_number from public.shipping_label_quotes where id = $1",
      [quote],
    );
    expect(rows[0]).toEqual({ status: "bought", tracking_number: "9400100000000000000021" });
    // And nothing else can be bought for either order until it is finished.
    await quoteOne(tenantA, rider, alice);
    await expect(claimOne(alice, rider)).rejects.toThrow(/still being finished/);

    await db.exec(
      "drop trigger test_break_rider on public.shipments; drop function public.test_break_rider();",
    );
    await record(carol, quote);
    expect(await parcelsOf([lead, rider])).toHaveLength(2);
    expect([await left(lead), await left(rider)]).toEqual([0, 0]);
  });

  it("a purchase that never happened frees every order again", async () => {
    const lead = await shopOrder(tenantA, "4201", 1);
    const rider = await shopOrder(tenantA, "4202", 2);
    const quote = await quoteGroup(tenantA, lead, [rider], carol);
    await claimGroup(carol, lead, [rider]);
    await release(tenantA, quote);
    await quoteOne(tenantA, rider, carol);
    const single = await claimOne(carol, rider);
    await bought(tenantA, single.quote_id);
    await record(carol, single.quote_id);
    // Bought moments ago on its own: it can't ride along on another label straight after.
    await db.query(
      "update public.shipping_orders set units_left = 5, items = jsonb_set(items, '{0,left}', '2') where id = $1",
      [rider],
    );
    await quoteGroup(tenantA, lead, [rider], carol);
    await expect(claimGroup(carol, lead, [rider])).rejects.toThrow(/moments ago/);
  });

  it("asking for one order's rates replaces an open quote that had others riding along", async () => {
    const lead = await shopOrder(tenantA, "4301", 1);
    const rider = await shopOrder(tenantA, "4302", 2);
    const group = await quoteGroup(tenantA, lead, [rider], carol);
    const alone = await quoteOne(tenantA, lead, carol);
    expect(alone).toBe(group);
    await expect(claimGroup(carol, lead, [rider])).rejects.toThrow(/not quoted/);
    await claimOne(carol, lead);
    await bought(tenantA, alone);
    await record(carol, alone);
    expect([await left(lead), await left(rider)]).toEqual([0, 5]);
    const [parcel] = await parcelsOf([lead]);
    expect(parcel).toMatchObject({ order_name: "#4301", merged_with: null });
  });
});
