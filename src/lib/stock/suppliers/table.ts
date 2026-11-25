/**
 * The small rules behind the Suppliers table: what an email box may hold,
 * when the "Use" chip is offered, which order the rows come in and which tab
 * a supplier sits under. Pure, so the page and the server agree.
 */

/** The address orders go to, and up to this many more after it. */
export const MAX_MORE_EMAILS = 5;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailList = { email: string | null; more: string[] };

/**
 * What was typed in the Email box: one address or several, with commas
 * (or semicolons, or spaces) between them. The first is where orders go; the
 * rest are copied in. Lower-cased, each kept once, in the order typed.
 */
export function parseEmailList(typed: string): EmailList | { error: string } {
  const all = [
    ...new Set(
      typed
        .split(/[\s,;]+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const bad = all.find((value) => value.length > 200 || !EMAIL.test(value));
  if (bad) return { error: `“${bad.slice(0, 60)}” doesn't look like an email address.` };
  if (all.length > MAX_MORE_EMAILS + 1) {
    return {
      error: `That's too many: up to ${MAX_MORE_EMAILS + 1} addresses, with commas between.`,
    };
  }
  return { email: all[0] ?? null, more: all.slice(1) };
}

/** The Email box as it reads: the main address first, then the others. */
export function joinEmails(email: string | null, more: readonly string[] | null): string {
  return [email, ...(more ?? [])].filter(Boolean).join(", ");
}

/**
 * Is "Use" offered? Only when there is an observed figure and it isn't
 * already the supplier's own. An empty lead time (following the workspace's
 * usual figure) always gets the offer, even when the two happen to match:
 * pressing it then pins the figure to this supplier.
 */
export function offersUse(observedDays: number | null | undefined, leadTimeDays: number | null) {
  if (observedDays === null || observedDays === undefined) return false;
  return adoptedDays(observedDays) !== leadTimeDays;
}

/** The observed figure as it can be saved: a whole number of days, 0 to 365. */
export function adoptedDays(observedDays: number): number {
  return Math.min(365, Math.max(0, Math.round(observedDays)));
}

/** A lead time or smallest order as typed. `empty` is what an empty box means. */
export function parseWhole(
  typed: string,
  { min, max, empty }: { min: number; max: number; empty: number | null },
): { value: number | null } | { error: true } {
  const value = typed.trim();
  if (value === "") return { value: empty };
  if (!/^\d{1,7}$/.test(value)) return { error: true };
  const n = Number(value);
  return n >= min && n <= max ? { value: n } : { error: true };
}

export type SupplierTab = "active" | "archived";

export const supplierTab = (value: string | undefined): SupplierTab =>
  value === "archived" ? "archived" : "active";

/**
 * The rows of one tab, by name the way a person reads it: capitals and
 * accents aside, "Mill 2" before "Mill 10". Same names keep a steady order.
 */
export function suppliersFor<T extends { id: string; name: string; archived_at?: string | null }>(
  suppliers: readonly T[],
  tab: SupplierTab,
): T[] {
  return suppliers
    .filter((s) => Boolean(s.archived_at) === (tab === "archived"))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
