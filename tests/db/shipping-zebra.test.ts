import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Printing straight to a Zebra: an EasyPost label's ZPL kept beside the label
 * (only by the server, only inside its workspace, and gone with the shopper),
 * and the note that a label was printed, which any teammate may make for
 * their own workspace's parcels and no one else's.
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

const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'America/New_York', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

async function shopOrder(tenant: string, id: string, email: string, customer: string) {
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
        paid: true,
        items: [{ line_id: "l1", title: "Wool rug", variant: null, sku: null, qty: 1, left: 1 }],
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

// A rate as the server stores it for a computer that prints to a Zebra.
const rate = (shipment: string) => ({
  id: `rate_${shipment}`,
  carrier: "USPS",
  carrierCode: "USPS",
  service: "GroundAdvantage",
  name: "USPS Ground Advantage",
  price: "6.40",
  currency: "USD",
  days: 4,
  source: "easypost",
  ref: { shipment_id: shipment, kind: "shipment", label_format: "zpl" },
});
const HASH = `${"ab".repeat(16)}:${"cd".repeat(32)}`;
// "^XA^FDSam Shopper^FS^XZ" and a tiny picture, as base64. Not real labels.
const ZPL = Buffer.from("^XA^FDSam Shopper^FS^XZ").toString("base64");
const GIF = "R0lGODlhAQABAAAAACw=";

/** An EasyPost label, bought and kept the way the server does it; not yet a parcel. */
async function boughtLabel(tenant: string, order: string, by: User, shipment: string, boxes = 1) {
  const [{ id }] = await service<{ id: string }>(
    "select public.save_label_quote_from($1, $2, $3, 'easypost', $4, $5::jsonb, $6, $7, '{}'::uuid[], $8) as id",
    [
      tenant,
      order,
      by.id,
      shipment,
      JSON.stringify([rate(shipment)]),
      boxes > 1 ? "order" : "shipment",
      boxes,
      HASH,
    ],
  );
  const [{ c }] = await as<{ c: { rate: { ref: Record<string, string> } } }>(
    by,
    "select public.claim_label_purchase($1, $2) as c",
    [order, `rate_${shipment}`],
  );
  // The format asked for comes back with the claim, from the quote the server kept.
  expect(c.rate.ref.label_format).toBe("zpl");
  const parcels = Array.from({ length: boxes }, (_, i) => ({
    shipment_id: `${shipment}_${i + 1}`,
    tracking_number: `9400${i + 1}`,
    tracking_url: null,
    label_url: `https://easypost-files.example/${shipment}_${i + 1}.zpl`,
  }));
  const [{ ok }] = await service<{ ok: boolean }>(
    "select public.mark_label_bought($1, $2, 'USPS', 'Ground Advantage', '94001', null, $3, 'live', 6.40, $4::jsonb) as ok",
    [tenant, id, parcels[0].label_url, JSON.stringify(parcels)],
  );
  expect(ok).toBe(true);
  return id;
}

const keepFiles = (tenant: string, quoteId: string, files: object[]) =>
  service<{ n: number }>("select public.keep_label_files($1, $2, $3::jsonb) as n", [
    tenant,
    quoteId,
    JSON.stringify(files),
  ]).then((rows) => rows[0].n);
const parcelsOf = async (quoteId: string) =>
  (
    await db.query<{ parcels: Record<string, unknown>[] }>(
      "select parcels from public.shipping_label_quotes where id = $1",
      [quoteId],
    )
  ).rows[0].parcels;
const record = (user: User, quoteId: string) =>
  as<{ n: number }>(user, "select public.record_label_shipment($1) as n", [quoteId]).then(
    (rows) => rows[0].n,
  );
const shipment = async (tenant: string, number: number) =>
  (
    await db.query<{
      id: string;
      label_parcels: Record<string, unknown>[];
      label_printed_at: string | null;
      label_printed_by: string | null;
      label_print_count: number;
    }>("select * from public.shipments where tenant_id = $1 and number = $2", [tenant, number])
  ).rows[0];
type Printed = { p: { shipment_id: string; printed_at: string; count: number } };
const printed = (user: User, id: string) =>
  as<Printed>(user, "select public.mark_label_printed($1) as p", [id]).then((rows) => rows[0].p);

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  const invited = await asUser(db, alice, async (tx) => {
    const { rows } = await tx.query<{ token: string }>(
      "select * from public.create_invite($1, $2, 'member'::public.membership_role)",
      [tenantA, carol.email],
    );
    return rows[0];
  });
  await as(carol, "select public.accept_invite($1)", [invited.token]);
  orderA = await shopOrder(tenantA, "7001", "lee@example.com", "c70");
  orderB = await shopOrder(tenantB, "8001", "ash@example.com", "c80");
});

describe("an EasyPost label's ZPL", () => {
  let quoteId: string;
  let parcelId: string;

  it("is kept beside the bought label, by the server only, a box at a time", async () => {
    quoteId = await boughtLabel(tenantA, orderA, carol, "shp_zebra", 2);
    // Never from a browser session, whoever it is.
    for (const user of [alice, carol, bob]) {
      await expect(
        as(user, "select public.keep_label_files($1, $2, '[]'::jsonb)", [tenantA, quoteId]),
      ).rejects.toThrow(/permission denied/);
    }
    // Another workspace's server call finds nothing to add to.
    expect(
      await keepFiles(tenantB, quoteId, [{ box: 1, content_type: "text/plain", data: ZPL }]),
    ).toBe(0);
    expect((await parcelsOf(quoteId))[0].label_file ?? null).toBeNull();

    expect(
      await keepFiles(tenantA, quoteId, [
        { box: 1, content_type: "text/plain", data: ZPL },
        { box: 2, content_type: "text/plain", data: ZPL },
        // A box that doesn't exist, a kind we don't keep, and something that isn't base64.
        { box: 3, content_type: "text/plain", data: ZPL },
        { box: 2, content_type: "text/html", data: ZPL },
        { box: 1, content_type: "text/plain", data: "^XA not base64 ^XZ" },
      ]),
    ).toBe(2);
    const parcels = await parcelsOf(quoteId);
    expect(parcels).toHaveLength(2);
    for (const [index, box] of parcels.entries()) {
      expect(box.label_file).toMatch(/^[0-9a-f-]{36}$/);
      // Everything the label already had is still there.
      expect(box).toMatchObject({
        shipment_id: `shp_zebra_${index + 1}`,
        tracking_number: `9400${index + 1}`,
        label_url: `https://easypost-files.example/shp_zebra_${index + 1}.zpl`,
      });
    }
    // Kept again (a retry), it replaces rather than piles up.
    expect(
      await keepFiles(tenantA, quoteId, [{ box: 1, content_type: "text/plain", data: ZPL }]),
    ).toBe(1);
    const { rows } = await db.query<{ box: number; content_type: string; data: string }>(
      "select box, content_type, data from public.shipping_label_files where quote_id = $1 order by box",
      [quoteId],
    );
    expect(rows).toEqual([
      { box: 1, content_type: "text/plain", data: ZPL },
      { box: 2, content_type: "text/plain", data: ZPL },
    ]);
  });

  it("goes onto the parcel with the label, and is read only inside its workspace", async () => {
    const number = await record(carol, quoteId);
    const parcel = await shipment(tenantA, number);
    parcelId = parcel.id;
    const ids = parcel.label_parcels.map((box) => box.label_file as string);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
    expect(parcel).toMatchObject({
      label_printed_at: null,
      label_printed_by: null,
      label_print_count: 0,
    });
    // Once it is a parcel there is nothing left to add files to.
    expect(
      await keepFiles(tenantA, quoteId, [{ box: 1, content_type: "image/gif", data: GIF }]),
    ).toBe(0);

    const read = (user: User) =>
      as<{ id: string }>(
        user,
        "select id from public.shipping_label_files where id = any ($1::uuid[])",
        [ids],
      );
    expect(await read(carol)).toHaveLength(2);
    expect(await read(alice)).toHaveLength(2);
    expect(await read(bob)).toHaveLength(0);
    await expect(
      as(carol, "update public.shipping_label_files set data = $1 where id = $2", [GIF, ids[0]]),
    ).rejects.toThrow(/permission denied/);
  });

  it("a label that was printed says so, with who and how often, for the whole team", async () => {
    const first = await printed(carol, parcelId);
    expect(first).toMatchObject({ shipment_id: parcelId, count: 1 });
    expect(new Date(first.printed_at).getTime()).toBeGreaterThan(0);
    // A second copy, from the owner's computer this time.
    expect(await printed(alice, parcelId)).toMatchObject({ count: 2 });
    const [row] = await as<{
      label_printed_at: string | null;
      label_printed_by: string;
      label_print_count: number;
    }>(
      carol,
      "select label_printed_at, label_printed_by, label_print_count from public.shipments where id = $1",
      [parcelId],
    );
    expect(row.label_printed_at).not.toBeNull();
    expect(row).toMatchObject({ label_printed_by: alice.id, label_print_count: 2 });
  });

  it("another workspace can't see that, or mark it", async () => {
    await expect(printed(bob, parcelId)).rejects.toThrow(/Parcel not found/);
    expect(await as(bob, "select id from public.shipments where id = $1", [parcelId])).toHaveLength(
      0,
    );
    // And no one signed out.
    await expect(
      db.transaction(async (tx) => {
        await tx.query("set local role anon");
        await tx.query("select public.mark_label_printed($1)", [parcelId]);
      }),
    ).rejects.toThrow(/permission denied/);
    expect((await shipment(tenantA, 1)).label_print_count).toBe(2);
    // The note can't be written any other way.
    await expect(
      as(carol, "update public.shipments set label_print_count = 0 where id = $1", [parcelId]),
    ).rejects.toThrow(/permission denied/);
  });

  it("only a bought label can be marked; an order that rode along marks the parcel that carries it", async () => {
    const other = await shopOrder(tenantA, "7002", "lee@example.com", "c70");
    const [{ n }] = await as<{ n: number }>(
      carol,
      "select public.record_shipment($1, $2, 'USPS', 'Ground', '9400 2', null, null, '[]'::jsonb, '') as n",
      [tenantA, other],
    );
    const byHand = await shipment(tenantA, n);
    await expect(printed(carol, byHand.id)).rejects.toThrow(/no label/);
    // Sent together: this parcel points at the one whose label covers it.
    await db.query("update public.shipments set merged_with = $1 where id = $2", [
      parcelId,
      byHand.id,
    ]);
    expect(await printed(carol, byHand.id)).toMatchObject({ shipment_id: parcelId, count: 3 });
    expect((await shipment(tenantA, n)).label_print_count).toBe(0);
  });
});

describe("privacy", () => {
  const files = async (tenant: string) =>
    (await db.query("select id from public.shipping_label_files where tenant_id = $1", [tenant]))
      .rows.length;

  it("forgetting a shopper removes their label's ZPL, in that workspace only", async () => {
    const theirs = await boughtLabel(tenantB, orderB, bob, "shp_zebra_b");
    expect(
      await keepFiles(tenantB, theirs, [{ box: 1, content_type: "text/plain", data: ZPL }]),
    ).toBe(1);
    await record(bob, theirs);
    expect(await files(tenantA)).toBe(2);
    expect(await files(tenantB)).toBe(1);

    await service("select public.redact_customer($1, 'shopify', 'c70', 'lee@example.com')", [
      tenantA,
    ]);
    expect(await files(tenantA)).toBe(0);
    expect(await files(tenantB)).toBe(1);
  });

  it("disconnecting the shop takes the ZPL with the orders", async () => {
    await service("select public.purge_provider_data($1, 'shopify')", [tenantB]);
    expect(await files(tenantB)).toBe(0);
  });
});
