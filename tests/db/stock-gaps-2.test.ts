import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Stock, the second batch of gaps closed after the side-by-side with
 * TuftStock: the reorder list's photos and "% Rev", and saved views.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let bob: User; // owner of B
let carol: User; // plain member of A
let tenantA: string;
let tenantB: string;
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
  rug = await itemId(tenantA, "a-v1");
  yarn = await itemId(tenantA, "a-v2");
  bobRug = await itemId(tenantB, "b-v1");
}, 120_000);

describe("the reorder list", () => {
  it("keeps each option's own photo, written only by the sync, and only https", async () => {
    await service("select public.set_variant_photos($1, 'shopify', $2::jsonb)", [
      tenantA,
      JSON.stringify([
        { external_id: "a-v1", image_url: "https://cdn.shopify.com/rug-large.jpg" },
        { external_id: "a-v2", image_url: "http://plain.example/yarn.jpg" },
        // Another workspace's item, named by its id: never touched.
        { external_id: "b-v1", image_url: "https://cdn.shopify.com/not-yours.jpg" },
      ]),
    ]);
    const photo = async (id: string) =>
      (
        await one<{ variant_image_url: string | null }>(
          "select variant_image_url from public.stock_items where id = $1",
          [id],
        )
      ).variant_image_url;
    expect(await photo(rug)).toBe("https://cdn.shopify.com/rug-large.jpg");
    expect(await photo(yarn)).toBeNull();
    expect(await photo(bobRug)).toBeNull();

    // A later sync of the items leaves the photo alone.
    await sync(tenantA, items("a"));
    expect(await photo(rug)).toBe("https://cdn.shopify.com/rug-large.jpg");

    const call = "select public.set_variant_photos($1, 'shopify', '[]'::jsonb)";
    await expect(as(alice, call, [tenantA])).rejects.toThrow(/permission denied/);
    await expect(asAnon(db, (tx) => tx.query(call, [tenantA]))).rejects.toThrow(
      /permission denied/,
    );
    // Members read it with the rest of the item; nobody writes it directly.
    await expect(
      as(alice, "update public.stock_items set variant_image_url = null where id = $1", [rug]),
    ).rejects.toThrow(/permission denied/);
  });

  it("adds up what each item brought in over 90 days, inside its own workspace only", async () => {
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
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    await service(
      "select public.upsert_commerce_batch($1, 'shopify', '[]'::jsonb, '[]'::jsonb, $2::jsonb)",
      [
        tenantA,
        JSON.stringify([
          order("r1", ago(2), [
            { external_id: "l1", title: "Wool rug", sku: "a-RUG-L", quantity: 2, unit_price: 120 },
            {
              external_id: "l2",
              title: "Yarn bundle",
              product_external_id: "a-p2",
              quantity: 3,
              unit_price: 10,
            },
          ]),
          // Too long ago to count.
          order("r2", ago(120), [
            { external_id: "l3", title: "Wool rug", sku: "a-RUG-L", quantity: 5, unit_price: 120 },
          ]),
          // Cancelled: never a sale.
          order(
            "r3",
            ago(1),
            [
              {
                external_id: "l4",
                title: "Wool rug",
                sku: "a-RUG-L",
                quantity: 9,
                unit_price: 120,
              },
            ],
            { cancelled_at: new Date().toISOString() },
          ),
        ]),
      ],
    );
    const revenue = async (user: User, tenant: string) =>
      Object.fromEntries(
        (
          await as<{ stock_item_id: string; revenue: string }>(
            user,
            "select stock_item_id, revenue from public.stock_revenue_by_item($1, 90)",
            [tenant],
          )
        ).map((row) => [row.stock_item_id, Number(row.revenue)]),
      );
    expect(await revenue(alice, tenantA)).toEqual({ [rug]: 240, [yarn]: 30 });
    // A plain member of the workspace sees the same; another workspace sees nothing of it.
    expect(await revenue(carol, tenantA)).toEqual({ [rug]: 240, [yarn]: 30 });
    expect(await revenue(bob, tenantA)).toEqual({});
    await expect(
      asAnon(db, (tx) => tx.query("select * from public.stock_revenue_by_item($1, 90)", [tenantA])),
    ).rejects.toThrow(/permission denied/);
  });

  it("saved views are a workspace setting: managers write, the team reads, others see nothing", async () => {
    const body = JSON.stringify({
      version: 1,
      views: [
        { id: "yarn000001", name: "Yarn", view: "all", q: "yarn", sort: "orderBy", dir: "asc" },
      ],
    });
    const save = "select public.save_config($1, 'stock', 'saved_views', $2::jsonb)";
    await expect(as(carol, save, [tenantA, body])).rejects.toThrow();
    await expect(as(bob, save, [tenantA, body])).rejects.toThrow();
    await as(alice, save, [tenantA, body]);
    const read = (user: User) =>
      as<{ body: { views: { name: string }[] } }>(
        user,
        "select body from public.configs where tenant_id = $1 and module = 'stock' and key = 'saved_views'",
        [tenantA],
      );
    expect((await read(carol))[0].body.views[0].name).toBe("Yarn");
    expect(await read(bob)).toEqual([]);
    // Like every config write, it leaves a version behind.
    const versions = await one<{ n: number }>(
      "select count(*)::int as n from public.config_versions where tenant_id = $1 and module = 'stock' and key = 'saved_views'",
      [tenantA],
    );
    expect(versions.n).toBe(1);
  });
});
