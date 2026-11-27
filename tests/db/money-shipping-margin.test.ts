import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, createUser } from "./harness";

/**
 * Shipping margin by month: each order once, in the month its first parcel
 * went, what the shopper paid against every parcel's postage; voided
 * parcels, cancelled orders and other workspaces never count.
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

let number = 0;
async function order(tenant: string, id: string, shipping: string, cancelled = false) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.orders (tenant_id, provider, external_id, processed_at, total_shipping, cancelled_at)
     values ($1, 'shopify', $2, '2026-09-30T12:00:00Z', $3, $4) returning id`,
    [tenant, id, shipping, cancelled ? "2026-10-02T00:00:00Z" : null],
  );
  const so = await db.query<{ id: string }>(
    `insert into public.shipping_orders (tenant_id, order_id, provider, external_id, placed_at)
     values ($1, $2, 'shopify', $3, '2026-09-30T12:00:00Z') returning id`,
    [tenant, rows[0].id, id],
  );
  return so.rows[0].id;
}

async function parcel(
  tenant: string,
  shippingOrder: string,
  at: string,
  cost: string | null,
  voided = false,
) {
  number += 1;
  await db.query(
    `insert into public.shipments (tenant_id, number, shipping_order_id, carrier, cost, shipped_at, voided_at)
     values ($1, $2, $3, 'USPS', $4, $5, $6)`,
    [tenant, number, shippingOrder, cost, at, voided ? at : null],
  );
}

const margin = (user: User, tenant: string) =>
  asUser(
    db,
    user,
    async (tx) =>
      (
        await tx.query<{
          month: string;
          orders: string;
          collected_cents: string;
          cost_cents: string;
          costed: string;
        }>(
          `select month::text, orders::text, collected_cents::text, cost_cents::text, costed::text
         from public.money_shipping_by_month($1, '2026-01-01T05:00:00Z', '2027-01-01T05:00:00Z', 'America/New_York')`,
          [tenant],
        )
      ).rows,
  );

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  // Two boxes, the second in the next month: counted once, in October.
  const two = await order(tenantA, "1", "15.00");
  await parcel(tenantA, two, "2026-10-31T23:30:00-04:00", "9.50");
  await parcel(tenantA, two, "2026-11-02T10:00:00-05:00", "8.00");
  // A label voided and bought again.
  const again = await order(tenantA, "2", "10.00");
  await parcel(tenantA, again, "2026-11-03T10:00:00-05:00", "7.00", true);
  await parcel(tenantA, again, "2026-11-03T11:00:00-05:00", "7.25");
  // No cost noted.
  const free = await order(tenantA, "3", "5.00");
  await parcel(tenantA, free, "2026-11-04T10:00:00-05:00", null);
  // A cancelled order never counts.
  const gone = await order(tenantA, "4", "20.00", true);
  await parcel(tenantA, gone, "2026-11-05T10:00:00-05:00", "4.00");
  const theirs = await order(tenantB, "9", "99.00");
  await parcel(tenantB, theirs, "2026-11-05T10:00:00-05:00", "1.00");
});

describe("shipping margin by month", () => {
  it("counts each order once in its first parcel's month, in the workspace's timezone", async () => {
    expect(await margin(alice, tenantA)).toEqual([
      {
        month: "2026-10-01",
        orders: "1",
        collected_cents: "1500",
        cost_cents: "1750",
        costed: "1",
      },
      { month: "2026-11-01", orders: "2", collected_cents: "1500", cost_cents: "725", costed: "1" },
    ]);
  });

  it("never crosses workspaces", async () => {
    expect(await margin(bob, tenantA)).toEqual([]);
    expect((await margin(bob, tenantB)).map((r) => r.collected_cents)).toEqual(["9900"]);
  });
});
