import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, createUser } from "./harness";

/**
 * Money → Orders: a range's orders with their items' facts for the line
 * rules, filtered by payment and words; cancelled and test orders left out;
 * nothing about who bought handed back; never another workspace's.
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

async function order(tenant: string, id: string, extra: Record<string, unknown> = {}) {
  const o = {
    name: `#${id}`,
    status: "PAID",
    tags: ["gift"],
    at: "2026-11-03T15:00:00Z",
    cancelled: null as string | null,
    test: false,
    ...extra,
  };
  const { rows } = await db.query<{ id: string }>(
    `insert into public.orders (tenant_id, provider, external_id, name, email, processed_at, net_sales, total, financial_status, tags, cancelled_at, is_test)
     values ($1, 'shopify', $2, $3, 'shopper@example.test', $4, 100, 110, $5, $6, $7, $8) returning id`,
    [tenant, id, o.name, o.at, o.status, o.tags, o.cancelled, o.test],
  );
  await db.query(
    `insert into public.order_lines (tenant_id, order_id, external_id, product_external_id, title, quantity, unit_price)
     values ($1, $2, $3, 'p1', 'Wool', 1, 100)`,
    [tenant, rows[0].id, `${id}-1`],
  );
}

const list = (user: User, tenant: string, status: string | null = null, q: string | null = null) =>
  asUser(
    db,
    user,
    async (tx) =>
      (
        await tx.query<Record<string, unknown>>(
          `select * from public.money_order_list($1, '2026-11-01T04:00:00Z', '2026-12-01T05:00:00Z', $2, $3)`,
          [tenant, status, q],
        )
      ).rows,
  );

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await db.query(
    `insert into public.products (tenant_id, provider, external_id, title, tags, product_type)
     values ($1, 'shopify', 'p1', 'Wool', '{yarn}', 'Supplies')`,
    [tenantA],
  );
  await order(tenantA, "1001");
  await order(tenantA, "1002", { status: "REFUNDED", tags: ["wholesale"] });
  await order(tenantA, "1003", { cancelled: "2026-11-04T00:00:00Z" });
  await order(tenantA, "1004", { test: true });
  await order(tenantA, "0999", { at: "2026-10-30T15:00:00Z" });
  await order(tenantB, "9001");
});

describe("the order list", () => {
  it("lists the range's real orders with their items' facts and no shopper", async () => {
    const rows = await list(alice, tenantA);
    expect(rows.map((r) => r.name).sort()).toEqual(["#1001", "#1002"]);
    expect(rows[0].items).toEqual([
      { product_tags: ["yarn"], product_type: "Supplies", workshop: false },
    ]);
    expect(Object.keys(rows[0])).not.toContain("email");
    expect(Number(rows[0].total_count)).toBe(2);
  });

  it("filters by payment status and by number or tag", async () => {
    expect((await list(alice, tenantA, "refunded")).map((r) => r.name)).toEqual(["#1002"]);
    expect((await list(alice, tenantA, null, "%wholesale%")).map((r) => r.name)).toEqual(["#1002"]);
    expect((await list(alice, tenantA, null, "%1001%")).map((r) => r.name)).toEqual(["#1001"]);
  });

  it("never crosses workspaces", async () => {
    expect(await list(bob, tenantA)).toEqual([]);
    expect((await list(bob, tenantB)).map((r) => r.name)).toEqual(["#9001"]);
  });
});
