import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Row = {
  id: string;
  service: string;
  seats_left: number;
  product_url: string | null;
  location: string | null;
};

let db: PGlite;
let alice: User;
let bob: User;
let tenantA: string;
let tenantB: string;
let n = 0;

const soon = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);

async function tenantFor(owner: User, name: string): Promise<string> {
  const rows = await as<{ id: string }>(
    owner,
    "select id from public.create_tenant($1, 'America/New_York', 'USD')",
    [name],
  );
  return rows[0].id;
}

async function workshop(owner: User, tenant: string, capacity: number, product: string | null) {
  n += 1;
  const rows = await as<{ id: string }>(
    owner,
    "select public.save_service($1, null, 'workshop', $2, '', 120, 0, $3, true) as id",
    [tenant, `Workshop ${n}`, capacity],
  );
  if (product) {
    await as(owner, "select public.set_service_shop_product($1, $2, null)", [rows[0].id, product]);
  }
  return rows[0].id;
}

async function date(owner: User, serviceId: string, hours: number): Promise<string> {
  const rows = await as<{ id: string }>(owner, "select public.add_session($1, $2, null) as id", [
    serviceId,
    soon(hours),
  ]);
  return rows[0].id;
}

async function book(tenant: string, session: string, seats: number) {
  n += 1;
  await service(
    "select public.book_from_shop($1, $2, $3, $4, 'Sam', 'sam@example.com', $5, 9000, $6)",
    [tenant, session, `order-${n}`, `#${n}`, seats, `shop-token-${n}`],
  );
}

const upcoming = (tenant: string, cutoff = 12, limit = 12) =>
  service<{ r: Row[] }>("select public.shop_upcoming_classes($1, $2, $3) as r", [
    tenant,
    cutoff,
    limit,
  ]).then((rows) => rows[0].r);

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
});

describe("the upcoming classes list", () => {
  it("lists only open, public, future dates with a place left, of shop-sold workshops", async () => {
    const rugs = await workshop(alice, tenantA, 4, "7001");
    const notInShop = await workshop(alice, tenantA, 4, null);
    const open = await date(alice, rugs, 72);
    const later = await date(alice, rugs, 96);
    const full = await date(alice, rugs, 120);
    const closed = await date(alice, rugs, 144);
    const hidden = await date(alice, rugs, 168);
    const cancelled = await date(alice, rugs, 192);
    const tooSoon = await date(alice, rugs, 6);
    await date(alice, notInShop, 72);
    await book(tenantA, open, 3);
    await book(tenantA, full, 4);
    await as(alice, "select public.update_session($1, 4, true, false, '')", [closed]);
    await as(alice, "select public.update_session($1, 4, false, true, '')", [hidden]);
    await as(alice, "select public.cancel_session($1)", [cancelled]);
    await db.query(
      `insert into public.stock_items (tenant_id, provider, external_id, product_external_id, title, product_url)
       values ($1, 'shopify', 'v-1', '7001', 'Rug tufting', 'https://shop.example/products/rugs')`,
      [tenantA],
    );

    const rows = await upcoming(tenantA);
    expect(rows.map((r) => r.id)).toEqual([open, later]);
    expect(rows[0]).toMatchObject({
      seats_left: 1,
      product_url: "https://shop.example/products/rugs",
    });
    expect(rows.map((r) => r.id)).not.toContain(tooSoon);
    // A shorter cut-off brings the near date in; the limit is kept.
    const near = await upcoming(tenantA, 0, 1);
    expect(near.map((r) => r.id)).toEqual([tooSoon]);
  });

  it("never shows another workspace's dates or a link that isn't https", async () => {
    const pots = await workshop(bob, tenantB, 6, "8001");
    const bobs = await date(bob, pots, 72);
    await db.query(
      `insert into public.stock_items (tenant_id, provider, external_id, product_external_id, title, product_url)
       values ($1, 'shopify', 'v-2', '7001', 'Not Alice''s', 'https://elsewhere.example/products/x')`,
      [tenantB],
    );
    const a = await upcoming(tenantA);
    expect(a.map((r) => r.id)).not.toContain(bobs);
    expect(a.every((r) => r.product_url !== "https://elsewhere.example/products/x")).toBe(true);
    const b = await upcoming(tenantB);
    expect(b.map((r) => r.id)).toEqual([bobs]);
    expect(b[0].product_url).toBeNull();
  });

  it("is for the server only", async () => {
    await expect(as(alice, "select public.shop_upcoming_classes($1)", [tenantA])).rejects.toThrow(
      /permission denied/i,
    );
    await expect(
      asAnon(db, (tx) => tx.query("select public.shop_upcoming_classes($1)", [tenantA])),
    ).rejects.toThrow(/permission denied/i);
  });
});
