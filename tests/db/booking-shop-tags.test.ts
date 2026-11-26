import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { STANDARD_TAGS } from "../../src/lib/bookings/shop-tags";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Bookings' order tags in the shop, in the database:
 *   - queued once per order and reason, only for a shop that may change orders;
 *   - the words are the workspace's own, else the earlier app's;
 *   - switched off, nothing is queued;
 *   - claimed once, finished once, and a claim never finished is failed, not retried;
 *   - nobody but the worker can queue or claim, and no workspace sees another's.
 */
type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A, whose shop allows changing orders
let bob: User; // owner of B, whose shop doesn't
let tenantA: string;
let tenantB: string;

const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);

async function tenantFor(owner: User, name: string): Promise<string> {
  const rows = await as<{ id: string }>(
    owner,
    "select id from public.create_tenant($1, 'America/New_York', 'USD')",
    [name],
  );
  return rows[0].id;
}

const connect = (tenant: string, owner: User, scopes: string[]) =>
  service(
    "select public.save_connection($1, 'shopify', $2, 'Shop', $3::text[], $4::jsonb, $5, '{}'::jsonb)",
    [
      tenant,
      `${tenant.slice(0, 8)}.myshopify.com`,
      scopes,
      JSON.stringify({ access_token: "fake-shop-token" }),
      owner.id,
    ],
  );

const queue = async (tenant: string, order: string, reason: string) =>
  (
    await service<{ r: string }>(
      "select public.queue_shop_order_tag($1, 'shopify', $2, $3, $4) as r",
      [tenant, order, `#${order}`, reason],
    )
  )[0].r;

type Claimed = {
  id: string;
  tenant_id: string;
  shop_order_id: string;
  tag: string;
  can_write: boolean;
};
const claim = () => service<Claimed>("select * from public.claim_shop_order_tags(20)");

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@example.com"), email: "alice@example.com" };
  bob = { id: await createUser(db, "bob@example.com"), email: "bob@example.com" };
  tenantA = await tenantFor(alice, "Alice Studio");
  tenantB = await tenantFor(bob, "Bob Studio");
  await connect(tenantA, alice, ["read_orders", "write_orders"]);
  await connect(tenantB, bob, ["read_orders", "read_products"]);
});

describe("order tags in the shop", () => {
  it("uses the earlier app's words unless the workspace chose its own", async () => {
    // As the database's owner: the helper is private.
    const { rows: standard } = await db.query<{ reason: string; tag: string }>(
      `select r as reason, private.shop_tag_for($1, r) as tag
       from unnest(array['oversold', 'needs_date', 'booking_error']) r`,
      [tenantB],
    );
    expect(Object.fromEntries(standard.map((row) => [row.reason, row.tag]))).toEqual(STANDARD_TAGS);
  });

  it("queues each reason once per order, only for a shop that may change orders", async () => {
    expect(await queue(tenantA, "5001", "oversold")).toBe("queued");
    expect(await queue(tenantA, "5001", "oversold")).toBe("already");
    expect(await queue(tenantA, "5001", "booking_error")).toBe("queued");
    // A shop without permission gets nothing queued at all.
    expect(await queue(tenantB, "5001", "oversold")).toBe("not_allowed");
    const rows = await service<{ tenant_id: string; reason: string; tag: string; status: string }>(
      "select tenant_id, reason, tag, status from public.shop_order_tags order by reason",
    );
    expect(rows).toEqual([
      { tenant_id: tenantA, reason: "booking_error", tag: "ttw-booking-error", status: "pending" },
      { tenant_id: tenantA, reason: "oversold", tag: "ttw-oversold", status: "pending" },
    ]);
    await expect(queue(tenantA, "5001", "something")).rejects.toThrow(/Unknown reason/);
  });

  it("follows the workspace's words and its switch", async () => {
    await as(alice, "select public.save_config($1, 'bookings', 'shop_tags', $2::jsonb)", [
      tenantA,
      JSON.stringify({ version: 1, on: true, tags: { needs_date: "date-please" } }),
    ]);
    expect(await queue(tenantA, "5002", "needs_date")).toBe("queued");
    const [row] = await service<{ tag: string }>(
      "select tag from public.shop_order_tags where shop_order_id = '5002'",
    );
    expect(row.tag).toBe("date-please");

    await as(alice, "select public.save_config($1, 'bookings', 'shop_tags', $2::jsonb)", [
      tenantA,
      JSON.stringify({ version: 1, on: false }),
    ]);
    expect(await queue(tenantA, "5003", "oversold")).toBe("off");
    await as(alice, "select public.save_config($1, 'bookings', 'shop_tags', $2::jsonb)", [
      tenantA,
      JSON.stringify({ version: 1, on: true }),
    ]);
  });

  it("hands each tag to one worker once, and writes down how it went", async () => {
    const first = await claim();
    expect(first.map((row) => row.shop_order_id).sort()).toEqual(["5001", "5001", "5002"]);
    expect(first.every((row) => row.can_write && row.tenant_id === tenantA)).toBe(true);
    expect(await claim()).toEqual([]);

    const [done, refused] = first;
    await service("select public.finish_shop_order_tag($1, 'done')", [done.id]);
    await service("select public.finish_shop_order_tag($1, 'failed', 'The shop said no')", [
      refused.id,
    ]);
    // A second finish changes nothing.
    await service("select public.finish_shop_order_tag($1, 'failed', 'late')", [done.id]);
    const rows = await service<{ id: string; status: string; error: string | null }>(
      "select id, status, error from public.shop_order_tags where id = any($1)",
      [[done.id, refused.id]],
    );
    expect(rows.find((row) => row.id === done.id)).toMatchObject({ status: "done", error: null });
    expect(rows.find((row) => row.id === refused.id)).toMatchObject({
      status: "failed",
      error: "The shop said no",
    });
    // A failure is never handed out again by itself.
    expect(await claim()).toEqual([]);
  });

  it("marks a claim nobody finished as failed, never tried again", async () => {
    const [left] = atLeastOne(
      await service<{ id: string }>(
        "select id from public.shop_order_tags where status = 'sending'",
      ),
    );
    await service(
      "update public.shop_order_tags set claimed_at = now() - interval '20 minutes' where id = $1",
      [left.id],
    );
    expect(await claim()).toEqual([]);
    const [row] = await service<{ status: string; error: string }>(
      "select status, error from public.shop_order_tags where id = $1",
      [left.id],
    );
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/lost touch/);
  });

  it("tells the worker when the shop's permission went after queueing", async () => {
    expect(await queue(tenantA, "5009", "oversold")).toBe("queued");
    await connect(tenantA, alice, ["read_orders"]);
    const [row] = await claim();
    expect(row.can_write).toBe(false);
    await connect(tenantA, alice, ["read_orders", "write_orders"]);
  });

  it("is only the worker's to queue and claim, and each workspace sees only its own", async () => {
    await expect(
      as(alice, "select public.queue_shop_order_tag($1, 'shopify', '1', '#1', 'oversold')", [
        tenantA,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(as(alice, "select * from public.claim_shop_order_tags(5)")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asAnon(db, (tx) => tx.query("select * from public.shop_order_tags")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(
        alice,
        "insert into public.shop_order_tags (tenant_id, shop_order_id, reason, tag) values ($1, '1', 'oversold', 'x')",
        [tenantA],
      ),
    ).rejects.toThrow(/permission denied/);
    expect((await as(alice, "select id from public.shop_order_tags")).length).toBeGreaterThan(0);
    expect(await as(bob, "select id from public.shop_order_tags")).toEqual([]);
  });
});

function atLeastOne<T>(rows: T[]): T[] {
  expect(rows.length).toBeGreaterThan(0);
  return rows;
}
