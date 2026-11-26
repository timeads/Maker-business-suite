import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * What Money's business lines need from the shop: order tags, product tags
 * and each item's class date, kept through the one sync write path, and the
 * once-only backfill that reads a shop's history again for them.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User;
let bob: User;
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

function service<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}

function load(tenantId: string, orders: unknown[], products: unknown[] = []) {
  return service(
    "select public.upsert_commerce_batch($1, 'shopify', '[]'::jsonb, $2::jsonb, $3::jsonb)",
    [tenantId, JSON.stringify(products), JSON.stringify(orders)],
  );
}

const SESSION = "6f1c2b3a-1111-4222-8333-444455556666";

function order(id: string, extra: Record<string, unknown> = {}, lines?: unknown[]) {
  return {
    external_id: id,
    name: `#${id}`,
    customer_external_id: "cust-1",
    email: "shopper@example.com",
    processed_at: "2026-11-10T15:00:00Z",
    currency: "USD",
    net_sales: 100,
    total: 108,
    channel: "Online Store",
    lines: lines ?? [
      {
        external_id: "l1",
        product_external_id: "p1",
        title: "Class",
        quantity: 1,
        unit_price: 100,
        session_ref: SESSION,
        class_date: "2026-12-05",
      },
      {
        external_id: "l2",
        title: "Odd line",
        quantity: 1,
        unit_price: 0,
        session_ref: "not-an-id",
        class_date: "2026-02-30",
      },
    ],
    ...extra,
  };
}

const storedOrder = async (tenant: string, id: string) =>
  (
    await db.query<{ tags: string[] | null }>(
      "select tags from public.orders where tenant_id = $1 and external_id = $2",
      [tenant, id],
    )
  ).rows[0];
const storedLines = async (tenant: string, id: string) =>
  (
    await db.query<{ external_id: string; session_ref: string | null; class_date: string | null }>(
      `select l.external_id, l.session_ref::text, l.class_date::text from public.order_lines l
       join public.orders o on o.id = l.order_id
       where o.tenant_id = $1 and o.external_id = $2 order by l.external_id`,
      [tenant, id],
    )
  ).rows;

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
});

describe("keeping what the business lines need", () => {
  it("stores the order's tags, the product's tags and each item's date, tidied", async () => {
    await load(
      tenantA,
      [order("2001", { tags: [" Workshop ", "", "gift"] })],
      [{ external_id: "p1", title: "Class", tags: ["teaching", "  "] }],
    );
    expect((await storedOrder(tenantA, "2001")).tags).toEqual(["Workshop", "gift"]);
    const { rows } = await db.query<{ tags: string[] }>(
      "select tags from public.products where tenant_id = $1 and external_id = 'p1'",
      [tenantA],
    );
    expect(rows[0].tags).toEqual(["teaching"]);
    // A date's id only when it has the shape of one; an impossible date is no date.
    expect(await storedLines(tenantA, "2001")).toEqual([
      { external_id: "l1", session_ref: SESSION, class_date: "2026-12-05" },
      { external_id: "l2", session_ref: null, class_date: null },
    ]);
  });

  it("keeps what's stored when a worker on earlier code rewrites the order", async () => {
    // The earlier sender sends no tags and no item dates at all.
    await load(
      tenantA,
      [
        order("2001", {}, [
          {
            external_id: "l1",
            product_external_id: "p1",
            title: "Class",
            quantity: 1,
            unit_price: 90,
          },
        ]),
      ],
      [{ external_id: "p1", title: "Class renamed" }],
    );
    expect((await storedOrder(tenantA, "2001")).tags).toEqual(["Workshop", "gift"]);
    expect(await storedLines(tenantA, "2001")).toEqual([
      { external_id: "l1", session_ref: SESSION, class_date: "2026-12-05" },
    ]);
    const { rows } = await db.query<{ tags: string[]; title: string }>(
      "select tags, title from public.products where tenant_id = $1 and external_id = 'p1'",
      [tenantA],
    );
    expect(rows[0]).toEqual({ tags: ["teaching"], title: "Class renamed" });
  });

  it("clears them when the current sender says there are none", async () => {
    await load(tenantA, [
      order("2001", { tags: [] }, [
        {
          external_id: "l1",
          title: "Class",
          quantity: 1,
          unit_price: 90,
          session_ref: null,
          class_date: null,
        },
      ]),
    ]);
    expect((await storedOrder(tenantA, "2001")).tags).toEqual([]);
    expect(await storedLines(tenantA, "2001")).toEqual([
      { external_id: "l1", session_ref: null, class_date: null },
    ]);
  });

  it("leaves orders synced before this without tags, not with an empty list", async () => {
    await db.query(
      `insert into public.orders (tenant_id, provider, external_id, processed_at)
       values ($1, 'shopify', 'old-1', now())`,
      [tenantA],
    );
    expect((await storedOrder(tenantA, "old-1")).tags).toBeNull();
  });
});

describe("a shopper forgotten", () => {
  it("keeps only the tags the workspace's line rules look for", async () => {
    await asUser(db, alice, (tx) =>
      tx.query("select public.save_config($1, 'dashboard', 'revenue', $2::jsonb)", [
        tenantA,
        JSON.stringify({
          version: 1,
          lines: [
            { id: "shop", name: "Shop" },
            { id: "classes", name: "Classes" },
          ],
          default_line: "shop",
          rules: [
            { id: "r1", match: "order_tag", words: ["private workshop"], line: "classes" },
            { id: "r2", match: "product_tag", words: ["vip"], line: "classes" },
          ],
        }),
      ]),
    );
    await load(tenantA, [
      order("2002", { tags: ["Private_Workshop", "VIP", "Sam's birthday"] }),
      order("2003", { customer_external_id: "cust-2", email: "other@example.com", tags: ["VIP"] }),
    ]);
    await service("select public.redact_customer($1, 'shopify', 'cust-1', 'shopper@example.com')", [
      tenantA,
    ]);
    // "VIP" is a product-tag word here, not an order-tag one, so it goes.
    expect((await storedOrder(tenantA, "2002")).tags).toEqual(["Private_Workshop"]);
    // Somebody else's order is untouched.
    expect((await storedOrder(tenantA, "2003")).tags).toEqual(["VIP"]);
  });
});

describe("the backfill of a shop's history", () => {
  let connA: string;
  let connB: string;

  beforeAll(async () => {
    const make = async (tenant: string, shop: string) =>
      (
        await db.query<{ id: string }>(
          `insert into public.connections (tenant_id, provider, external_account_id)
           values ($1, 'shopify', $2) returning id`,
          [tenant, shop],
        )
      ).rows[0].id;
    connA = await make(tenantA, "a.myshopify.com");
    connB = await make(tenantB, "b.myshopify.com");
  });

  const fullJobs = async (conn: string) =>
    Number(
      (
        await db.query<{ n: string }>(
          "select count(*) as n from public.sync_jobs where connection_id = $1 and type = 'full'",
          [conn],
        )
      ).rows[0].n,
    );
  const queue = async () =>
    (await service<{ n: number }>("select public.queue_commerce_detail_reads() as n"))[0].n;
  const finishJobs = (conn: string) =>
    db.query(
      "update public.sync_jobs set status = 'succeeded', finished_at = now() where connection_id = $1",
      [conn],
    );

  it("queues one full read per shop, never over a sync already waiting", async () => {
    expect(await queue()).toBe(2);
    expect(await fullJobs(connA)).toBe(1);
    expect(await fullJobs(connB)).toBe(1);
    expect(await queue()).toBe(0);
  });

  it("stops once the current code has read the shop in full", async () => {
    await finishJobs(connA);
    await service("select public.note_commerce_details_read($1, 'shopify')", [tenantA]);
    await db.query("update private.commerce_detail_reads set queued_at = now() - interval '1 day'");
    await finishJobs(connB);
    expect(await queue()).toBe(1);
    expect(await fullJobs(connA)).toBe(1);
    expect(await fullJobs(connB)).toBe(2);
  });

  it("tries a shop three times at most when the read never counts", async () => {
    for (let round = 0; round < 3; round++) {
      await finishJobs(connB);
      await db.query(
        "update private.commerce_detail_reads set queued_at = now() - interval '7 hours' where connection_id = $1",
        [connB],
      );
      await queue();
    }
    const { rows } = await db.query<{ tries: number }>(
      "select tries from private.commerce_detail_reads where connection_id = $1",
      [connB],
    );
    expect(rows[0].tries).toBe(3);
    expect(await fullJobs(connB)).toBe(3);
  });

  it("is the worker's alone: members can neither read it nor ask for it", async () => {
    for (const user of [alice, bob]) {
      await expect(
        asUser(db, user, (tx) => tx.query("select * from private.commerce_detail_reads")),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      asUser(db, alice, (tx) => tx.query("select public.queue_commerce_detail_reads()")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, bob, (tx) =>
        tx.query("select public.note_commerce_details_read($1, 'shopify')", [tenantA]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("keeps each workspace's rows apart", async () => {
    const { rows } = await db.query<{ connection_id: string; tenant_id: string }>(
      "select connection_id, tenant_id from private.commerce_detail_reads order by tenant_id",
    );
    for (const row of rows) {
      expect(row.tenant_id).toBe(row.connection_id === connA ? tenantA : tenantB);
    }
  });
});

describe("cross-tenant isolation for the new columns", () => {
  it("each workspace sees only its own orders' tags and products' tags", async () => {
    await load(
      tenantB,
      [order("9001", { tags: ["b-secret"] })],
      [{ external_id: "p9", title: "Vase", tags: ["b-only"] }],
    );
    await asUser(db, alice, async (tx) => {
      const orders = await tx.query<{ tags: string[] | null }>("select tags from public.orders");
      expect(orders.rows.flatMap((r) => r.tags ?? [])).not.toContain("b-secret");
      const products = await tx.query<{ tags: string[] | null }>(
        "select tags from public.products",
      );
      expect(products.rows.flatMap((r) => r.tags ?? [])).not.toContain("b-only");
      const lines = await tx.query<{ tenant_id: string }>(
        "select tenant_id from public.order_lines where session_ref is not null or class_date is not null",
      );
      expect(lines.rows.every((r) => r.tenant_id === tenantA)).toBe(true);
    });
  });
});
