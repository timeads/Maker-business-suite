import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { seasonsSchema } from "@/lib/stock/config";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Stock, the fourth batch of gaps closed after the side-by-side with
 * TuftStock: selling seasons, and what follows in the sections below.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let bob: User; // owner of B
let carol: User; // plain member of A
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used by the sections added below
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, carol.id],
  );
}, 120_000);

describe("selling seasons", () => {
  it("are a workspace setting: managers write, the team reads, others see nothing", async () => {
    const seasons = seasonsSchema.parse({
      version: 1,
      seasons: [
        { id: "holiday001", name: "Holiday rush", in_stock_by: "2026-12-10", lift_pct: 25 },
      ],
    });
    const body = JSON.stringify(seasons);
    const save = "select public.save_config($1, 'stock', 'seasons', $2::jsonb)";
    await expect(as(carol, save, [tenantA, body])).rejects.toThrow();
    await expect(as(bob, save, [tenantA, body])).rejects.toThrow();
    await as(alice, save, [tenantA, body]);
    const read = (user: User) =>
      as<{ body: unknown }>(
        user,
        "select body from public.configs where tenant_id = $1 and module = 'stock' and key = 'seasons'",
        [tenantA],
      );
    // What comes back parses, with the card open until someone folds it.
    expect(seasonsSchema.parse((await read(carol))[0].body).seasons[0]).toMatchObject({
      name: "Holiday rush",
      lift_pct: 25,
      card: "open",
    });
    expect(await read(bob)).toEqual([]);
    expect(await as(bob, "select 1 from public.configs where tenant_id = $1", [tenantA])).toEqual(
      [],
    );
    // Folding a card is a write like any other, and leaves a version behind.
    seasons.seasons[0].card = "folded";
    await as(alice, save, [tenantA, JSON.stringify(seasons)]);
    const versions = await one<{ n: number }>(
      "select count(*)::int as n from public.config_versions where tenant_id = $1 and module = 'stock' and key = 'seasons'",
      [tenantA],
    );
    expect(versions.n).toBe(2);
    expect(tenantB).not.toBe(tenantA);
  });

  it("refuses a season that isn't one", () => {
    const bad = (season: object) =>
      seasonsSchema.safeParse({ version: 1, seasons: [season] }).success;
    expect(bad({ id: "holiday001", name: "", in_stock_by: "2026-12-10" })).toBe(false);
    expect(bad({ id: "holiday001", name: "Fair", in_stock_by: "Dec 10" })).toBe(false);
    expect(bad({ id: "holiday001", name: "Fair", in_stock_by: "2026-12-10", lift_pct: 900 })).toBe(
      false,
    );
    expect(bad({ id: "holiday001", name: "Fair", in_stock_by: "2026-12-10" })).toBe(true);
  });
});
