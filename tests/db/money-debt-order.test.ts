import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrationsAfter,
  asService,
  asUser,
  createTestDb,
  createTestDbUntil,
  createUser,
} from "./harness";

/**
 * "Your own order" for the debts is always 1..N among the debts that take a
 * place (the snowball pool's active debts, as the pages see them after a
 * plan folds the debts it pays). Moving one is an insert: the others shift.
 * Owners and admins only, and never across workspaces.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let dan: User; // admin of A
let carol: User; // plain member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;

const as = <T = Record<string, unknown>>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);

const BASE = {
  kind: "card",
  plan: "pool",
  status: "active",
  rate_bp: 1500,
  minimum_cents: 2500,
  payment_cents: null,
  revolving_bp: null,
  due_day: null,
  priority: null,
  opening_cents: null,
  books_account: null,
  note: null,
};

const save = async (
  user: User,
  tenant: string,
  fields: Record<string, unknown>,
  id: string | null = null,
) =>
  (
    await as<{ id: string }>(user, "select public.save_money_debt($1, $2, $3::jsonb) as id", [
      tenant,
      id,
      JSON.stringify({ ...BASE, ...fields }),
    ])
  )[0].id;

const move = async (user: User, tenant: string, id: string, position: number) =>
  (
    await as<{ at: number }>(user, "select public.move_money_debt($1, $2, $3) as at", [
      tenant,
      id,
      position,
    ])
  )[0].at;

/** The debts that take a place, in their order, as names. */
const order = async (tenant: string, owner: User = alice) =>
  (
    await as<{ name: string; priority: number }>(
      owner,
      `select d.name, d.priority from public.money_debts d
       where d.tenant_id = $1 and d.status = 'active' and d.plan = 'pool' and not d.consolidated
         and d.left_out_at is null
         and (d.covered_by is null or exists (select 1 from public.money_debts p
                                              where p.id = d.covered_by and p.status = 'closed'))
       order by d.priority, d.name`,
      [tenant],
    )
  ).map((r) => `${r.priority}:${r.name}`);

const ids = new Map<string, string>();

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'America/New_York', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

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
  for (const name of ["Ash", "Birch", "Cedar", "Damson", "Elm"]) {
    ids.set(name, await save(alice, tenantA, { name }));
  }
  ids.set("Other", await save(bob, tenantB, { name: "Other" }));
});

const id = (name: string) => {
  const found = ids.get(name);
  if (!found) throw new Error(`no debt ${name}`);
  return found;
};

describe("your own order", () => {
  it("gives new debts the next place", async () => {
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Birch", "3:Cedar", "4:Damson", "5:Elm"]);
    expect(await order(tenantB, bob)).toEqual(["1:Other"]);
  });

  it("moves a debt up, shifting the ones it passes down", async () => {
    expect(await move(alice, tenantA, id("Damson"), 2)).toBe(2);
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Damson", "3:Birch", "4:Cedar", "5:Elm"]);
  });

  it("moves a debt down, shifting the ones it passes up", async () => {
    expect(await move(dan, tenantA, id("Damson"), 4)).toBe(4);
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Birch", "3:Cedar", "4:Damson", "5:Elm"]);
  });

  it("moves to first and to last", async () => {
    expect(await move(alice, tenantA, id("Elm"), 1)).toBe(1);
    expect(await order(tenantA)).toEqual(["1:Elm", "2:Ash", "3:Birch", "4:Cedar", "5:Damson"]);
    expect(await move(alice, tenantA, id("Elm"), 5)).toBe(5);
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Birch", "3:Cedar", "4:Damson", "5:Elm"]);
  });

  it("clamps a place past either end", async () => {
    expect(await move(alice, tenantA, id("Cedar"), 40)).toBe(5);
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Birch", "3:Damson", "4:Elm", "5:Cedar"]);
    expect(await move(alice, tenantA, id("Cedar"), -3)).toBe(1);
    expect(await order(tenantA)).toEqual(["1:Cedar", "2:Ash", "3:Birch", "4:Damson", "5:Elm"]);
    expect(await move(alice, tenantA, id("Cedar"), 3)).toBe(3);
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Birch", "3:Cedar", "4:Damson", "5:Elm"]);
  });

  it("treats a place typed on the debt's form as a move; blank keeps it", async () => {
    await save(alice, tenantA, { name: "Elm", priority: 2 }, id("Elm"));
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Elm", "3:Birch", "4:Cedar", "5:Damson"]);
    await save(alice, tenantA, { name: "Elm", priority: null, rate_bp: 1600 }, id("Elm"));
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Elm", "3:Birch", "4:Cedar", "5:Damson"]);
    await save(alice, tenantA, { name: "Elm", priority: 5 }, id("Elm"));
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Birch", "3:Cedar", "4:Damson", "5:Elm"]);
  });

  it("closes the gap when a debt is paused, paid another way or removed", async () => {
    await save(alice, tenantA, { name: "Birch", status: "paused" }, id("Birch"));
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Cedar", "3:Damson", "4:Elm"]);
    await save(alice, tenantA, { name: "Cedar", plan: "fixed" }, id("Cedar"));
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Damson", "3:Elm"]);
    // Back again: near where it stood (its old number, ties by name).
    await save(alice, tenantA, { name: "Birch", status: "active" }, id("Birch"));
    await save(alice, tenantA, { name: "Cedar", plan: "pool" }, id("Cedar"));
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Birch", "3:Cedar", "4:Damson", "5:Elm"]);
    const gone = await save(alice, tenantA, { name: "Fir", priority: 1 });
    expect(await order(tenantA)).toEqual([
      "1:Fir",
      "2:Ash",
      "3:Birch",
      "4:Cedar",
      "5:Damson",
      "6:Elm",
    ]);
    await as(alice, "select public.remove_money_debt($1, $2)", [tenantA, gone]);
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Birch", "3:Cedar", "4:Damson", "5:Elm"]);
  });

  it("leaves debts covered by a plan out, and the plan too", async () => {
    const planFields = (status: string) => ({
      name: "Card plan",
      rate_bp: 0,
      payment_cents: 30000,
      due_day: null,
      priority: null,
      note: null,
      status,
      opening_cents: null,
      balance_from: "covered",
      plan_account_id: null,
      covers: [id("Birch"), id("Cedar")],
    });
    const savePlan = async (planId: string | null, status: string) =>
      (
        await as<{ id: string }>(
          alice,
          "select public.save_money_debt_plan($1, $2, $3::jsonb) as id",
          [tenantA, planId, JSON.stringify(planFields(status))],
        )
      )[0].id;
    const plan = await savePlan(null, "active");
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Damson", "3:Elm"]);
    // A covered debt can't be moved: it has no place of its own.
    await expect(move(alice, tenantA, id("Birch"), 1)).rejects.toThrow(/pool/);
    // Nor can the plan (it's paid a fixed amount).
    await expect(move(alice, tenantA, plan, 1)).rejects.toThrow(/pool/);
    // A closed plan pays nothing: its debts take their places again, near where they were.
    await savePlan(plan, "closed");
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Birch", "3:Damson", "4:Cedar", "5:Elm"]);
    await savePlan(plan, "active");
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Damson", "3:Elm"]);
  });

  it("puts a new debt from the books at the end", async () => {
    await asService(db, (tx) =>
      tx.query(
        "select public.file_debts_from_books($1, 'quickbooks', '2026-11-20', $2::jsonb, false)",
        [
          tenantA,
          JSON.stringify([
            {
              id: "91",
              name: "Aardvark Card",
              cents: 120000,
              type: "Credit Card",
              subtype: "CreditCard",
              section: "CreditCards",
              kind: "card",
              automatic: true,
            },
          ]),
        ],
      ),
    );
    expect(await order(tenantA)).toEqual(["1:Ash", "2:Damson", "3:Elm", "4:Aardvark Card"]);
  });

  it("fills a place from an import where nobody chose one, as a move", async () => {
    const books = (
      await as<{ id: string }>(
        alice,
        "select id from public.money_debts where name = 'Aardvark Card'",
      )
    )[0].id;
    const result = (
      await as<{ r: Record<string, number> }>(
        dan,
        "select public.import_money_debt_details($1, gen_random_uuid(), $2::jsonb) as r",
        [
          tenantA,
          JSON.stringify([
            { debt_id: books, priority: 1 },
            { debt_id: id("Ash"), priority: 3 },
          ]),
        ],
      )
    )[0].r;
    expect(result).toMatchObject({ debts: 1, fields: 1, kept: 1 });
    expect(await order(tenantA)).toEqual(["1:Aardvark Card", "2:Ash", "3:Damson", "4:Elm"]);
  });

  it("refuses members, and never reaches across workspaces", async () => {
    await expect(move(carol, tenantA, id("Ash"), 1)).rejects.toThrow(/owners and admins/i);
    await expect(move(bob, tenantA, id("Ash"), 1)).rejects.toThrow(/owners and admins/i);
    // Bob's own workspace, alice's debt: not his to move.
    await expect(move(bob, tenantB, id("Ash"), 1)).rejects.toThrow(/isn't here/);
    expect(await order(tenantA)).toEqual(["1:Aardvark Card", "2:Ash", "3:Damson", "4:Elm"]);
    expect(await order(tenantB, bob)).toEqual(["1:Other"]);
    // A member reads no places at all.
    expect(await as(carol, "select priority from public.money_debts")).toEqual([]);
  });
});

describe("putting existing repeats right", () => {
  it("renumbers each workspace by its current place, then name", async () => {
    const before = "20270212000500_booking_messages_pause.sql";
    const old = await createTestDbUntil(before);
    const owner = await createUser(old, "owner@c.test");
    const tenant = await asUser(old, { id: owner }, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "select id from public.create_tenant('Clay', 'America/New_York', 'USD')",
      );
      return rows[0].id;
    });
    await old.query(
      `insert into public.money_debts (tenant_id, name, plan, status, priority) values
         ($1, 'Zinnia', 'pool', 'active', 1), ($1, 'Aster', 'pool', 'active', 1),
         ($1, 'Lupin', 'pool', 'active', 4), ($1, 'Poppy', 'pool', 'active', null),
         ($1, 'Fixed', 'fixed', 'active', 1)`,
      [tenant],
    );
    await applyMigrationsAfter(old, before);
    const { rows } = await old.query<{ name: string; priority: number | null }>(
      "select name, priority from public.money_debts where tenant_id = $1 order by name",
      [tenant],
    );
    expect(Object.fromEntries(rows.map((r) => [r.name, r.priority]))).toEqual({
      Aster: 1,
      Zinnia: 2,
      Lupin: 3,
      Poppy: 4,
      // Not in the order: left as it was.
      Fixed: 1,
    });
  });
});
