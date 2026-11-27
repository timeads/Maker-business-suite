/**
 * Money's spreadsheets: the figures on screen as plain CSV, built on the
 * server from the same loaders the pages use. Pure; no library.
 */

/**
 * One cell. Quoted when it holds a comma, quote or line break; a cell a
 * spreadsheet would run as a formula (it starts with = + - @ or a tab) is
 * given a leading apostrophe so it stays text. Numbers are written as
 * numbers, so a negative amount stays one (see `amount`).
 */
export function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Whole cents as a number a spreadsheet reads: 1234 → 12.34, −50 → −0.5. */
export const amount = (cents: number | null | undefined): number | null =>
  cents === null || cents === undefined ? null : Math.round(cents) / 100;

/** Rows as a CSV file's text, Windows line ends, a final line end. */
export function csvText(
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** A file name's safe part: "Year to date" → "year-to-date". */
export function fileSlug(words: string): string {
  return (
    words
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "money"
  );
}
