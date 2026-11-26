import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrationsAfter, asService, asUser, createTestDbUntil, createUser } from "./harness";

/**
 * Money's cash flow statement: one more kind of report kept by month, saved
 * by the sync through the same function as the others, read by the
 * workspace's own members only, on a database that already held reports.
 */

type User = { id: string; email: string };

const BEFORE = "20270202000100_money_expenses.sql";

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

const save = (tenant: string, rows: unknown[]) =>
  asService(db, (tx) =>
    tx.query("select public.save_financial_snapshots($1, 'quickbooks', $2::jsonb)", [
      tenant,
      JSON.stringify(rows),
    ]),
  );

const month = (kind: string, start: string, data: Record<string, unknown>) => ({
  kind,
  period_start: start,
  period_end: start.replace(/01$/, "28"),
  data,
});

beforeAll(async () => {
  db = await createTestDbUntil(BEFORE);
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  // A month stored by the earlier sync, before cash flow or other income.
  await save(tenantA, [month("profit_and_loss", "2026-09-01", { income: 1000, cogs: 300 })]);
  await applyMigrationsAfter(db, BEFORE);
});

describe("the cash flow statement", () => {
  it("is kept by month beside what was already stored, and replaced in place", async () => {
    await save(tenantA, [
      month("cash_flow", "2026-09-01", { operating_cents: -1000 }),
      month("cash_flow", "2026-10-01", { operating_cents: 2000 }),
    ]);
    await save(tenantA, [month("cash_flow", "2026-10-01", { operating_cents: 2500 })]);
    // The earlier sync's kinds still save as before.
    await save(tenantA, [
      month("profit_and_loss", "2026-10-01", { income: 1, other_income_cents: 5 }),
    ]);
    const { rows } = await db.query<{ kind: string; period_start: string; data: unknown }>(
      `select kind, period_start::text, data from public.financial_snapshots
       where tenant_id = $1 order by kind, period_start`,
      [tenantA],
    );
    expect(rows).toEqual([
      { kind: "cash_flow", period_start: "2026-09-01", data: { operating_cents: -1000 } },
      { kind: "cash_flow", period_start: "2026-10-01", data: { operating_cents: 2500 } },
      { kind: "profit_and_loss", period_start: "2026-09-01", data: { income: 1000, cogs: 300 } },
      {
        kind: "profit_and_loss",
        period_start: "2026-10-01",
        data: { income: 1, other_income_cents: 5 },
      },
    ]);
  });

  it("still refuses a kind of report nobody reads", async () => {
    await expect(save(tenantA, [month("invoices", "2026-10-01", {})])).rejects.toThrow();
  });

  it("is only ever read by the workspace's own members", async () => {
    await save(tenantB, [month("cash_flow", "2026-10-01", { operating_cents: 999 })]);
    const seen = await asUser(
      db,
      alice,
      async (tx) =>
        (
          await tx.query<{ tenant_id: string }>(
            "select tenant_id from public.financial_snapshots where kind = 'cash_flow'",
          )
        ).rows,
    );
    expect(seen.length).toBe(2);
    expect(seen.every((row) => row.tenant_id === tenantA)).toBe(true);
    const bobs = await asUser(
      db,
      bob,
      async (tx) =>
        (await tx.query("select 1 from public.financial_snapshots where tenant_id = $1", [tenantA]))
          .rows,
    );
    expect(bobs).toEqual([]);
  });

  it("can't be written by a member directly", async () => {
    await expect(
      asUser(db, alice, (tx) =>
        tx.query(
          `insert into public.financial_snapshots (tenant_id, provider, kind, period_start, period_end, data)
           values ($1, 'quickbooks', 'cash_flow', '2026-11-01', '2026-11-30', '{}')`,
          [tenantA],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      asUser(db, alice, (tx) =>
        tx.query("select public.save_financial_snapshots($1, 'quickbooks', '[]'::jsonb)", [
          tenantA,
        ]),
      ),
    ).rejects.toThrow();
  });
});
