import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Incoming parcels followed by UPS: what the worker may claim, what it writes
 * down, "check now", and which items are in a parcel.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let bob: User; // owner of B
let carol: User; // plain member of A
let tenantA: string;
let tenantB: string;
let orderA: string;
let orderB: string;
let lineA: string;
let lineB: string;

// Made up, in the shape of UPS numbers.
const UPS_1 = "1Z999AA10123456784";
const UPS_2 = "1Z999AA10123456785";
const UPS_B = "1Z999BB10123456786";

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

async function sentOrder(owner: User, tenant: string, prefix: string) {
  await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
    tenant,
    JSON.stringify([
      {
        external_id: `${prefix}-v1`,
        inventory_item_id: `${prefix}-i1`,
        title: "Wool rug",
        sku: `${prefix}-RUG`,
        on_hand: 4,
        tracked: true,
      },
    ]),
  ]);
  const item = await one<{ id: string }>("select id from public.stock_items where tenant_id = $1", [
    tenant,
  ]);
  const [{ id: supplier }] = await as<{ id: string }>(
    owner,
    "select public.save_supplier($1, null, 'Hill Mill Yarns', null, 30, 30, 1, 'order', '') as id",
    [tenant],
  );
  const [{ number }] = await as<{ number: number }>(
    owner,
    "select public.create_purchase_order($1, $2, $3::jsonb, '') as number",
    [tenant, supplier, JSON.stringify([{ stock_item_id: item.id, qty: 10, unit_cost: 5 }])],
  );
  const order = await one<{ id: string }>(
    "select id from public.purchase_orders where tenant_id = $1 and number = $2",
    [tenant, number],
  );
  await as(owner, "select public.set_purchase_order_status($1, 'ordered')", [order.id]);
  const line = await one<{ id: string }>(
    "select id from public.purchase_order_lines where po_id = $1",
    [order.id],
  );
  return { order: order.id, line: line.id };
}
const addParcel = async (owner: User, order: string, tracking: string, carrier = "UPS") =>
  (
    await as<{ id: string }>(
      owner,
      "select public.save_po_shipment($1, null, $2, $3, null, null, '') as id",
      [order, carrier, tracking],
    )
  )[0].id;
const connectUps = (tenant: string, user: User, mode: "production" | "test") =>
  service("select public.save_connection($1, 'ups', $2, 'UPS', '{}', $3::jsonb, $4, $5::jsonb)", [
    tenant,
    `ups-${tenant}`,
    JSON.stringify({ access_token: "fake" }),
    user.id,
    JSON.stringify({ mode }),
  ]);
const claim = () =>
  service<{ id: string; tenant_id: string; tracking: string }>(
    "select * from public.claim_po_shipment_checks(20)",
  );
const parcelRow = (id: string) =>
  one<Record<string, unknown>>(
    "select carrier_status, carrier_detail, carrier_expected_on::text, carrier_delivered_on::text, carrier_scan_place, carrier_scan_at is not null as scanned, carrier_checked_at is not null as checked, carrier_error, carrier_check_requested_at is not null as asked, carrier_claimed_at is not null as claimed from public.purchase_order_shipments where id = $1",
    [id],
  );

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
  ({ order: orderA, line: lineA } = await sentOrder(alice, tenantA, "a"));
  ({ order: orderB, line: lineB } = await sentOrder(bob, tenantB, "b"));
}, 120_000);

describe("asking UPS about incoming parcels", () => {
  let ups1: string;
  let ups2: string;
  let other: string;
  let upsB: string;

  it("claims nothing for a workspace with no UPS account of its own, or only a practice one", async () => {
    ups1 = await addParcel(alice, orderA, UPS_1);
    other = await addParcel(alice, orderA, "9400111899223100000000", "USPS");
    upsB = await addParcel(bob, orderB, UPS_B);
    expect(await claim()).toEqual([]);
    await connectUps(tenantB, bob, "test");
    expect(await claim()).toEqual([]);
  });

  it("claims UPS numbers only, once, for workspaces that have connected UPS for real", async () => {
    await connectUps(tenantA, alice, "production");
    const first = await claim();
    expect(first).toEqual([{ id: ups1, tenant_id: tenantA, tracking: UPS_1 }]);
    // Already in hand: a second worker gets nothing.
    expect(await claim()).toEqual([]);
    expect(await parcelRow(ups1)).toMatchObject({ claimed: true, checked: false });
    expect(await parcelRow(other)).toMatchObject({ claimed: false });
    expect(await parcelRow(upsB)).toMatchObject({ claimed: false });
  });

  it("writes down what UPS said, with the time, and waits four hours before asking again", async () => {
    await service("select public.finish_po_shipment_check($1, $2::jsonb)", [
      ups1,
      JSON.stringify({
        status: "on_the_way",
        detail: "Departed from Facility",
        expected_on: "2026-11-26",
        delivered_on: null,
        scan_place: "Louisville, KY, US",
        scan_at: "2026-11-23T12:13:56.000Z",
      }),
    ]);
    expect(await parcelRow(ups1)).toEqual({
      carrier_status: "on_the_way",
      carrier_detail: "Departed from Facility",
      carrier_expected_on: "2026-11-26",
      carrier_delivered_on: null,
      carrier_scan_place: "Louisville, KY, US",
      scanned: true,
      checked: true,
      carrier_error: null,
      asked: false,
      claimed: false,
    });
    // What a person typed is untouched.
    expect(
      await one(
        "select expected_on, arrived_on from public.purchase_order_shipments where id = $1",
        [ups1],
      ),
    ).toEqual({
      expected_on: null,
      arrived_on: null,
    });
    expect(await claim()).toEqual([]);
    await db.query(
      "update public.purchase_order_shipments set carrier_checked_at = now() - interval '5 hours' where id = $1",
      [ups1],
    );
    expect((await claim()).map((row) => row.id)).toEqual([ups1]);
  });

  it("keeps what it knew when a look-up fails or UPS has lost the number", async () => {
    await service("select public.finish_po_shipment_check($1, $2::jsonb)", [
      ups1,
      JSON.stringify({ error: "UPS is having trouble right now." }),
    ]);
    expect(await parcelRow(ups1)).toMatchObject({
      carrier_status: "on_the_way",
      carrier_expected_on: "2026-11-26",
      carrier_error: "UPS is having trouble right now.",
      checked: true,
      claimed: false,
    });
    await service("select public.finish_po_shipment_check($1, $2::jsonb)", [
      ups1,
      JSON.stringify({ status: "not_found" }),
    ]);
    expect(await parcelRow(ups1)).toMatchObject({
      carrier_status: "on_the_way",
      carrier_detail: "Departed from Facility",
      carrier_scan_place: "Louisville, KY, US",
      carrier_error: null,
    });
    // A number UPS has never known says so.
    ups2 = await addParcel(alice, orderA, UPS_2);
    expect((await claim()).map((row) => row.id)).toEqual([ups2]);
    await service("select public.finish_po_shipment_check($1, $2::jsonb)", [
      ups2,
      JSON.stringify({ status: "not_found" }),
    ]);
    expect(await parcelRow(ups2)).toMatchObject({
      carrier_status: "not_found",
      carrier_detail: null,
      checked: true,
    });
    await expect(
      service("select public.finish_po_shipment_check($1, $2::jsonb)", [
        ups2,
        JSON.stringify({ status: "teleported" }),
      ]),
    ).rejects.toThrow(/Unknown status/);
  });

  it("stops once a parcel is delivered, marked as here, too old, or its order is finished", async () => {
    const due = async () => {
      await db.query(
        "update public.purchase_order_shipments set carrier_checked_at = now() - interval '5 hours', carrier_claimed_at = null",
      );
      const ids = (await claim()).map((row) => row.id);
      await db.query("update public.purchase_order_shipments set carrier_claimed_at = null");
      return ids.sort();
    };
    expect(await due()).toEqual([ups1, ups2].sort());

    await service("select public.finish_po_shipment_check($1, $2::jsonb)", [
      ups1,
      JSON.stringify({ status: "delivered", detail: "Delivered", delivered_on: "2026-11-25" }),
    ]);
    // The estimate UPS gave earlier is kept beside the delivery.
    expect(await parcelRow(ups1)).toMatchObject({
      carrier_status: "delivered",
      carrier_delivered_on: "2026-11-25",
      carrier_expected_on: "2026-11-26",
    });
    expect(await due()).toEqual([ups2]);

    await db.query(
      "update public.purchase_order_shipments set created_at = now() - interval '46 days' where id = $1",
      [ups2],
    );
    expect(await due()).toEqual([]);
    await db.query("update public.purchase_order_shipments set created_at = now() where id = $1", [
      ups2,
    ]);
    await db.query(
      "update public.purchase_order_shipments set arrived_on = current_date where id = $1",
      [ups2],
    );
    expect(await due()).toEqual([]);
    await db.query("update public.purchase_order_shipments set arrived_on = null where id = $1", [
      ups2,
    ]);
    await db.query("update public.purchase_orders set status = 'closed' where id = $1", [orderA]);
    expect(await due()).toEqual([]);
    await db.query("update public.purchase_orders set status = 'ordered' where id = $1", [orderA]);
    await as(alice, "select public.remove_po_shipment($1)", [ups2]);
    expect(await due()).toEqual([]);
  });

  it("lets a manager ask now, but not over and over", async () => {
    const ups3 = await addParcel(alice, orderA, "1Z999AA10123456787");
    await db.query(
      "update public.purchase_order_shipments set carrier_checked_at = now() - interval '1 hour' where id = $1",
      [ups3],
    );
    // Not due by the clock...
    expect(await claim()).toEqual([]);
    await expect(as(carol, "select public.request_po_shipment_check($1)", [ups3])).rejects.toThrow(
      /Only owners and admins/,
    );
    await expect(as(bob, "select public.request_po_shipment_check($1)", [ups3])).rejects.toThrow(
      /not found/,
    );
    await as(alice, "select public.request_po_shipment_check($1)", [ups3]);
    await expect(as(alice, "select public.request_po_shipment_check($1)", [ups3])).rejects.toThrow(
      /too_soon/,
    );
    // ...but asked for, so it is next.
    expect((await claim()).map((row) => row.id)).toEqual([ups3]);
    await service("select public.finish_po_shipment_check($1, $2::jsonb)", [
      ups3,
      JSON.stringify({ status: "label" }),
    ]);
    expect(await parcelRow(ups3)).toMatchObject({
      carrier_status: "label",
      asked: false,
      claimed: false,
    });
    await expect(as(alice, "select public.request_po_shipment_check($1)", [ups3])).rejects.toThrow(
      /too_soon/,
    );

    // Only UPS numbers, and only with a real UPS connection.
    await expect(as(alice, "select public.request_po_shipment_check($1)", [other])).rejects.toThrow(
      /not_ups/,
    );
    await expect(as(bob, "select public.request_po_shipment_check($1)", [upsB])).rejects.toThrow(
      /no_ups/,
    );
  });

  it("forgets what UPS said when the number itself is changed", async () => {
    const id = await addParcel(alice, orderA, "1Z999AA10123456788");
    await service("select public.finish_po_shipment_check($1, $2::jsonb)", [
      id,
      JSON.stringify({ status: "on_the_way", detail: "Moving" }),
    ]);
    await as(
      alice,
      "select public.save_po_shipment($1, $2, 'UPS', '1Z999AA10123456789', null, null, '')",
      [orderA, id],
    );
    expect(await parcelRow(id)).toMatchObject({
      carrier_status: null,
      carrier_detail: null,
      checked: false,
    });
  });

  it("is the worker's alone: nobody signed in can claim or write a carrier's answer", async () => {
    for (const call of [
      "select * from public.claim_po_shipment_checks(5)",
      `select public.finish_po_shipment_check('${ups1}', '{"status":"delivered"}'::jsonb)`,
    ]) {
      await expect(as(alice, call)).rejects.toThrow(/permission denied/);
      await expect(asAnon(db, (tx) => tx.query(call))).rejects.toThrow(/permission denied/);
    }
    await expect(
      as(
        alice,
        "update public.purchase_order_shipments set carrier_status = 'delivered' where id = $1",
        [ups1],
      ),
    ).rejects.toThrow(/permission denied/);
    // Members read their own parcels' status, and nobody else's.
    expect(
      (
        await as<{ n: number }>(
          carol,
          "select count(*)::int as n from public.purchase_order_shipments where carrier_status is not null",
        )
      )[0].n,
    ).toBeGreaterThan(0);
    expect(
      await as(bob, "select id from public.purchase_order_shipments where tenant_id = $1", [
        tenantA,
      ]),
    ).toEqual([]);
  });
});

describe("what is in a parcel", () => {
  it("records which lines and how many, replacing what was said before", async () => {
    const id = await addParcel(alice, orderA, "PRO-12345", "Freight");
    expect(
      await as(alice, "select public.set_po_shipment_items($1, $2::jsonb) as n", [
        id,
        JSON.stringify([{ line_id: lineA, quantity: 6 }]),
      ]),
    ).toEqual([{ n: 1 }]);
    await as(alice, "select public.set_po_shipment_items($1, $2::jsonb)", [
      id,
      JSON.stringify([
        { line_id: lineA, quantity: 3 },
        { line_id: lineA, quantity: 1 },
      ]),
    ]);
    expect(
      await as(
        carol,
        "select quantity from public.purchase_order_shipment_items where shipment_id = $1",
        [id],
      ),
    ).toEqual([{ quantity: 4 }]);
    // Saying nothing clears it.
    await as(alice, "select public.set_po_shipment_items($1, '[]'::jsonb)", [id]);
    expect(
      await as(
        alice,
        "select id from public.purchase_order_shipment_items where shipment_id = $1",
        [id],
      ),
    ).toEqual([]);

    await as(alice, "select public.set_po_shipment_items($1, $2::jsonb)", [
      id,
      JSON.stringify([{ line_id: lineA, quantity: 6 }]),
    ]);
    // It changes nothing about the order or the count.
    expect(
      await one("select qty_received from public.purchase_order_lines where id = $1", [lineA]),
    ).toEqual({ qty_received: 0 });
  });

  it("is for managers, on their own orders, with lines from that order", async () => {
    const mine = await one<{ id: string }>(
      "select id from public.purchase_order_shipments where tracking = 'PRO12345'",
    );
    const items = JSON.stringify([{ line_id: lineA, quantity: 1 }]);
    await expect(
      as(carol, "select public.set_po_shipment_items($1, $2::jsonb)", [mine.id, items]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      as(bob, "select public.set_po_shipment_items($1, $2::jsonb)", [mine.id, items]),
    ).rejects.toThrow(/not found/);
    // Another workspace's line can't be put in this parcel.
    await expect(
      as(alice, "select public.set_po_shipment_items($1, $2::jsonb)", [
        mine.id,
        JSON.stringify([{ line_id: lineB, quantity: 1 }]),
      ]),
    ).rejects.toThrow(/How many are in it/);
    await expect(
      as(alice, "select public.set_po_shipment_items($1, $2::jsonb)", [
        mine.id,
        JSON.stringify([{ line_id: lineA, quantity: 0 }]),
      ]),
    ).rejects.toThrow(/How many are in it/);
    // Read by the workspace's own team only; written only through the function.
    expect(await as(bob, "select id from public.purchase_order_shipment_items")).toEqual([]);
    await expect(
      as(
        alice,
        "insert into public.purchase_order_shipment_items (tenant_id, shipment_id, po_line_id, quantity) values ($1, $2, $3, 1)",
        [tenantA, mine.id, lineA],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asAnon(db, (tx) => tx.query("select id from public.purchase_order_shipment_items")),
    ).rejects.toThrow(/permission denied/);
    void orderB;
  });
});
