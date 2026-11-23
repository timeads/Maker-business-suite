/**
 * Display helpers for vendor balances. Internally a balance is signed (positive =
 * you owe the vendor, negative = the vendor owes you), but a leading minus sign is
 * accounting shorthand that reads as "negative money", so the UI never shows one.
 * Direction is always spelled out in words instead.
 */

export type BalanceDirection = "owed" | "credit" | "settled";

export interface DescribedBalance {
  direction: BalanceDirection;
  /** Absolute amount, e.g. "$2,764.15" — never signed. */
  amount: string;
  /** Amount with its direction, e.g. "$2,764.15 owed", "$2,764.15 credit", "$0.00". */
  text: string;
}

const toCents = (v: string | number): number => Math.round(Number(v) * 100);

/** "$1,234.56" from cents, always unsigned. */
function dollars(cents: number): string {
  return `$${(Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Unsigned money, for amounts whose direction is given by context (e.g. a PAYMENT row). */
export function formatAmount(v: string | number): string {
  return dollars(toCents(v));
}

/** A signed balance described in words: positive = owed, negative = credit. */
export function describeBalance(v: string | number): DescribedBalance {
  const cents = toCents(v);
  const amount = dollars(cents);
  if (cents === 0) return { direction: "settled", amount, text: amount };
  const direction: BalanceDirection = cents > 0 ? "owed" : "credit";
  return { direction, amount, text: `${amount} ${direction}` };
}

/**
 * A signed ledger adjustment. Negative adjustments are credit notes from the vendor
 * (e.g. goods detained at customs); positive ones add to what you owe.
 */
export function describeAdjustment(v: string | number): { isCredit: boolean; text: string } {
  const cents = toCents(v);
  const isCredit = cents < 0;
  return { isCredit, text: isCredit ? `${dollars(cents)} credit` : dollars(cents) };
}

/**
 * How a vendor's stated balance compares with the ledger's own arithmetic, in words.
 * delta = stated − computed.
 */
export function describeDrift(delta: string | number): string {
  const cents = toCents(delta);
  if (cents === 0) return "matches";
  return `the vendor's figure is ${dollars(cents)} ${cents > 0 ? "higher" : "lower"}`;
}
