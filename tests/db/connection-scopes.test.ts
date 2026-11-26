import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };

let db: PGlite;
let alice: User;
let bob: User;
let tenantA: string;
let tenantB: string;

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'UTC', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

function service<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function connect(tenantId: string, account: string, by: User, metadata: object) {
  const rows = await service<{ id: string }>(
    `select public.save_connection($1, 'shopify', $2, 'A store', array['read_orders'],
       '{"access_token":"not-a-real-token"}'::jsonb, $3, $4::jsonb) as id`,
    [tenantId, account, by.id, JSON.stringify(metadata)],
  );
  return rows[0].id;
}

const scopesOf = async (id: string) =>
  (
    await service<{ scopes: string[]; metadata: Record<string, unknown> }>(
      "select scopes, metadata from public.connections where id = $1",
      [id],
    )
  )[0];

/** The database's own gates, asked as the database itself (they are private). */
const gates = async (tenantId: string) =>
  (
    await db.query<{ tag: boolean; fulfil: boolean }>(
      "select private.shop_can_tag_orders($1) as tag, private.shop_can_fulfil($1) as fulfil",
      [tenantId],
    )
  ).rows[0];

const record = (tenantId: string, id: string, scopes: string[]) =>
  service("select public.record_granted_scopes($1, $2, $3)", [tenantId, id, scopes]);

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
});

describe("recording what a store really granted", () => {
  it("replaces the scopes on record with the store's answer, and notes when it was asked", async () => {
    const conn = await connect(tenantA, "alice.myshopify.com", alice, { currency: "USD" });
    await record(tenantA, conn, ["write_orders", "read_orders", "read_orders", "bad scope!"]);
    const after = await scopesOf(conn);
    expect(after.scopes).toEqual(["read_orders", "write_orders"]);
    expect(after.metadata.scopes_checked_at).toBeTruthy();
    expect(after.metadata.currency).toBe("USD");
    // The gates follow at once.
    expect((await gates(tenantA)).tag).toBe(true);

    // Taken back in the shop: the next look takes it away here too.
    await record(tenantA, conn, ["read_orders"]);
    expect((await scopesOf(conn)).scopes).toEqual(["read_orders"]);
    expect((await gates(tenantA)).tag).toBe(false);
  });

  it("never lets a watch-only connection hold a write scope", async () => {
    const conn = await connect(tenantB, "bob.myshopify.com", bob, { watch_only: true });
    await record(tenantB, conn, [
      "read_orders",
      "write_orders",
      "write_merchant_managed_fulfillment_orders",
      "read_inventory",
    ]);
    expect((await scopesOf(conn)).scopes).toEqual(["read_inventory", "read_orders"]);
    expect(await gates(tenantB)).toEqual({ tag: false, fulfil: false });
  });

  it("only touches the named workspace's connection", async () => {
    const [{ id }] = await service<{ id: string }>(
      "select id from public.connections where tenant_id = $1",
      [tenantA],
    );
    await record(tenantB, id, ["write_orders"]);
    expect((await scopesOf(id)).scopes).toEqual(["read_orders"]);
  });

  it("can't be called by a member", async () => {
    const [{ id }] = await service<{ id: string }>(
      "select id from public.connections where tenant_id = $1",
      [tenantA],
    );
    await expect(
      asUser(db, alice, (tx) =>
        tx.query("select public.record_granted_scopes($1, $2, array['write_orders'])", [
          tenantA,
          id,
        ]),
      ),
    ).rejects.toThrow();
  });
});
