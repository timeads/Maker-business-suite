import { z } from "zod";
import { bpWords, debtFieldsSchema, type DebtFields } from "./settings";

/**
 * A debt's basics (rate, minimum, usual payment, due day) changed on their
 * own, from Money → Set up or an assistant suggestion a person applied.
 * `save_money_debt` writes every field it is handed, so the change is laid
 * over the debt as stored (read as the owner or admin) and everything else
 * is handed back exactly as it was. Pure.
 */

export const DEBT_COLUMNS =
  "id, name, kind, plan, status, rate_bp, minimum_cents, payment_cents, revolving_bp, due_day, priority, opening_cents, books_account, note, consolidated";

const cents = z.number().int().min(0).max(100_000_000_000);

/** What may change. A key left out stays as it is; `null` clears it (a rate: "not given yet"). */
export const debtBasicsSchema = z
  .object({
    rate_bp: z.number().int().min(0).max(100_000).nullable().optional(),
    minimum_cents: cents.optional(),
    payment_cents: cents.nullable().optional(),
    due_day: z.number().int().min(1).max(31).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing would change" });
export type DebtBasics = z.infer<typeof debtBasicsSchema>;

const n = (value: unknown) => (value === null || value === undefined ? null : Number(value));

/** The stored row as `save_money_debt` takes it, with the basics laid over. Null if it won't fit. */
export function withBasics(row: Record<string, unknown>, change: DebtBasics): DebtFields | null {
  const parsed = debtFieldsSchema.safeParse({
    name: row.name,
    kind: row.kind,
    plan: row.plan,
    status: row.status,
    rate_bp: "rate_bp" in change ? change.rate_bp : n(row.rate_bp),
    minimum_cents: "minimum_cents" in change ? change.minimum_cents : (n(row.minimum_cents) ?? 0),
    payment_cents: "payment_cents" in change ? change.payment_cents : n(row.payment_cents),
    revolving_bp: n(row.revolving_bp),
    due_day: "due_day" in change ? change.due_day : n(row.due_day),
    priority: n(row.priority),
    opening_cents: n(row.opening_cents),
    books_account: (row.books_account as string | null) ?? null,
    note: (row.note as string | null) ?? null,
  });
  return parsed.success ? parsed.data : null;
}

/** Before and after in plain lines, for the preview a person approves. */
export function basicsWords(
  row: Record<string, unknown>,
  change: DebtBasics,
  money: (cents: number) => string,
): { before: string[]; after: string[] } {
  const rate = (bp: number | null) => (bp === null ? "No rate given" : `Rate ${bpWords(bp)}`);
  const amount = (label: string, c: number | null) => `${label}: ${c === null ? "none" : money(c)}`;
  const day = (d: number | null) => (d === null ? "No due day" : `Due on the ${d}`);
  const before: string[] = [];
  const after: string[] = [];
  if ("rate_bp" in change) {
    before.push(rate(n(row.rate_bp)));
    after.push(rate(change.rate_bp ?? null));
  }
  if ("minimum_cents" in change) {
    before.push(amount("Minimum", n(row.minimum_cents) ?? 0));
    after.push(amount("Minimum", change.minimum_cents ?? 0));
  }
  if ("payment_cents" in change) {
    before.push(amount("Usual payment", n(row.payment_cents)));
    after.push(amount("Usual payment", change.payment_cents ?? null));
  }
  if ("due_day" in change) {
    before.push(day(n(row.due_day)));
    after.push(day(change.due_day ?? null));
  }
  return { before, after };
}
