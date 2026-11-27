import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * The assistant's proposals about one expense, a month's budget and a cost
 * cutter decision: filed by anyone on the team, applied by an owner or
 * admin, with a history of what changed that only the person who applied
 * one can write. Debt proposals and their history stay for owners and
 * admins; nothing crosses workspaces.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let carol: User; // plain member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;
let expenseA: string;
let expenseB: string;
const RUN = "11111111-1111-4111-8111-111111111111";

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

const propose = (user: User, tenant: string, kind: string, target: string | null, body: unknown) =>
  as<{ id: string }>(
    user,
    "select public.propose_action($1, $2, $3, $4::jsonb, 'A change') as id",
    [tenant, kind, target, JSON.stringify(body)],
  ).then((rows) => rows[0].id);

async function expenseIn(tenant: string, id: string): Promise<string> {
  await asService(db, (tx) =>
    tx.query("select public.file_book_expenses($1, 'quickbooks', $2, $3::jsonb)", [
      tenant,
      RUN,
      JSON.stringify([
        {
          entity: "Purchase",
          external_id: id,
          kind: "purchase",
          date: "2026-10-05",
          amount_cents: 4599,
          account: "Supplies",
          payee: "Yarn Barn",
          memo: "",
          lines: [],
        },
      ]),
    ]),
  );
  const { rows } = await db.query<{ id: string }>(
    "select id from public.book_expenses where tenant_id = $1 and external_id = $2",
    [tenant, id],
  );
  return rows[0].id;
}

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, carol.id],
  );
  expenseA = await expenseIn(tenantA, "1");
  expenseB = await expenseIn(tenantB, "2");
});

describe("proposals about expenses, budgets and charges", () => {
  it("are filed by anyone on the team, about their own workspace's expenses", async () => {
    const id = await propose(carol, tenantA, "money.expense_sort", expenseA, { sort: "shared" });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      propose(carol, tenantA, "money.expense_sort", expenseB, { sort: "shared" }),
    ).rejects.toThrow(/isn't here/);
    await expect(propose(bob, tenantA, "money.charge", null, { key: "x" })).rejects.toThrow(
      /Not a member/,
    );
  });

  it("carry no target for a budget or a charge, and always one for an expense", async () => {
    await propose(carol, tenantA, "money.budget", null, { month: "2027-03" });
    await expect(
      propose(carol, tenantA, "money.budget", expenseA, { month: "2027-03" }),
    ).rejects.toThrow(/about no one row/);
    await expect(
      propose(carol, tenantA, "money.expense_sort", null, { sort: "shared" }),
    ).rejects.toThrow(/isn't here/);
  });

  it("are applied by an owner or admin only, and the history is written once by them", async () => {
    const id = await propose(carol, tenantA, "money.charge", null, { key: "design app" });
    await expect(as(carol, "select * from public.claim_action_proposal($1)", [id])).rejects.toThrow(
      /owners and admins/i,
    );
    await as(alice, "select * from public.claim_action_proposal($1)", [id]);
    // Carol can't write the history of something she didn't apply.
    await as(carol, "select public.note_action_applied($1, $2, $3)", [id, ["x"], ["y"]]);
    await as(alice, "select public.note_action_applied($1, $2, $3)", [
      id,
      ["Not decided"],
      ["Cancel it"],
    ]);
    await as(alice, "select public.note_action_applied($1, $2, $3)", [id, ["again"], ["again"]]);
    const seen = await as<{
      applied_before: string[];
      applied_after: string[];
      decided_by: string;
    }>(
      carol,
      "select applied_before, applied_after, decided_by from public.action_proposals where id = $1",
      [id],
    );
    expect(seen).toEqual([
      { applied_before: ["Not decided"], applied_after: ["Cancel it"], decided_by: alice.id },
    ]);
  });

  it("keeps debt proposals and their history from anyone but owners and admins", async () => {
    await expect(
      propose(carol, tenantA, "money.debt_details", expenseA, { minimum_cents: 1 }),
    ).rejects.toThrow(/owners and admins/i);
    const { rows } = await db.query<{ id: string }>(
      `insert into public.action_proposals (tenant_id, kind, target, body, summary, status, decided_by, decided_at, applied_after)
       values ($1, 'money.debt_details', gen_random_uuid(), '{}', 'A debt', 'applied', $2, now(), '{Owed}')
       returning id`,
      [tenantA, alice.id],
    );
    expect(
      await as(carol, "select id from public.action_proposals where id = $1", [rows[0].id]),
    ).toEqual([]);
    expect(
      (await as(alice, "select id from public.action_proposals where id = $1", [rows[0].id]))
        .length,
    ).toBe(1);
  });

  it("never crosses workspaces", async () => {
    const mine = await as<{ tenant_id: string }>(
      bob,
      "select tenant_id from public.action_proposals",
    );
    expect(mine.every((r) => r.tenant_id === tenantB)).toBe(true);
    const theirs = await as<{ tenant_id: string }>(
      alice,
      "select tenant_id from public.action_proposals",
    );
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((r) => r.tenant_id === tenantA)).toBe(true);
    await expect(
      as(alice, "update public.action_proposals set applied_after = '{x}'"),
    ).rejects.toThrow(/permission denied/i);
  });
});
