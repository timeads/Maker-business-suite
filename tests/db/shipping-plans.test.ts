import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * What the To ship list remembers about each order (`shipping_order_plans`):
 * the box a person picked, the best price worked out for the plan, and what
 * the carriers said about the address. Members read their own workspace's;
 * only functions write; nothing in it is an address or can buy a label; and
 * it goes when the shopper is forgotten or the shop disconnected.
 */
type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;
let orderA: string;
let orderA2: string;
let orderB: string;
let boxA: string;
let bigA: string;
let boxB: string;

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

async function order(tenant: string, id: string): Promise<string> {
  await service(
    "select public.upsert_commerce_batch($1, 'shopify', $2::jsonb, '[]'::jsonb, $3::jsonb)",
    [
      tenant,
      JSON.stringify([
        { external_id: `c${id}`, email: `c${id}@example.com`, first_name: "Sam", last_name: "S" },
      ]),
      JSON.stringify([
        {
          external_id: id,
          name: `#${id}`,
          customer_external_id: `c${id}`,
          email: `c${id}@example.com`,
          processed_at: "2026-11-20T22:03:00Z",
          currency: "USD",
          net_sales: 285.6,
          total_shipping: 14,
          total: 299.6,
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
        city: "Brooklyn",
        region: "NY",
        postal_code: "11201",
        country_code: "us",
        paid: true,
        shipping_paid: 14,
        weight_grams: 1871,
        items: [{ line_id: "l1", title: "Yarn", variant: "Red", sku: "Y-R", qty: 2, left: 2 }],
      },
    ]),
  ]);
  const { rows } = await db.query<{ id: string }>(
    "select id from public.shipping_orders where tenant_id = $1 and external_id = $2",
    [tenant, id],
  );
  return rows[0].id;
}

const box = async (owner: User, tenant: string, name: string) =>
  (
    await as<{ id: string }>(
      owner,
      "select public.save_shipping_box($1, null, $2, 'box', 12, 9, 4, 6, false) as id",
      [tenant, name],
    )
  )[0].id;

type Plan = {
  chosen_box_id: string | null;
  box_id: string | null;
  box_source: string;
  weight_tenth_oz: number | null;
  plan_key: string | null;
  quote_status: string | null;
  quote_source: string | null;
  quote_carrier: string | null;
  quote_service: string | null;
  quote_cents: number | null;
  quote_currency: string | null;
  quoted_at: string | null;
  address_key: string | null;
  address_status: string | null;
  address_residential: boolean | null;
  claimed_at: string | null;
};
const plan = async (orderId: string) =>
  (
    await db.query<Plan>("select * from public.shipping_order_plans where shipping_order_id = $1", [
      orderId,
    ])
  ).rows[0];

const quote = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    box_id: boxA,
    box_source: "default",
    weight_tenth_oz: 720,
    plan_key: "salt:hash",
    status: "ok",
    source: "ups",
    carrier: "UPS",
    service: "UPS Ground",
    cents: 943,
    currency: "usd",
    ...over,
  });
const save = (tenant: string, orderId: string, q: string | null, a: string | null = null) =>
  service<{ ok: boolean }>(
    "select public.save_shipping_order_plan($1, $2, $3::jsonb, $4::jsonb) as ok",
    [tenant, orderId, q, a],
  );
const claim = (tenant: string, ids: string[]) =>
  service<{ id: string }>("select public.claim_shipping_order_plans($1, $2::uuid[]) as id", [
    tenant,
    ids,
  ]);

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "A Makers");
  tenantB = await tenantFor(bob, "B Makers");
  orderA = await order(tenantA, "3001");
  orderA2 = await order(tenantA, "3002");
  orderB = await order(tenantB, "3001");
  boxA = await box(alice, tenantA, "Medium box");
  bigA = await box(alice, tenantA, "Big box");
  boxB = await box(bob, tenantB, "Their box");
}, 120_000);

describe("working out the list", () => {
  it("takes an order once, so two lists don't ask the carriers twice", async () => {
    expect((await claim(tenantA, [orderA, orderA2])).map((row) => row.id).sort()).toEqual(
      [orderA, orderA2].sort(),
    );
    // Someone else's list a moment later gets nothing.
    expect(await claim(tenantA, [orderA, orderA2])).toEqual([]);
    // Saving lets go of it.
    expect((await save(tenantA, orderA, quote()))[0].ok).toBe(true);
    expect((await claim(tenantA, [orderA, orderA2])).map((row) => row.id)).toEqual([orderA]);
    // A list that died half way is taken over after two minutes.
    await db.query(
      "update public.shipping_order_plans set claimed_at = now() - interval '3 minutes' where shipping_order_id = $1",
      [orderA2],
    );
    expect((await claim(tenantA, [orderA2])).map((row) => row.id)).toEqual([orderA2]);
    await save(tenantA, orderA, null);
    await save(tenantA, orderA2, null);
  });

  it("never takes another workspace's order", async () => {
    expect(await claim(tenantA, [orderB])).toEqual([]);
    expect(await plan(orderB)).toBeUndefined();
    expect((await save(tenantA, orderB, quote()))[0].ok).toBe(false);
    expect(await plan(orderB)).toBeUndefined();
  });

  it("keeps the plan and its best price, and nothing a label could be bought with", async () => {
    await save(tenantA, orderA, quote());
    const row = await plan(orderA);
    expect(row).toMatchObject({
      box_id: boxA,
      box_source: "default",
      weight_tenth_oz: 720,
      plan_key: "salt:hash",
      quote_status: "ok",
      quote_source: "ups",
      quote_carrier: "UPS",
      quote_service: "UPS Ground",
      quote_cents: 943,
      quote_currency: "USD",
      claimed_at: null,
    });
    expect(row.quoted_at).not.toBeNull();
    // The list's price is its own: it made no quote that Buy could claim.
    const { rows } = await db.query(
      "select id from public.shipping_label_quotes where tenant_id = $1",
      [tenantA],
    );
    expect(rows).toHaveLength(0);
    await expect(
      as(alice, "select public.claim_label_purchase($1, 'rate_anything')", [orderA]),
    ).rejects.toThrow(/not quoted/);
    // No column holds an address or a carrier's own id.
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'shipping_order_plans'",
    );
    expect(columns.rows.map((c) => c.column_name).join(" ")).not.toMatch(
      /address1|city|postal|recipient|rate_id|shipment_id|rates/,
    );
  });

  it("clears the price when nobody offered one, and refuses nonsense", async () => {
    await save(tenantA, orderA, quote({ status: "none" }));
    expect(await plan(orderA)).toMatchObject({
      quote_status: "none",
      quote_source: null,
      quote_carrier: null,
      quote_cents: null,
      quote_currency: null,
    });
    await expect(save(tenantA, orderA, quote({ status: "bought" }))).rejects.toThrow(/Not a plan/);
    await expect(save(tenantA, orderA, quote({ source: "fedex" }))).rejects.toThrow();
    // Another workspace's box is never put on a plan.
    await save(tenantA, orderA, quote({ box_id: boxB }));
    expect((await plan(orderA)).box_id).toBeNull();
  });

  it("keeps the address answer apart from the price", async () => {
    await save(tenantA, orderA, quote());
    await save(
      tenantA,
      orderA,
      null,
      JSON.stringify({ address_key: "salt:addr", status: "found", residential: true }),
    );
    expect(await plan(orderA)).toMatchObject({
      quote_status: "ok",
      quote_cents: 943,
      address_key: "salt:addr",
      address_status: "found",
      address_residential: true,
    });
    await save(tenantA, orderA, quote({ cents: 1010 }));
    expect(await plan(orderA)).toMatchObject({ quote_cents: 1010, address_status: "found" });
    await expect(
      save(tenantA, orderA, null, JSON.stringify({ address_key: "k", status: "maybe" })),
    ).rejects.toThrow();
  });
});

describe("the box a person picks", () => {
  it("is remembered for the order, and drops the price worked out for the old box", async () => {
    await save(tenantA, orderA, quote());
    await as(alice, "select public.set_shipping_order_box($1, $2)", [orderA, bigA]);
    expect(await plan(orderA)).toMatchObject({
      chosen_box_id: bigA,
      plan_key: null,
      address_status: "found",
    });
    // Picking the same box again changes nothing.
    await save(tenantA, orderA, quote({ box_id: bigA, box_source: "person" }));
    await as(alice, "select public.set_shipping_order_box($1, $2)", [orderA, bigA]);
    expect(await plan(orderA)).toMatchObject({
      chosen_box_id: bigA,
      box_source: "person",
      plan_key: "salt:hash",
    });
    // Back to the usual box.
    await as(alice, "select public.set_shipping_order_box($1, null)", [orderA]);
    expect(await plan(orderA)).toMatchObject({ chosen_box_id: null, plan_key: null });
  });

  it("works for an order the list hasn't looked at yet", async () => {
    await db.query("delete from public.shipping_order_plans where shipping_order_id = $1", [
      orderA2,
    ]);
    await as(alice, "select public.set_shipping_order_box($1, $2)", [orderA2, bigA]);
    expect(await plan(orderA2)).toMatchObject({ chosen_box_id: bigA, quote_status: null });
  });

  it("only takes a box from the same workspace that is still on the list", async () => {
    await expect(
      as(alice, "select public.set_shipping_order_box($1, $2)", [orderA, boxB]),
    ).rejects.toThrow(/Box not found/);
    const gone = await box(alice, tenantA, "Old box");
    await as(alice, "select public.archive_shipping_box($1)", [gone]);
    await expect(
      as(alice, "select public.set_shipping_order_box($1, $2)", [orderA, gone]),
    ).rejects.toThrow(/Box not found/);
  });

  it("forgets the choice when the box is removed for good", async () => {
    const temp = await box(alice, tenantA, "Temp box");
    await as(alice, "select public.set_shipping_order_box($1, $2)", [orderA2, temp]);
    await db.query("delete from public.shipping_boxes where id = $1", [temp]);
    expect((await plan(orderA2)).chosen_box_id).toBeNull();
  });
});

describe("one workspace never sees another's", () => {
  it("a member reads only their own workspace's plans", async () => {
    await save(tenantB, orderB, quote({ box_id: boxB, cents: 555 }));
    const mine = await as<{ shipping_order_id: string }>(
      alice,
      "select shipping_order_id from public.shipping_order_plans",
    );
    expect(mine.map((row) => row.shipping_order_id).sort()).toEqual([orderA, orderA2].sort());
    const theirs = await as<{ quote_cents: number }>(
      bob,
      "select quote_cents from public.shipping_order_plans",
    );
    expect(theirs).toEqual([{ quote_cents: 555 }]);
  });

  it("a member can't write a plan, or pick a box for another workspace's order", async () => {
    await expect(
      as(alice, "update public.shipping_order_plans set quote_cents = 1 where tenant_id = $1", [
        tenantA,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(
        alice,
        "insert into public.shipping_order_plans (shipping_order_id, tenant_id) values ($1, $2)",
        [orderB, tenantB],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(alice, "delete from public.shipping_order_plans where tenant_id = $1", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(alice, "select public.save_shipping_order_plan($1, $2, null, null)", [tenantA, orderA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(alice, "select public.claim_shipping_order_plans($1, $2::uuid[])", [tenantA, [orderA]]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(alice, "select public.set_shipping_order_box($1, null)", [orderB]),
    ).rejects.toThrow(/Order not found/);
  });
});

describe("privacy", () => {
  it("forgetting a shopper removes what the list kept about their order, in that workspace only", async () => {
    await save(
      tenantA,
      orderA,
      quote(),
      JSON.stringify({ address_key: "salt:addr", status: "found", residential: true }),
    );
    await service("select public.redact_customer($1, 'shopify', 'c3001', 'c3001@example.com')", [
      tenantA,
    ]);
    expect(await plan(orderA)).toBeUndefined();
    // Another shopper's order, and the other workspace's, are left alone.
    expect(await plan(orderA2)).toBeDefined();
    expect(await plan(orderB)).toMatchObject({ quote_cents: 555 });
  });

  it("disconnecting the shop removes the plans with the orders", async () => {
    await service("select public.purge_provider_data($1, 'shopify')", [tenantB]);
    const { rows } = await db.query(
      "select shipping_order_id from public.shipping_order_plans where tenant_id = $1",
      [tenantB],
    );
    expect(rows).toHaveLength(0);
    expect(await plan(orderA2)).toBeDefined();
  });
});
