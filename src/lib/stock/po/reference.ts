/**
 * A purchase order's name, as TuftStock writes them (ported from its
 * src/lib/po/reference.ts): `{PREFIX}-{YYYYMM}-{code}`, for example
 * `KE-202611-A7A950`. The prefix is the first two letters of the supplier's
 * name; the code is six random letters and digits.
 *
 * The database gives every new order its reference (a trigger on
 * `purchase_orders`, so no way of making an order can skip it); this file is
 * the same rule in the app, for spreadsheets being checked before an import
 * and for the tests that keep the two in step.
 */

/** "Kestrel Mills" → "KE"; "3M" → "MX"; nothing to go on → "PO". */
export function supplierPrefix(name: string): string {
  const letters = name.replace(/[^A-Za-z]/g, "").toUpperCase();
  return (letters.slice(0, 2) || "PO").padEnd(2, "X");
}

/** The year and month of a moment, in UTC, as TuftStock stamps them. */
export function referenceMonth(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** `code` is six characters of 0-9 and A-F. */
export function formatReference(supplierName: string, date: Date, code: string): string {
  return `${supplierPrefix(supplierName)}-${referenceMonth(date)}-${code.toUpperCase()}`;
}

/** One we made ourselves: prefix, month, code. */
export const isOwnReference = (value: string) => /^[A-Z]{2}-\d{6}-[0-9A-F]{6}$/.test(value);

/**
 * A reference someone else wrote (an order brought in from a spreadsheet):
 * anything short and printable will do. Returns it tidied, or null.
 */
export function tidyReference(value: string): string | null {
  const tidy = value.trim().replace(/\s+/g, " ");
  if (tidy.length < 3 || tidy.length > 40) return null;
  if (/[\x00-\x1f\x7f]/.test(tidy)) return null;
  return tidy;
}
