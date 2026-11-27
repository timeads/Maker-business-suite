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

describe("Stock's and Shipping's Not now, for the tool's whole team", () => {
  let erin: User; // plain member of A with only Shipping, once tools are chosen per person

  const say = (user: User, tool: string, item: string) =>
    as(user, "select public.say_setup_not_now($1, $2, $3, 'f1')", [tenantA, tool, item]);
  const seen = async (user: User) =>
    (await rows(user)).map((r) => r.item).filter((item) => item.startsWith("t."));

  beforeAll(async () => {
    erin = { id: await createUser(db, "erin@a.test"), email: "erin@a.test" };
    await db.query(
      "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
      [tenantA, erin.id],
    );
    await say(alice, "stock", "t.stock");
    await say(alice, "shipping", "t.shipping");
    await say(alice, "money", "t.money");
    await as(bob, "select public.say_setup_not_now($1, 'stock', 't.other', 'f1')", [tenantB]);
  });

  it("is read by every member who has the tool, never Money's", async () => {
    expect(await seen(carol)).toEqual(["t.shipping", "t.stock"]);
    expect(await seen(alice)).toEqual(["t.money", "t.shipping", "t.stock"]);
  });

  it("follows the tools a member was given once the workspace chooses per person", async () => {
    await as(alice, "select public.set_tools_per_person($1, true, $2::text[])", [tenantA, []]);
    await as(alice, "select public.set_member_tools($1, $2, $3::text[])", [
      tenantA,
      erin.id,
      ["shipping"],
    ]);
    expect(await seen(erin)).toEqual(["t.shipping"]);
    expect(await seen(carol)).toEqual([]);
    // Owners and admins still read every tool's.
    expect(await seen(dan)).toEqual(["t.money", "t.shipping", "t.stock"]);
  });

  it("is still said only by owners and admins, and never crosses workspaces", async () => {
    await expect(say(erin, "shipping", "t.mine")).rejects.toThrow(/owners and admins/i);
    expect((await rows(erin)).every((r) => r.tenant_id === tenantA)).toBe(true);
    expect((await rows(bob)).map((r) => r.item)).toEqual(["budget", "t.other"]);
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

describe("Bookings', Help desk's and Social's Not now, for the tool's whole team", () => {
  let fay: User; // plain member of A with only Bookings, once tools are chosen per person

  const say = (user: User, tool: string, item: string) =>
    as(user, "select public.say_setup_not_now($1, $2, $3, 'f1')", [tenantA, tool, item]);
  const seen = async (user: User) =>
    (await rows(user)).map((r) => r.item).filter((item) => item.startsWith("u."));

  beforeAll(async () => {
    fay = { id: await createUser(db, "fay@a.test"), email: "fay@a.test" };
    await db.query(
      "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
      [tenantA, fay.id],
    );
    // The earlier block chose tools per person; give Fay Bookings only.
    await as(alice, "select public.set_member_tools($1, $2, $3::text[])", [
      tenantA,
      fay.id,
      ["bookings"],
    ]);
    await say(alice, "bookings", "u.bookings");
    await say(alice, "helpdesk", "u.helpdesk");
    await say(alice, "social", "u.social");
    await say(alice, "money", "u.money");
    await as(bob, "select public.say_setup_not_now($1, 'social', 'u.other', 'f1')", [tenantB]);
  });

  it("is read by a member only for the tools they were given, never Money's", async () => {
    expect(await seen(fay)).toEqual(["u.bookings"]);
    expect(await seen(dan)).toEqual(["u.bookings", "u.helpdesk", "u.money", "u.social"]);
  });

  it("is read by every member while tools aren't chosen per person", async () => {
    await as(alice, "select public.set_tools_per_person($1, false, $2::text[])", [tenantA, []]);
    expect(await seen(carol)).toEqual(["u.bookings", "u.helpdesk", "u.social"]);
  });

  it("is still said only by owners and admins, and never crosses workspaces", async () => {
    await expect(say(fay, "bookings", "u.mine")).rejects.toThrow(/owners and admins/i);
    expect((await rows(fay)).every((r) => r.tenant_id === tenantA)).toBe(true);
    expect((await rows(carol)).map((r) => r.item)).not.toContain("u.other");
  });
});
