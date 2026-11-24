import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, createTestDb, createUser } from "./harness";

/**
 * Supplier balances: who ticked "Paid" on a bill, and that the ledger an
 * invoice's page reads stays with the owners and admins of its own workspace.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let dana: User; // admin of A
let carol: User; // plain member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;
let mill: string;
let bobMill: string;
let invoice: string;

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
const newSupplier = (user: User, tenant: string, name: string) =>
  as<{ id: string }>(
    user,
    "select public.save_supplier($1, null, $2, 'orders@mill.test', 21, 45, 1, 'order', '') as id",
    [tenant, name],
  ).then((rows) => rows[0].id);
const tick = (user: User, tenant: string, entry: string, paid: boolean) =>
  as(user, "select public.mark_bill_paid($1, $2, $3)", [tenant, entry, paid]);
const mark = async (entry: string) =>
  (
    await db.query<{ at: string | null; by: string | null }>(
      "select payment_sent_at::text as at, payment_sent_by as by from public.supplier_ledger where id = $1",
      [entry],
    )
  ).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  dana = { id: await createUser(db, "dana@a.test"), email: "dana@a.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'member')",
    [tenantA, dana.id, carol.id],
  );
  mill = await newSupplier(alice, tenantA, "Hill Mill");
  bobMill = await newSupplier(bob, tenantB, "Clay Yard");
  const rows = await as<{ id: string }>(
    alice,
    "select public.save_ledger_entry($1, $2, 'invoice', '2026-10-27', 482.53, null, 'INV-2041', '') as id",
    [tenantA, mill],
  );
  invoice = rows[0].id;
  await as(
    bob,
    "select public.save_ledger_entry($1, $2, 'invoice', '2026-10-27', 90, null, 'CY-7', '')",
    [tenantB, bobMill],
  );
});

describe("who ticked Paid on a bill", () => {
  it("starts empty", async () => {
    expect(await mark(invoice)).toEqual({ at: null, by: null });
  });

  it("remembers the person and the time of the first tick", async () => {
    await tick(dana, tenantA, invoice, true);
    const first = await mark(invoice);
    expect(first.by).toBe(dana.id);
    expect(first.at).not.toBeNull();
    // Ticking again, by someone else, changes neither.
    await tick(alice, tenantA, invoice, true);
    expect(await mark(invoice)).toEqual(first);
  });

  it("clears both when the tick is taken off, and takes the next person's", async () => {
    await tick(alice, tenantA, invoice, false);
    expect(await mark(invoice)).toEqual({ at: null, by: null });
    await tick(alice, tenantA, invoice, true);
    expect((await mark(invoice)).by).toBe(alice.id);
  });

  it("never moves the balance: the amount and the entry stay as they were", async () => {
    const { rows } = await db.query<{ amount: string; type: string }>(
      "select amount::text, type from public.supplier_ledger where id = $1",
      [invoice],
    );
    expect(rows).toEqual([{ amount: "482.53", type: "invoice" }]);
  });

  it("only ticks invoices", async () => {
    const [{ id }] = await as<{ id: string }>(
      alice,
      "select public.save_ledger_entry($1, $2, 'payment', '2026-11-02', 50, null, 'wire 1', '') as id",
      [tenantA, mill],
    );
    await expect(tick(alice, tenantA, id, true)).rejects.toThrow(/Entry not found/);
    expect(await mark(id)).toEqual({ at: null, by: null });
  });

  it("is for owners and admins of that workspace only", async () => {
    await expect(tick(carol, tenantA, invoice, false)).rejects.toThrow();
    await expect(tick(bob, tenantA, invoice, false)).rejects.toThrow();
    // Naming his own workspace doesn't reach across either.
    await expect(tick(bob, tenantB, invoice, false)).rejects.toThrow(/Entry not found/);
    await expect(
      asAnon(db, (tx) =>
        tx.query("select public.mark_bill_paid($1, $2, true)", [tenantA, invoice]),
      ),
    ).rejects.toThrow(/permission denied/);
    expect((await mark(invoice)).by).toBe(alice.id);
  });

  it("keeps the tick when the person who made it leaves, without their name", async () => {
    const gone = { id: await createUser(db, "gone@a.test"), email: "gone@a.test" };
    await db.query(
      "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'admin')",
      [tenantA, gone.id],
    );
    const [{ id }] = await as<{ id: string }>(
      alice,
      "select public.save_ledger_entry($1, $2, 'invoice', '2026-11-05', 146.79, null, 'INV-2077', '') as id",
      [tenantA, mill],
    );
    await tick(gone, tenantA, id, true);
    expect((await mark(id)).by).toBe(gone.id);
    await db.query("delete from public.memberships where user_id = $1", [gone.id]);
    await db.query("delete from auth.users where id = $1", [gone.id]);
    const after = await mark(id);
    expect(after.by).toBeNull();
    expect(after.at).not.toBeNull();
  });
});

describe("reading the ledger", () => {
  const read = (user: User, tenant: string) =>
    as<{ reference: string; by: string | null }>(
      user,
      "select reference, payment_sent_by as by from public.supplier_ledger where tenant_id = $1 order by reference",
      [tenant],
    );

  it("shows managers their own workspace's entries, with who ticked them", async () => {
    const rows = await read(dana, tenantA);
    expect(rows.map((r) => r.reference)).toEqual(["INV-2041", "INV-2077", "wire 1"]);
    expect(rows[0].by).toBe(alice.id);
  });

  it("shows a plain member nothing, and another workspace nothing", async () => {
    expect(await read(carol, tenantA)).toEqual([]);
    expect(await read(bob, tenantA)).toEqual([]);
    expect((await read(bob, tenantB)).map((r) => r.reference)).toEqual(["CY-7"]);
    expect(await read(alice, tenantB)).toEqual([]);
  });

  it("can't be written to directly, so who ticked can't be faked", async () => {
    await expect(
      as(alice, "update public.supplier_ledger set payment_sent_by = $1 where id = $2", [
        dana.id,
        invoice,
      ]),
    ).rejects.toThrow(/permission denied/);
  });

  it("opens one entry by its id only inside its own workspace", async () => {
    const one = (user: User, tenant: string) =>
      as(user, "select 1 from public.supplier_ledger where tenant_id = $1 and id = $2", [
        tenant,
        invoice,
      ]);
    expect(await one(alice, tenantA)).toHaveLength(1);
    expect(await one(bob, tenantA)).toEqual([]);
    expect(await one(bob, tenantB)).toEqual([]);
  });
});
