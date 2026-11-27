import type { LedgerSource } from "./balance";

/** What a stored entry says about where it came from. */
export type StoredSource = {
  /** How it was written down: typed in, a spreadsheet, the books, an email, an uploaded file. */
  source: "manual" | "import" | "books" | "email" | "upload" | null;
  type: "statement" | "invoice" | "payment" | "adjustment";
  /** Payments: whose word it is, when that is known. */
  reported_by: "supplier" | "bank" | null;
};

/**
 * How the balance maths sees where an entry came from. A payment the supplier
 * says it received is their record; the bank's notice and the books are ours,
 * and the same money seen from both sides is counted once. Whose word a
 * payment is can come with an email or with a spreadsheet (TuftStock's ledger
 * file says it for every payment), so it is read off the entry itself.
 */
export function entrySource(row: StoredSource): LedgerSource {
  if (row.source === "books") return "QUICKBOOKS";
  if (row.type === "payment") {
    if (row.reported_by === "supplier") return "SUPPLIER_STATEMENT_EMAIL";
    if (row.reported_by === "bank") return "BANK_NOTICE_EMAIL";
    return "MANUAL";
  }
  return row.source === "email" || row.source === "upload" ? "VENDOR_EMAIL" : "MANUAL";
}
