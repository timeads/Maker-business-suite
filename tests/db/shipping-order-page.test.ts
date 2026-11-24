import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * What the order page added to the sync: the shop's tags on an order, the
 * products' total before discounts with the discounts themselves, and each
 * item's own picture. All optional, all inside one workspace, and the tags go
 * with the shopper when they ask to be forgotten.
 */
type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let bob: User; // owner of B
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

const sale = (tenant: string, id: string, extra: Record<string, unknown> = {}) =>
  service("select public.upsert_commerce_batch($1, 'shopify', $2::jsonb, '[]'::jsonb, $3::jsonb)", [
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
        total_shipping: 33,
        total: 318.6,
        lines: [],
        ...extra,
      },
    ]),
  ]);

const packing = (tenant: string, id: string, extra: Record<string, unknown> = {}) =>
  service("select public.upsert_shipping_orders($1, 'shopify', $2::jsonb)", [
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
        items: [{ line_id: "l1", title: "Yarn", variant: "Red", sku: "Y-R", qty: 2, left: 2 }],
        ...extra,
      },
    ]),
  ]);

type Figures = { gross_sales: string | null; total_discounts: string | null; net_sales: string };
const figures = async (tenant: string, id: string) =>
  (
    await db.query<Figures>(
      "select gross_sales, total_discounts, net_sales from public.orders where tenant_id = $1 and external_id = $2",
      [tenant, id],
    )
  ).rows[0];
type Packing = { tags: string[] | null; items: { image?: string }[]; recipient: string | null };
const packed = async (tenant: string, id: string) =>
  (
    await db.query<Packing>(
      "select tags, items, recipient from public.shipping_orders where tenant_id = $1 and external_id = $2",
      [tenant, id],
    )
  ).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "A Makers");
  tenantB = await tenantFor(bob, "B Makers");
  await sale(tenantA, "2001", { gross_sales: 336, total_discounts: 50.4 });
  await packing(tenantA, "2001", {
    tags: ["Returning_Customer", "  ", ` ${"x".repeat(120)} `],
    items: [
      {
        line_id: "l1",
        title: "Yarn",
        variant: "Red",
        sku: "Y-R",
        qty: 2,
        left: 2,
        image: "https://cdn.shopify.com/s/files/1/yarn-red.jpg?width=120",
      },
    ],
  });
  await sale(tenantB, "2001", { gross_sales: 90, total_discounts: 0 });
  await packing(tenantB, "2001", { tags: ["Wholesale"] });
}, 120_000);

describe("the order page's extra figures", () => {
  it("keeps the products before discounts and the discounts beside the sale", async () => {
    expect(await figures(tenantA, "2001")).toEqual({
      gross_sales: "336.00",
      total_discounts: "50.40",
      net_sales: "285.60",
    });
  });

  it("leaves them empty for a sync that doesn't send them, and for nonsense", async () => {
    await sale(tenantA, "2002");
    expect(await figures(tenantA, "2002")).toMatchObject({
      gross_sales: null,
      total_discounts: null,
    });
    await sale(tenantA, "2003", { gross_sales: -5, total_discounts: -1 });
    expect(await figures(tenantA, "2003")).toMatchObject({
      gross_sales: null,
      total_discounts: null,
    });
  });

  it("follows the shop when an order is edited", async () => {
    await sale(tenantA, "2002", { gross_sales: 300, total_discounts: 14.4 });
    expect(await figures(tenantA, "2002")).toMatchObject({
      gross_sales: "300.00",
      total_discounts: "14.40",
    });
  });

  it("keeps an order's tags, tidied, and each item's own picture", async () => {
    const row = await packed(tenantA, "2001");
    expect(row.tags).toEqual(["Returning_Customer", "x".repeat(80)]);
    expect(row.items[0].image).toBe("https://cdn.shopify.com/s/files/1/yarn-red.jpg?width=120");
    // An order synced without tags or pictures is fine as it is.
    await packing(tenantA, "2002");
    const plain = await packed(tenantA, "2002");
    expect(plain.tags).toBeNull();
    expect(plain.items[0].image).toBeUndefined();
  });

  it("keeps at most twenty tags", async () => {
    await packing(tenantA, "2002", { tags: Array.from({ length: 30 }, (_, n) => `tag-${n}`) });
    const { tags } = await packed(tenantA, "2002");
    expect(tags).toHaveLength(20);
    expect(tags?.[0]).toBe("tag-0");
    expect(tags?.[19]).toBe("tag-19");
  });
});

describe("one workspace never sees another's", () => {
  it("a member reads only their own workspace's tags and figures", async () => {
    const seen = await as<{ tags: string[] | null }>(
      alice,
      "select tags from public.shipping_orders where external_id = '2001'",
    );
    expect(seen).toEqual([{ tags: ["Returning_Customer", "x".repeat(80)] }]);
    const sums = await as<{ gross_sales: string | null }>(
      bob,
      "select gross_sales from public.orders where external_id = '2001'",
    );
    expect(sums).toEqual([{ gross_sales: "90.00" }]);
  });

  it("a member can't write them", async () => {
    await expect(
      as(alice, "update public.shipping_orders set tags = '{mine}' where tenant_id = $1", [
        tenantB,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(alice, "select public.upsert_shipping_orders($1, 'shopify', '[]'::jsonb)", [tenantB]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(
        alice,
        "select public.upsert_commerce_batch($1, 'shopify', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)",
        [tenantB],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("privacy", () => {
  it("a forgotten shopper's order loses its tags with the address", async () => {
    await service("select public.redact_customer($1, 'shopify', 'c2001', 'c2001@example.com')", [
      tenantA,
    ]);
    const row = await packed(tenantA, "2001");
    expect(row.recipient).toBeNull();
    expect(row.tags).toBeNull();
    // The other workspace's order with the same number is untouched.
    expect((await packed(tenantB, "2001")).tags).toEqual(["Wholesale"]);
  });
});
