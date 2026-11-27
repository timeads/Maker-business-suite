import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * The monthly summary Claude writes from the business's figures: kept one
 * per workspace per month, read by owners and admins only, written only by
 * the server (service role) naming the owner or admin who asked for it, and
 * never across workspaces.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let dan: User; // admin of A
let carol: User; // member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;

const as = <T = Record<string, unknown>>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);

const SECTIONS = [
  { section: "month", points: [{ text: "Revenue came in at $1,000.00.", refs: ["F1"] }] },
  { section: "cut", points: [{ text: "Look at the software charge.", refs: ["C1"] }] },
];

const save = (tenant: string, month: string, writer: string, sections: unknown = SECTIONS) =>
  asService(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select public.save_money_summary($1, $2::date, $3::jsonb, $4) as id",
      [tenant, month, JSON.stringify(sections), writer],
    );
    return rows[0].id;
  });

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
});

describe("monthly summaries", () => {
  it("keeps one per month, and writing it again replaces it", async () => {
    const first = await save(tenantA, "2026-10-01", dan.id);
    const again = await save(tenantA, "2026-10-01", alice.id, [SECTIONS[0]]);
    expect(again).toBe(first);
    const rows = await as<{ month: string; written_by: string; n: number }>(
      alice,
      "select month::text, written_by, jsonb_array_length(sections) as n from public.money_summaries",
    );
    expect(rows).toEqual([{ month: "2026-10-01", written_by: alice.id, n: 1 }]);
    await save(tenantB, "2026-10-01", bob.id);
  });

  it("is read by owners and admins only, never across workspaces", async () => {
    expect(await as(dan, "select tenant_id from public.money_summaries")).toEqual([
      { tenant_id: tenantA },
    ]);
    expect(await as(carol, "select 1 from public.money_summaries")).toEqual([]);
    expect(await as(bob, "select tenant_id from public.money_summaries")).toEqual([
      { tenant_id: tenantB },
    ]);
    await expect(
      asAnon(db, (tx) => tx.query("select 1 from public.money_summaries")),
    ).rejects.toThrow(/permission denied/);
  });

  it("can't be written by a person, only by the server for an owner or admin", async () => {
    await expect(
      as(alice, "select public.save_money_summary($1, '2026-09-01', $2::jsonb, $3)", [
        tenantA,
        JSON.stringify(SECTIONS),
        alice.id,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(
        alice,
        "insert into public.money_summaries (tenant_id, month, sections) values ($1, '2026-09-01', '[]')",
        [tenantA],
      ),
    ).rejects.toThrow(/permission denied/);
    // A member, or an owner of another workspace, can't be named as the writer.
    await expect(save(tenantA, "2026-09-01", carol.id)).rejects.toThrow(/owners and admins/);
    await expect(save(tenantA, "2026-09-01", bob.id)).rejects.toThrow(/owners and admins/);
  });

  it("refuses a shape a summary can't have", async () => {
    await expect(save(tenantA, "2026-09-02", alice.id)).rejects.toThrow(/month/);
    await expect(save(tenantA, "2026-09-01", alice.id, [])).rejects.toThrow(/three sections/);
    await expect(
      save(tenantA, "2026-09-01", alice.id, [{ section: "gossip", points: [] }]),
    ).rejects.toThrow(/section/);
    await expect(
      save(tenantA, "2026-09-01", alice.id, [{ section: "month", points: [] }]),
    ).rejects.toThrow(/something to say/);
  });
});
