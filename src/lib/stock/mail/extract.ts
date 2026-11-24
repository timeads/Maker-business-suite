import { z } from "zod";

/**
 * What the reader is asked to fill in for one email, and the strict check
 * its answer goes through before anything else sees it. Pure.
 *
 * The reader's answer is only ever data for this schema. Nothing in it is
 * followed, shown as markup or used to decide where to look next: a kind
 * from a fixed list, a short reference, dates and amounts. Anything that
 * doesn't fit is dropped, not repaired.
 */

export const DOCUMENT_KINDS = ["invoice", "statement", "payment", "estimate", "other"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Most documents one email may yield (a statement plus the payments it lists). */
export const MAX_DOCUMENTS = 12;
/** The same ceiling the ledger has. */
export const MAX_CENTS = 100_000_000 * 100;

const sure = z.enum(["high", "low"]);

// Kept loose on purpose: the API's structured output doesn't take length or
// pattern rules. `tidyExtraction` is where the rules are.
export const extractionSchema = z.object({
  /**
   * For a message someone forwarded by hand: the address it first came from,
   * as the forwarded header inside the message gives it. Empty otherwise. It
   * is only ever held against the workspace's own list of senders.
   */
  original_sender: z.string(),
  documents: z.array(
    z.object({
      kind: z.enum(DOCUMENT_KINDS),
      reference: z.string(),
      date: z.string(),
      amount: z.string(),
      currency: z.string(),
      line_items_total: z.string(),
      stated_balance: z.string(),
      balance_date: z.string(),
      confidence: z.object({ reference: sure, date: sure, amount: sure }),
    }),
  ),
});
export type RawExtraction = z.infer<typeof extractionSchema>;

/** One thing read out of an email, after the strict check. Money is whole cents. */
export type ReadDocument = {
  kind: DocumentKind;
  reference: string | null;
  /** YYYY-MM-DD as printed on the document, or null. */
  date: string | null;
  amountCents: number | null;
  /** ISO code as printed ("USD"), or null when the document doesn't say. */
  currency: string | null;
  /** What the lines add up to, when the document has lines. */
  linesCents: number | null;
  /** Statements: what the supplier says is owed (negative is a credit). */
  balanceCents: number | null;
  balanceDate: string | null;
  sure: { reference: boolean; date: boolean; amount: boolean };
};

/** "1,234.5" → 123450. Text in, whole cents out; never through a float. */
export function toCents(raw: string, signed = false): number | null {
  const cleaned = raw.replace(/[\s,]/g, "").replace(/^−/, "-");
  const match = /^(-)?(\d{1,9})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  if (cents > MAX_CENTS) return null;
  if (match[1] && !signed) return null;
  return match[1] ? -cents : cents;
}

/** 123450 → "1234.50". */
export function centsText(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function realDay(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return value >= "2000-01-01" ? value : null;
}

/** A reference is a short run of ordinary characters, or it is nothing. */
function tidyReference(raw: string): string | null {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (!flat || flat.length > 80) return null;
  return /^[\p{L}\p{N} ._#/&()-]+$/u.test(flat) ? flat : null;
}

/**
 * The reader's answer, checked. Returns null when it isn't the shape asked
 * for at all; otherwise the documents that passed, capped.
 */
export function tidyExtraction(
  raw: unknown,
): { documents: ReadDocument[]; originalSender: string | null } | null {
  const parsed = extractionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const said = parsed.data.original_sender.trim().toLowerCase();
  const originalSender =
    said.length <= 200 && /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(said) ? said : null;
  const out: ReadDocument[] = [];
  for (const doc of parsed.data.documents.slice(0, MAX_DOCUMENTS)) {
    const currency = doc.currency.trim().toUpperCase();
    out.push({
      kind: doc.kind,
      reference: tidyReference(doc.reference),
      date: realDay(doc.date.trim()),
      amountCents: toCents(doc.amount),
      currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
      linesCents: toCents(doc.line_items_total),
      balanceCents: toCents(doc.stated_balance, true),
      balanceDate: realDay(doc.balance_date.trim()),
      sure: {
        reference: doc.confidence.reference === "high",
        date: doc.confidence.date === "high",
        amount: doc.confidence.amount === "high",
      },
    });
  }
  return { documents: out, originalSender };
}

/** What `stock_email_pending` holds comes back through the same check. */
const storedDocument = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  reference: z.string().max(80).nullable(),
  date: z.string().nullable(),
  amountCents: z.number().int().min(0).max(MAX_CENTS).nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  linesCents: z.number().int().min(0).max(MAX_CENTS).nullable(),
  balanceCents: z.number().int().min(-MAX_CENTS).max(MAX_CENTS).nullable(),
  balanceDate: z.string().nullable(),
  sure: z.object({ reference: z.boolean(), date: z.boolean(), amount: z.boolean() }),
});
export function parseStoredDocuments(raw: unknown): ReadDocument[] {
  const parsed = z.array(storedDocument).max(MAX_DOCUMENTS).safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.map((doc) => ({
    ...doc,
    reference: doc.reference ? tidyReference(doc.reference) : null,
    date: doc.date ? realDay(doc.date) : null,
    balanceDate: doc.balanceDate ? realDay(doc.balanceDate) : null,
  }));
}

/**
 * "#1007" / " 1007 " / "inv 1007" are the same invoice. The database has the
 * same rule (`private.ledger_ref_key`); a test keeps the two in step.
 */
export function normalizeInvoiceRef(ref: string): string {
  return ref
    .trim()
    .replace(/^(invoice|inv)\.?(\s+|\s*(?=#))/i, "")
    .replace(/^#\s*/, "")
    .replace(/\s+/g, "")
    .toUpperCase();
}
