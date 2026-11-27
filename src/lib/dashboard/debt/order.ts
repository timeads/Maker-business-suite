import type { Debt } from "./figures";

/**
 * "Your own order": which debts take a place, and where a move puts them.
 * The database keeps the places 1..N (`private.money_debt_renumber`,
 * `move_money_debt`); this is its twin for the pages, on the debts as they
 * are after `foldDebts` (covered debts are already folded into their plan,
 * so they never get a place of their own). Pure.
 *
 * Only the snowball pool's active debts are put in an order by the engine
 * (`attackOrder` for "your own order", and the pool's target in
 * `projectPlan`); a fixed payment, a share of sales, a plan that pays other
 * debts, a paused or closed debt each pay what they pay whatever the order.
 */

export const takesPlace = (d: Pick<Debt, "consolidated" | "plan" | "status">) =>
  !d.consolidated && d.plan === "pool" && d.status === "active";

/** The debts that take a place, first to last (no place last, then by name, as the database). */
export function ownOrder<
  T extends Pick<Debt, "consolidated" | "plan" | "status" | "priority" | "name" | "id">,
>(debts: readonly T[]): T[] {
  return debts
    .filter(takesPlace)
    .slice()
    .sort(
      (a, b) =>
        (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/**
 * The order after moving one to a place (1 is first): an insert, the
 * others shifting around it; a place past either end is clamped. An id not
 * in the list leaves it as it was.
 */
export function moveTo<T>(items: readonly T[], at: number, position: number): T[] {
  if (at < 0 || at >= items.length || !Number.isFinite(position)) return items.slice();
  const k = Math.min(Math.max(Math.trunc(position), 1), items.length) - 1;
  const rest = items.filter((_, i) => i !== at);
  return [...rest.slice(0, k), items[at], ...rest.slice(k)];
}

/**
 * The page's list: debts with a place first, in their order, then the rest
 * as they came. `place` is each one's place (1..N), or null.
 */
export function withPlaces<
  T extends Pick<Debt, "consolidated" | "plan" | "status" | "priority" | "name" | "id">,
>(debts: readonly T[]): { debt: T; place: number | null }[] {
  const ordered = ownOrder(debts);
  const placed = new Set(ordered.map((d) => d.id));
  return [
    ...ordered.map((debt, i) => ({ debt, place: i + 1 })),
    ...debts.filter((d) => !placed.has(d.id)).map((debt) => ({ debt, place: null })),
  ];
}

/** Why a debt has no place, in words, for the list. */
export function noPlaceWords(d: Pick<Debt, "consolidated" | "plan" | "status">): string | null {
  if (takesPlace(d)) return null;
  if (d.consolidated) return "Paid as one fixed payment, so it keeps its own pace";
  if (d.status !== "active") return d.status === "paused" ? "Paused" : "Closed";
  return d.plan === "fixed" ? "Paid a fixed amount" : "Paid as a share of sales";
}
