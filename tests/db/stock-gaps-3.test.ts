import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { supplierPrefix } from "../../src/lib/stock/po/reference";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Stock, the third batch of gaps closed after the side-by-side with
 * TuftStock. This file: the name each purchase order carries. The imports,
 * carrier tracking and emailing an order each have a file of their own.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;
let rug: string;

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

const supplier = async (user: User, tenant: string, name: string) =>
  (
    await as<{ id: string }>(
      user,
      "select public.save_supplier($1, null, $2, null, 30, 30, 1, 'order', '') as id",
      [tenant, name],
    )
  )[0].id;

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  for (const [tenant, prefix] of [
    [tenantA, "a"],
    [tenantB, "b"],
  ]) {
    await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
      tenant,
      JSON.stringify([
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
      ]),
    ]);
  }
  rug = (
    await one<{ id: string }>(
      "select id from public.stock_items where tenant_id = $1 and external_id = 'a-v1'",
      [tenantA],
    )
  ).id;
}, 120_000);

describe("a purchase order's reference", () => {
  it("is given to every new order: supplier's letters, year and month, a short code", async () => {
    const hill = await supplier(alice, tenantA, "Hill Mill Yarns");
    const [{ number }] = await as<{ number: number }>(
      alice,
      "select public.create_purchase_order($1, $2, $3::jsonb, '') as number",
      [tenantA, hill, JSON.stringify([{ stock_item_id: rug, qty: 2, unit_cost: 60 }])],
    );
    const made = await one<{ reference: string; created_at: string }>(
      "select reference, created_at from public.purchase_orders where tenant_id = $1 and number = $2",
      [tenantA, number],
    );
    const month = new Date(made.created_at).toISOString().slice(0, 7).replace("-", "");
    expect(made.reference).toMatch(new RegExp(`^HI-${month}-[0-9A-F]{6}$`));

    // Drafting several at once names each one, and none twice.
    const loom = await supplier(alice, tenantA, "3 Looms");
    const [{ numbers }] = await as<{ numbers: number[] }>(
      alice,
      "select public.draft_purchase_orders($1, gen_random_uuid(), $2::jsonb) as numbers",
      [
        tenantA,
        JSON.stringify([
          { supplier_id: hill, lines: [{ stock_item_id: rug, qty: 1, unit_cost: 60 }] },
          { supplier_id: loom, lines: [{ stock_item_id: rug, qty: 1, unit_cost: 60 }] },
        ]),
      ],
    );
    const drafted = await db.query<{ reference: string }>(
      "select reference from public.purchase_orders where tenant_id = $1 and number = any($2) order by number",
      [tenantA, numbers],
    );
    expect(drafted.rows[0].reference).toMatch(/^HI-\d{6}-[0-9A-F]{6}$/);
    expect(drafted.rows[1].reference).toMatch(/^LO-\d{6}-[0-9A-F]{6}$/);
    expect(new Set([made.reference, ...drafted.rows.map((r) => r.reference)]).size).toBe(3);
  });

  it("is one of a kind inside a workspace, whatever the capitals, and free in another", async () => {
    const hill = (
      await one<{ id: string }>(
        "select id from public.suppliers where tenant_id = $1 and name = 'Hill Mill Yarns'",
        [tenantA],
      )
    ).id;
    const { reference } = await one<{ reference: string }>(
      "select reference from public.purchase_orders where tenant_id = $1 order by number limit 1",
      [tenantA],
    );
    await expect(
      db.query(
        "insert into public.purchase_orders (tenant_id, number, supplier_id, reference) values ($1, 900, $2, $3)",
        [tenantA, hill, reference.toLowerCase()],
      ),
    ).rejects.toThrow(/purchase_orders_reference_idx/);

    const pots = await supplier(bob, tenantB, "Hill Mill Yarns");
    await db.query(
      "insert into public.purchase_orders (tenant_id, number, supplier_id, reference) values ($1, 900, $2, $3)",
      [tenantB, pots, reference],
    );
    // Each workspace still reads only its own.
    expect(
      await as<{ n: number }>(
        bob,
        "select count(*)::int as n from public.purchase_orders where reference = $1",
        [reference],
      ),
    ).toEqual([{ n: 1 }]);
    // Nobody types a reference straight into the table.
    await expect(
      as(alice, "update public.purchase_orders set reference = 'MINE-1' where tenant_id = $1", [
        tenantA,
      ]),
    ).rejects.toThrow(/permission denied/);
  });

  it("uses the same letters in the database as in the app", async () => {
    for (const name of ["Kestrel Mills", "  loom & co", "3M", "毛线 Q", "1234", "", "é Yarn"]) {
      const { prefix } = await one<{ prefix: string }>(
        "select private.po_reference_prefix($1) as prefix",
        [name],
      );
      expect(prefix, name).toBe(supplierPrefix(name));
    }
  });
});
