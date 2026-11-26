import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * "Finish setting up": the only thing kept is a person's "Not now" on one
 * checklist item, with a short fingerprint of its facts. Items can be about
 * debts, so the table is for owners and admins only: a plain member reads
 * nothing and can't write, and nobody reads or writes across workspaces.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let dan: User; // admin of A
let carol: User; // plain member of A
let bob: User; // owner of B
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

const as = <T = Record<string, unknown>>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);

const notNow = (user: User, tenant: string, item: string, fingerprint: string) =>
  as(user, "select public.say_setup_not_now($1, 'money', $2, $3)", [tenant, item, fingerprint]);

const rows = (user: User) =>
  as<{ tenant_id: string; item: string; fingerprint: string }>(
    user,
    "select tenant_id, item, fingerprint from public.setup_not_now order by item",
  );

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  dan = { id: await createUser(db, "dan@a.test"), email: "dan@a.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await db.query(
    `insert into public.memberships (tenant_id, user_id, role)
     values ($1, $2, 'admin'), ($1, $3, 'member')`,
    [tenantA, dan.id, carol.id],
  );
  await notNow(alice, tenantA, "lines", "abc123");
  await notNow(dan, tenantA, "debt.rates", "f00");
  await notNow(bob, tenantB, "budget", "zz9");
});

describe("Not now", () => {
  it("is kept per workspace, once per item, and replaced when said again", async () => {
    expect(await rows(alice)).toEqual([
      { tenant_id: tenantA, item: "debt.rates", fingerprint: "f00" },
      { tenant_id: tenantA, item: "lines", fingerprint: "abc123" },
    ]);
    await notNow(alice, tenantA, "lines", "def456");
    expect((await rows(dan)).find((r) => r.item === "lines")?.fingerprint).toBe("def456");
  });

  it("is brought back by an owner or admin", async () => {
    await notNow(alice, tenantA, "budget", "b1");
    await as(dan, "select public.bring_back_setup_item($1, 'money', 'budget')", [tenantA]);
    expect((await rows(alice)).map((r) => r.item)).not.toContain("budget");
  });

  it("is never read or written by a plain member", async () => {
    expect(await rows(carol)).toEqual([]);
    await expect(notNow(carol, tenantA, "lines", "x1")).rejects.toThrow(/owners and admins/i);
    await expect(
      as(carol, "select public.bring_back_setup_item($1, 'money', 'lines')", [tenantA]),
    ).rejects.toThrow(/owners and admins/i);
    await expect(
      as(
        carol,
        "insert into public.setup_not_now (tenant_id, tool, item, fingerprint) values ($1, 'money', 'x', 'y')",
        [tenantA],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("never crosses workspaces", async () => {
    expect((await rows(bob)).map((r) => r.tenant_id)).toEqual([tenantB]);
    expect((await rows(alice)).every((r) => r.tenant_id === tenantA)).toBe(true);
    await expect(notNow(bob, tenantA, "lines", "x1")).rejects.toThrow(/owners and admins/i);
    await as(bob, "select public.bring_back_setup_item($1, 'money', 'lines')", [tenantA]).catch(
      () => null,
    );
    expect((await rows(alice)).map((r) => r.item)).toContain("lines");
  });

  it("refuses an item or fingerprint that isn't plain", async () => {
    await expect(notNow(alice, tenantA, "Lines!", "abc")).rejects.toThrow(/which item/i);
    await expect(notNow(alice, tenantA, "lines", "a real name")).rejects.toThrow(/which item/i);
  });

  it("is closed to anyone signed out", async () => {
    await expect(
      asAnon(db, (tx) => tx.query("select * from public.setup_not_now")),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("the heads-up pointing at Money → Set up", () => {
  it("is claimed once per workspace, by the worker only", async () => {
    const claim = (tenant: string) =>
      asService(
        db,
        async (tx) =>
          (
            await tx.query<{ ok: boolean }>("select public.claim_money_setup_nudge($1) as ok", [
              tenant,
            ])
          ).rows[0].ok,
      );
    expect(await claim(tenantA)).toBe(true);
    expect(await claim(tenantA)).toBe(false);
    expect(await claim(tenantB)).toBe(true);
    await expect(as(alice, "select public.claim_money_setup_nudge($1)", [tenantA])).rejects.toThrow(
      /permission denied/i,
    );
  });
});
