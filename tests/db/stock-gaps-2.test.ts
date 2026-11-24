import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Stock, the second batch of gaps closed after the side-by-side with
 * TuftStock: the reorder list's photos and "% Rev", saved views, who an order
 * is addressed to, and the stretches when a supplier is shut.
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

describe("who an order is addressed to", () => {
  it("a manager keeps a contact name and a few more emails; nobody else can", async () => {
    const [{ id: supplier }] = await as<{ id: string }>(
      alice,
      "select public.save_supplier($1, null, 'Hill Mill', 'orders@mill.test', 21, 45, 1, 'order', '') as id",
      [tenantA],
    );
    const save = "select public.save_supplier_contact($1, $2, $3, $4::text[])";
    await as(alice, save, [
      tenantA,
      supplier,
      "  Dana Reyes ",
      ["Accounts@Mill.test", "accounts@mill.test", " ", "sales@mill.test"],
    ]);
    const read = () =>
      one<{ contact_name: string | null; more_emails: string[] }>(
        "select contact_name, more_emails from public.suppliers where id = $1",
        [supplier],
      );
    expect(await read()).toEqual({
      contact_name: "Dana Reyes",
      more_emails: ["accounts@mill.test", "sales@mill.test"],
    });

    // Not an address, or too many of them: refused, and nothing changes.
    await expect(as(alice, save, [tenantA, supplier, "X", ["not an email"]])).rejects.toThrow(
      /Bad email/,
    );
    await expect(
      as(alice, save, [tenantA, supplier, "X", [1, 2, 3, 4, 5, 6].map((n) => `a${n}@mill.test`)]),
    ).rejects.toThrow(/Too many/);
    expect((await read()).contact_name).toBe("Dana Reyes");

    // A plain member, another workspace's owner (even naming this workspace), and a visitor.
    await expect(as(carol, save, [tenantA, supplier, "Carol", []])).rejects.toThrow();
    await expect(as(bob, save, [tenantA, supplier, "Bob", []])).rejects.toThrow();
    await expect(as(bob, save, [tenantB, supplier, "Bob", []])).rejects.toThrow(/not found/i);
    await expect(
      asAnon(db, (tx) => tx.query(save, [tenantA, supplier, "Anon", []])),
    ).rejects.toThrow(/permission denied/);
    expect((await read()).contact_name).toBe("Dana Reyes");
    // The other workspace can't read them either.
    expect(
      await as(bob, "select contact_name from public.suppliers where id = $1", [supplier]),
    ).toEqual([]);

    // Emptied, both go back to nothing.
    await as(alice, save, [tenantA, supplier, "", []]);
    expect(await read()).toEqual({ contact_name: null, more_emails: [] });
  });
});

describe("when a supplier is shut", () => {
  let mill: string;
  let clay: string;
  const supplier = (user: User, tenant: string, name: string) =>
    as<{ id: string }>(
      user,
      "select public.save_supplier($1, null, $2, null, 30, 30, 1, 'order', '') as id",
      [tenant, name],
    ).then((rows) => rows[0].id);
  const save = "select public.save_supplier_closure($1, $2, $3, $4, $5::date, $6::date) as id";
  const closuresOf = (user: User, tenant: string) =>
    as<{ name: string; starts_on: string; ends_on: string }>(
      user,
      "select name, starts_on::text, ends_on::text from public.supplier_closures where tenant_id = $1 order by starts_on",
      [tenant],
    );

  beforeAll(async () => {
    mill = await supplier(alice, tenantA, "Closing Mill");
    clay = await supplier(bob, tenantB, "Closing Clay");
  });

  it("a manager writes down dated closures, several for one supplier, and can change one", async () => {
    const [{ id }] = await as<{ id: string }>(alice, save, [
      tenantA,
      mill,
      null,
      "  Spring Festival ",
      "2027-01-25",
      "2027-02-21",
    ]);
    await as(alice, save, [tenantA, mill, null, "Summer break", "2027-08-01", "2027-08-14"]);
    // A single day is a closure too.
    await as(alice, save, [tenantA, mill, null, "Stocktake", "2027-05-05", "2027-05-05"]);
    expect(await closuresOf(alice, tenantA)).toEqual([
      { name: "Spring Festival", starts_on: "2027-01-25", ends_on: "2027-02-21" },
      { name: "Stocktake", starts_on: "2027-05-05", ends_on: "2027-05-05" },
      { name: "Summer break", starts_on: "2027-08-01", ends_on: "2027-08-14" },
    ]);
    // The festival moves: next year's dates replace this entry's.
    await as(alice, save, [tenantA, mill, id, "Spring Festival", "2027-01-28", "2027-02-24"]);
    expect((await closuresOf(alice, tenantA))[0]).toEqual({
      name: "Spring Festival",
      starts_on: "2027-01-28",
      ends_on: "2027-02-24",
    });
    const row = await one<{ created_by: string; tenant_id: string }>(
      "select created_by, tenant_id from public.supplier_closures where id = $1",
      [id],
    );
    expect(row).toEqual({ created_by: alice.id, tenant_id: tenantA });
  });

  it("refuses dates that make no sense, an empty name and a supplier that isn't there", async () => {
    await expect(
      as(alice, save, [tenantA, mill, null, "Backwards", "2027-03-10", "2027-03-01"]),
    ).rejects.toThrow(/Bad dates/);
    await expect(
      as(alice, save, [tenantA, mill, null, "Years", "2027-01-01", "2029-01-01"]),
    ).rejects.toThrow(/Bad dates/);
    await expect(
      as(alice, save, [tenantA, mill, null, "No end", "2027-01-01", null]),
    ).rejects.toThrow(/Bad dates/);
    await expect(
      as(alice, save, [tenantA, mill, null, "   ", "2027-03-01", "2027-03-02"]),
    ).rejects.toThrow(/needs a name/);
    await expect(
      as(alice, save, [tenantA, tenantA, null, "Nobody", "2027-03-01", "2027-03-02"]),
    ).rejects.toThrow(/Supplier not found/);
    // Changing a closure under a different supplier's name finds nothing.
    const [{ id }] = await as<{ id: string }>(
      alice,
      "select id from public.supplier_closures where tenant_id = $1 limit 1",
      [tenantA],
    );
    const other = await supplier(alice, tenantA, "Other Mill");
    await expect(
      as(alice, save, [tenantA, other, id, "Moved", "2027-03-01", "2027-03-02"]),
    ).rejects.toThrow(/Closure not found/);
    expect(await closuresOf(alice, tenantA)).toHaveLength(3);
  });

  it("is for owners and admins: the team reads, and nobody writes the table directly", async () => {
    await expect(
      as(carol, save, [tenantA, mill, null, "Carol's", "2027-03-01", "2027-03-02"]),
    ).rejects.toThrow(/Only owners and admins/);
    // A plain member still sees when the supplier is shut.
    expect(await closuresOf(carol, tenantA)).toHaveLength(3);
    const [{ id }] = await as<{ id: string }>(
      carol,
      "select id from public.supplier_closures where tenant_id = $1 limit 1",
      [tenantA],
    );
    await expect(as(carol, "select public.remove_supplier_closure($1)", [id])).rejects.toThrow(
      /Only owners and admins/,
    );
    for (const sql of [
      `insert into public.supplier_closures (tenant_id, supplier_id, name, starts_on, ends_on) values ('${tenantA}', '${mill}', 'Sneaky', '2027-04-01', '2027-04-02')`,
      `update public.supplier_closures set name = 'Sneaky' where id = '${id}'`,
      `delete from public.supplier_closures where id = '${id}'`,
    ]) {
      await expect(as(alice, sql)).rejects.toThrow(/permission denied/);
    }
    await expect(
      asAnon(db, (tx) => tx.query("select * from public.supplier_closures")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asAnon(db, (tx) => tx.query(save, [tenantA, mill, null, "Anon", "2027-03-01", "2027-03-02"])),
    ).rejects.toThrow(/permission denied/);
    expect(await closuresOf(alice, tenantA)).toHaveLength(3);
  });

  it("never crosses workspaces: not to read, add, change or take off", async () => {
    await as(bob, save, [tenantB, clay, null, "Kiln rebuild", "2027-03-01", "2027-03-20"]);
    // Each owner sees only their own.
    expect((await closuresOf(bob, tenantB)).map((c) => c.name)).toEqual(["Kiln rebuild"]);
    expect(await closuresOf(bob, tenantA)).toEqual([]);
    expect(await as(bob, "select name from public.supplier_closures")).toEqual([
      { name: "Kiln rebuild" },
    ]);
    expect(
      (await as<{ name: string }>(alice, "select name from public.supplier_closures")).map(
        (c) => c.name,
      ),
    ).not.toContain("Kiln rebuild");

    const [{ id: alices }] = await db
      .query<{ id: string }>(
        "select id from public.supplier_closures where tenant_id = $1 order by starts_on limit 1",
        [tenantA],
      )
      .then((r) => r.rows);
    // Bob names Alice's workspace: not a manager there.
    await expect(
      as(bob, save, [tenantA, mill, null, "Bob's", "2027-03-01", "2027-03-02"]),
    ).rejects.toThrow(/Only owners and admins/);
    // Bob names his own workspace but Alice's supplier, or Alice's closure.
    await expect(
      as(bob, save, [tenantB, mill, null, "Bob's", "2027-03-01", "2027-03-02"]),
    ).rejects.toThrow(/Supplier not found/);
    await expect(
      as(bob, save, [tenantB, clay, alices, "Bob's", "2027-03-01", "2027-03-02"]),
    ).rejects.toThrow(/Closure not found/);
    await expect(as(bob, "select public.remove_supplier_closure($1)", [alices])).rejects.toThrow(
      /Closure not found/,
    );
    expect(await closuresOf(alice, tenantA)).toHaveLength(3);
    expect((await closuresOf(alice, tenantA))[0].name).toBe("Spring Festival");
  });

  it("a manager takes one off, once", async () => {
    const [{ id }] = await as<{ id: string }>(
      alice,
      "select id from public.supplier_closures where tenant_id = $1 and name = 'Stocktake'",
      [tenantA],
    );
    await as(alice, "select public.remove_supplier_closure($1)", [id]);
    expect((await closuresOf(alice, tenantA)).map((c) => c.name)).toEqual([
      "Spring Festival",
      "Summer break",
    ]);
    await expect(as(alice, "select public.remove_supplier_closure($1)", [id])).rejects.toThrow(
      /Closure not found/,
    );
  });

  it("keeps at most forty for one supplier", async () => {
    const busy = await supplier(alice, tenantA, "Busy Mill");
    for (let n = 0; n < 40; n++) {
      const day = `2028-${String(1 + (n % 12)).padStart(2, "0")}-${String(1 + Math.floor(n / 12) * 3).padStart(2, "0")}`;
      await as(alice, save, [tenantA, busy, null, `Day off ${n}`, day, day]);
    }
    await expect(
      as(alice, save, [tenantA, busy, null, "One more", "2028-12-30", "2028-12-30"]),
    ).rejects.toThrow(/too_many_closures/);
  });
});
