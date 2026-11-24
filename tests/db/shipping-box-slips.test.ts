import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Slips for an order in several boxes: what went in each box of a bought
 * label is kept on the parcel (only by the server, only when it is true of
 * that parcel, only inside its workspace), and each box's label can be
 * marked printed on its own by anyone on that workspace's team.
 */
type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let bob: User; // owner of B
let carol: User; // plain member of A
let tenantA: string;
let tenantB: string;

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

const ITEMS = [
  { line_id: "l1", title: "Wool rug", variant: null, sku: "RUG", qty: 3, left: 3 },
  { line_id: "l2", title: "Yarn bundle", variant: null, sku: "YARN", qty: 1, left: 1 },
];

async function shopOrder(tenant: string, id: string) {
  await service(
    "select public.upsert_commerce_batch($1, 'shopify', $2::jsonb, '[]'::jsonb, $3::jsonb)",
    [
      tenant,
      JSON.stringify([
        {
          external_id: `c${id}`,
          email: "sam@example.com",
          first_name: "Sam",
          last_name: "Shopper",
        },
      ]),
      JSON.stringify([
        {
          external_id: id,
          name: `#${id}`,
          customer_external_id: `c${id}`,
          email: "sam@example.com",
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
        paid: true,
        items: ITEMS,
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

const HASH = `${"ab".repeat(16)}:${"cd".repeat(32)}`;

/** A label for `boxes` boxes, bought and recorded the way the server does it. Returns the parcel's number. */
async function labelledParcel(tenant: string, order: string, by: User, ref: string, boxes: number) {
  const rate = {
    id: `rate_${ref}`,
    carrier: "USPS",
    carrierCode: "USPS",
    service: "GroundAdvantage",
    name: "USPS Ground Advantage",
    price: "6.40",
    currency: "USD",
    days: 4,
    source: "easypost",
    ref: { shipment_id: ref, kind: boxes > 1 ? "order" : "shipment" },
  };
  const [{ id }] = await service<{ id: string }>(
    "select public.save_label_quote_from($1, $2, $3, 'easypost', $4, $5::jsonb, $6, $7, '{}'::uuid[], $8) as id",
    [
      tenant,
      order,
      by.id,
      ref,
      JSON.stringify([rate]),
      boxes > 1 ? "order" : "shipment",
      boxes,
      HASH,
    ],
  );
  await as(by, "select public.claim_label_purchase($1, $2)", [order, `rate_${ref}`]);
  const parcels = Array.from({ length: boxes }, (_, i) => ({
    shipment_id: `${ref}_${i + 1}`,
    tracking_number: `9400${i + 1}`,
    tracking_url: null,
    label_url: `https://easypost-files.example/${ref}_${i + 1}.png`,
  }));
  await service(
    "select public.mark_label_bought($1, $2, 'USPS', 'Ground Advantage', '94001', null, $3, 'live', 6.40, $4::jsonb)",
    [tenant, id, parcels[0].label_url, JSON.stringify(parcels)],
  );
  const [{ n }] = await as<{ n: number }>(by, "select public.record_label_shipment($1) as n", [id]);
  return n;
}

type Parcel = {
  id: string;
  box_items: { name: string | null; items: Record<string, number> }[] | null;
  label_boxes_printed: Record<string, string>;
  label_printed_at: string | null;
  label_print_count: number;
};
const parcel = async (tenant: string, number: number) =>
  (
    await db.query<Parcel>("select * from public.shipments where tenant_id = $1 and number = $2", [
      tenant,
      number,
    ])
  ).rows[0];
const note = (tenant: string, number: number, boxes: unknown) =>
  service<{ ok: boolean }>("select public.note_shipment_boxes($1, $2, $3::jsonb) as ok", [
    tenant,
    number,
    JSON.stringify(boxes),
  ]).then((rows) => rows[0].ok);

const SPLIT = [
  { name: "Medium box", items: { l1: 2 } },
  { name: "", items: { l1: 1, l2: 1 } },
];

let numberA: number;
let numberB: number;

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
  numberA = await labelledParcel(tenantA, await shopOrder(tenantA, "7001"), carol, "shp_a", 2);
  numberB = await labelledParcel(tenantB, await shopOrder(tenantB, "8001"), bob, "shp_b", 2);
});

describe("what went in each box of a bought label", () => {
  it("starts out unknown, so the parcel has one slip as before", async () => {
    expect(await parcel(tenantA, numberA)).toMatchObject({
      box_items: null,
      label_boxes_printed: {},
    });
  });

  it("is never written from a browser session, whoever it is", async () => {
    for (const user of [alice, carol, bob]) {
      await expect(
        as(user, "select public.note_shipment_boxes($1, $2, $3::jsonb)", [
          tenantA,
          numberA,
          JSON.stringify(SPLIT),
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(user, "update public.shipments set box_items = $1::jsonb where number = $2", [
          JSON.stringify(SPLIT),
          numberA,
        ]),
      ).rejects.toThrow(/permission denied/);
    }
    expect((await parcel(tenantA, numberA)).box_items).toBeNull();
  });

  it("is kept only when it is true of the parcel", async () => {
    // Not one entry per box of the label.
    expect(await note(tenantA, numberA, [SPLIT[0]])).toBe(false);
    expect(await note(tenantA, numberA, [...SPLIT, { name: "Tube", items: {} }])).toBe(false);
    // More of a line than went in the parcel.
    expect(await note(tenantA, numberA, [{ items: { l1: 3 } }, { items: { l1: 1, l2: 1 } }])).toBe(
      false,
    );
    // A line the parcel doesn't hold.
    expect(await note(tenantA, numberA, [{ items: { l1: 2 } }, { items: { l9: 1 } }])).toBe(false);
    // Nothing said about what went where, or not boxes at all.
    expect(await note(tenantA, numberA, [{ items: {} }, { items: {} }])).toBe(false);
    expect(await note(tenantA, numberA, { boxes: 2 })).toBe(false);
    expect(await note(tenantA, numberA, ["a", "b"])).toBe(false);
    expect((await parcel(tenantA, numberA)).box_items).toBeNull();
    // No such parcel.
    expect(await note(tenantA, 999, SPLIT)).toBe(false);
  });

  it("another workspace's server call changes nothing here", async () => {
    // Workspace B's parcel has the same number; naming A's workspace is what picks the parcel.
    expect(numberB).toBe(numberA);
    expect(await note(tenantB, numberB, SPLIT)).toBe(true);
    expect((await parcel(tenantA, numberA)).box_items).toBeNull();
    expect((await parcel(tenantB, numberB)).box_items).toHaveLength(2);
  });

  it("keeps line ids, counts and the box's name, tidied, and nothing else", async () => {
    expect(
      await note(tenantA, numberA, [
        { name: "  Medium box  ", items: { l1: 2, l2: 0 }, address1: "12 Mill Lane" },
        { name: "", items: { l1: 1, l2: 1, l3: "many" } },
      ]),
    ).toBe(true);
    expect((await parcel(tenantA, numberA)).box_items).toEqual([
      { name: "Medium box", items: { l1: 2 } },
      { name: null, items: { l1: 1, l2: 1 } },
    ]);
  });

  it("is read by the team and by no one outside the workspace", async () => {
    const read = (user: User) =>
      as<{ box_items: unknown }>(
        user,
        "select box_items from public.shipments where tenant_id = $1 and number = $2",
        [tenantA, numberA],
      );
    expect(await read(carol)).toHaveLength(1);
    expect(await read(alice)).toHaveLength(1);
    expect(await read(bob)).toHaveLength(0);
  });

  it("is not kept for a parcel recorded by hand, or one that was undone", async () => {
    const other = await shopOrder(tenantA, "7002");
    const [{ n }] = await as<{ n: number }>(
      carol,
      "select public.record_shipment($1, $2, 'USPS', 'Ground', '9400 2', null, null, '[]'::jsonb, '') as n",
      [tenantA, other],
    );
    expect(await note(tenantA, n, [{ items: { l1: 3, l2: 1 } }])).toBe(false);
    await db.query(
      "update public.shipments set voided_at = now() where tenant_id = $1 and number = $2",
      [tenantB, numberB],
    );
    expect(await note(tenantB, numberB, SPLIT)).toBe(false);
  });
});

describe("one box's label has been printed", () => {
  type Marked = { p: { shipment_id: string; box: number; boxes_printed: Record<string, string> } };
  const mark = (user: User, id: string, box: number | null) =>
    as<Marked>(user, "select public.mark_label_box_printed($1, $2) as p", [id, box]).then(
      (rows) => rows[0].p,
    );

  it("is noted a box at a time, by anyone on the team, and counts the label as printed", async () => {
    const { id } = await parcel(tenantA, numberA);
    const first = await mark(carol, id, 2);
    expect(first).toMatchObject({ shipment_id: id, box: 2 });
    expect(Object.keys(first.boxes_printed)).toEqual(["2"]);
    const second = await mark(alice, id, 1);
    expect(Object.keys(second.boxes_printed).sort()).toEqual(["1", "2"]);
    const after = await parcel(tenantA, numberA);
    expect(after.label_printed_at).not.toBeNull();
    expect(after.label_print_count).toBe(2);
    expect(new Date(after.label_boxes_printed["1"]).getTime()).toBeGreaterThan(0);
  });

  it("refuses a box the label doesn't have", async () => {
    const { id } = await parcel(tenantA, numberA);
    for (const box of [0, 3, -1, null]) {
      await expect(mark(carol, id, box)).rejects.toThrow(/no such box/);
    }
    expect(Object.keys((await parcel(tenantA, numberA)).label_boxes_printed).sort()).toEqual([
      "1",
      "2",
    ]);
  });

  it("another workspace can't mark it, nor anyone signed out, nor by writing the row", async () => {
    const { id } = await parcel(tenantA, numberA);
    await expect(mark(bob, id, 1)).rejects.toThrow(/Parcel not found/);
    await expect(
      db.transaction(async (tx) => {
        await tx.query("set local role anon");
        await tx.query("select public.mark_label_box_printed($1, 1)", [id]);
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(carol, "update public.shipments set label_boxes_printed = '{}'::jsonb where id = $1", [
        id,
      ]),
    ).rejects.toThrow(/permission denied/);
    expect((await parcel(tenantA, numberA)).label_print_count).toBe(2);
  });

  it("only a bought label has boxes to mark", async () => {
    const byHand = (
      await db.query<{ id: string }>(
        "select id from public.shipments where tenant_id = $1 and label_provider is null",
        [tenantA],
      )
    ).rows[0];
    await expect(mark(carol, byHand.id, 1)).rejects.toThrow(/no label/);
  });
});
