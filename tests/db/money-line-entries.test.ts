import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, createTestDb, createUser } from "./harness";

/**
 * Month-by-month entries for profit by line: a monthly cost's real amount in
 * one month, and revenue a line had that reached neither the shop nor the
 * books. Owners and admins write them through one checked function that
 * knows the workspace's own costs and lines; the whole team reads them; no
 * workspace sees another's.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
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

const set = (user: User, tenant: string, month: string, rows: unknown[]) =>
  as<{ n: number }>(user, "select public.set_money_line_entries($1, $2, $3::jsonb) as n", [
    tenant,
    month,
    JSON.stringify(rows),
  ]);

const entries = (user: User) =>
  as<{ tenant_id: string; kind: string; subject: string; month: string; amount_cents: string }>(
    user,
    "select tenant_id, kind, subject, month::text, amount_cents::text from public.money_line_entries order by kind, subject",
  );

async function configs(tenant: string) {
  await db.query(
    `insert into public.configs (tenant_id, module, key, body) values
       ($1, 'dashboard', 'revenue', $2::jsonb), ($1, 'dashboard', 'profit', $3::jsonb)`,
    [
      tenant,
      JSON.stringify({
        version: 1,
        lines: [
          { id: "shop", name: "Shop" },
          { id: "classes", name: "Classes" },
        ],
        default_line: "shop",
      }),
      JSON.stringify({
        version: 1,
        monthly_costs: [
          {
            id: "help",
            name: "Studio help",
            how: "amount",
            amount_cents: 80000,
            split: { shop: 100 },
          },
        ],
      }),
    ],
  );
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
  await configs(tenantA);
  await configs(tenantB);
});

describe("month-by-month entries", () => {
  it("keeps one figure per month for each cost and line, and a blank takes it away", async () => {
    await set(alice, tenantA, "2026-10-01", [
      { kind: "cost", subject: "help", amount_cents: 95000, note: "Extra hours" },
      { kind: "revenue", subject: "classes", amount_cents: 12000 },
    ]);
    await set(alice, tenantA, "2026-10-01", [
      { kind: "cost", subject: "help", amount_cents: 90000 },
    ]);
    expect(await entries(carol)).toEqual([
      {
        tenant_id: tenantA,
        kind: "cost",
        subject: "help",
        month: "2026-10-01",
        amount_cents: "90000",
      },
      {
        tenant_id: tenantA,
        kind: "revenue",
        subject: "classes",
        month: "2026-10-01",
        amount_cents: "12000",
      },
    ]);
    await set(alice, tenantA, "2026-10-01", [
      { kind: "revenue", subject: "classes", amount_cents: null },
    ]);
    expect((await entries(alice)).map((e) => e.kind)).toEqual(["cost"]);
  });

  it("refuses a cost or line the workspace doesn't have, part of a month, or a bad amount", async () => {
    await expect(
      set(alice, tenantA, "2026-10-01", [{ kind: "cost", subject: "rent", amount_cents: 1 }]),
    ).rejects.toThrow(/monthly costs/);
    await expect(
      set(alice, tenantA, "2026-10-01", [
        { kind: "revenue", subject: "wholesale", amount_cents: 1 },
      ]),
    ).rejects.toThrow(/your lines/);
    await expect(set(alice, tenantA, "2026-10-15", [])).rejects.toThrow(/whole month/);
    await expect(
      set(alice, tenantA, "2026-10-01", [{ kind: "cost", subject: "help", amount_cents: -5 }]),
    ).rejects.toThrow(/whole number of cents/);
    await expect(
      set(alice, tenantA, "2026-10-01", [{ kind: "cost", subject: "help", amount_cents: 1.5 }]),
    ).rejects.toThrow(/whole number of cents/);
  });

  it("is written only by owners and admins, never straight into the table", async () => {
    await expect(
      set(carol, tenantA, "2026-11-01", [{ kind: "cost", subject: "help", amount_cents: 1 }]),
    ).rejects.toThrow(/owners and admins/i);
    await expect(
      as(
        alice,
        "insert into public.money_line_entries (tenant_id, kind, month, subject, amount_cents) values ($1, 'cost', '2026-11-01', 'help', 1)",
        [tenantA],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("never crosses workspaces", async () => {
    await expect(
      set(bob, tenantA, "2026-11-01", [{ kind: "cost", subject: "help", amount_cents: 1 }]),
    ).rejects.toThrow(/owners and admins/i);
    await set(bob, tenantB, "2026-11-01", [{ kind: "cost", subject: "help", amount_cents: 7 }]);
    expect((await entries(bob)).every((e) => e.tenant_id === tenantB)).toBe(true);
    expect((await entries(alice)).every((e) => e.tenant_id === tenantA)).toBe(true);
    await expect(
      asAnon(db, (tx) => tx.query("select * from public.money_line_entries")),
    ).rejects.toThrow(/permission denied/i);
  });
});
