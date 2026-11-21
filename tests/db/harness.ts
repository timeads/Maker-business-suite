import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";

const root = join(__dirname, "..", "..");
const migrationsDir = join(root, "supabase", "migrations");

/** Boots an in-process Postgres and applies every migration, in order. */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(readFileSync(join(__dirname, "supabase-shim.sql"), "utf8"));
  for (const file of readdirSync(migrationsDir).sort()) {
    if (file.endsWith(".sql")) {
      await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
  }
  return db;
}

export async function createUser(db: PGlite, email: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into auth.users (email) values ($1) returning id",
    [email],
  );
  return rows[0].id;
}

/**
 * Runs `fn` the way PostgREST would for a signed-in user: as the
 * `authenticated` role with the user's JWT claims set for the transaction.
 */
export function asUser<T>(
  db: PGlite,
  user: { id: string; email?: string },
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: user.id, email: user.email, role: "authenticated" }),
    ]);
    await tx.exec("set local role authenticated");
    return fn(tx);
  }) as Promise<T>;
}

export function asAnon<T>(db: PGlite, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec("set local role anon");
    return fn(tx);
  }) as Promise<T>;
}

/** Runs `fn` the way the worker or a webhook would: with the service role. */
export function asService<T>(db: PGlite, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return fn(tx);
  }) as Promise<T>;
}
