import type { MailKind } from "./config";
import { centsText, normalizeInvoiceRef, type ReadDocument } from "./extract";

/**
 * Turns what was read out of one email (or one uploaded file) into entries
 * for a supplier's account. Pure, after TuftStock's importers, with their
 * rules made general:
 *
 *  - Doubt is flagged, never guessed. A read the reader wasn't sure of, a
 *    total that doesn't match its lines, a printed date that doesn't fit the
 *    email, or a source set to "always check" is filed marked "to check".
 *  - What can't be read at all is skipped with a reason, to be typed in: an
 *    invoice with no total or no number, a payment with no date.
 *  - A statement's balance re-anchors the whole account, so it is only taken
 *    when the reader was sure of it. A wrong anchor would quietly reset
 *    everything; an unsure one is skipped.
 *  - Nothing in another currency is filed.
 *  - The same thing read twice out of one email is one entry (its key).
 *
 * What is already on the account (the same invoice typed in, a newer
 * statement, something a manager took off) is decided by the database when
 * the entries are filed (`file_email_entries`), which is the only place that
 * can see it under a lock.
 */

export type Candidate = {
  supplier_id: string;
  type: "invoice" | "statement" | "payment";
  /** YYYY-MM-DD. */
  entry_date: string;
  /** Two decimals, as text. "0.00" for a statement. */
  amount: string;
  stated_balance: string | null;
  reference: string | null;
  description: string;
  external_key: string;
  needs_review: boolean;
  review_note: string | null;
  /** Payments: whose word it is, the supplier's ("we received…") or the bank's. */
  reported_by: "supplier" | "bank" | null;
};

export type Skipped = { what: string; reason: string };

export type PlanContext = {
  supplierId: string;
  /** What the source says its mail is; `bank` for a bank's payment notices. */
  kind: MailKind | "bank";
  alwaysCheck: boolean;
  /** The workspace's currency, ISO code. */
  currency: string;
  /** Gmail's id for the message, or null for an uploaded file. */
  messageId: string | null;
  /** For an uploaded file: a fingerprint of its bytes. */
  uploadKey?: string;
  /** The workspace's calendar day the email was sent (or the file uploaded). */
  day: string;
};

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
/** A printed invoice date older than this against its email is not believed. */
export const PRINTED_DATE_MAX_AGE_DAYS = 60;

const ALLOWED: Record<PlanContext["kind"], readonly ReadDocument["kind"][]> = {
  mixed: ["invoice", "statement", "payment"],
  invoice: ["invoice"],
  statement: ["statement", "payment"],
  payment: ["payment"],
  bank: ["payment"],
};

const NAMES = { invoice: "an invoice", statement: "a statement", payment: "a payment" } as const;

export function planDocuments(
  docs: readonly ReadDocument[],
  ctx: PlanContext,
): { entries: Candidate[]; skipped: Skipped[] } {
  const entries = new Map<string, Candidate>();
  const skipped: Skipped[] = [];
  const origin = ctx.messageId ? `mail:${ctx.messageId}` : `upload:${ctx.uploadKey ?? "file"}`;
  const from = ctx.messageId ? "an email" : "an uploaded file";
  const dated = ctx.messageId ? "emailed" : "uploaded";
  const money = (cents: number) => `${centsText(cents)} ${ctx.currency}`;

  for (const doc of docs) {
    const label =
      doc.kind === "invoice" && doc.reference
        ? `invoice ${doc.reference}`
        : NAMES[doc.kind as keyof typeof NAMES];
    if (doc.kind === "estimate") {
      skipped.push({
        what: doc.reference ?? "a document",
        reason: "an estimate, not a final invoice",
      });
      continue;
    }
    if (doc.kind === "other") {
      skipped.push({ what: "a document", reason: "not an invoice, statement or payment" });
      continue;
    }
    if (!ALLOWED[ctx.kind].includes(doc.kind)) {
      skipped.push({
        what: label,
        reason:
          ctx.kind === "bank"
            ? "the bank's notices are only read for payments"
            : `this source is set to read ${ctx.kind}s only`,
      });
      continue;
    }
    if (doc.currency && doc.currency !== ctx.currency) {
      skipped.push({
        what: label,
        reason: `it's in ${doc.currency}, not ${ctx.currency} — add it by hand in ${ctx.currency}`,
      });
      continue;
    }
    const notes: string[] = [];
    if (ctx.alwaysCheck) notes.push("This source is set to always be checked.");

    if (doc.kind === "statement") {
      if (doc.balanceCents === null) {
        skipped.push({ what: label, reason: "couldn't find the balance on it — enter it by hand" });
        continue;
      }
      if (!doc.sure.amount) {
        skipped.push({
          what: label,
          reason: "couldn't read the balance for certain — enter it by hand",
        });
        continue;
      }
      // A statement says what was owed on its own date; never one after it was sent.
      const entryDate = doc.balanceDate && doc.balanceDate <= ctx.day ? doc.balanceDate : ctx.day;
      const key = `${origin}:stmt`;
      if (!entries.has(key)) {
        entries.set(key, {
          supplier_id: ctx.supplierId,
          type: "statement",
          entry_date: entryDate,
          amount: "0.00",
          stated_balance: centsText(doc.balanceCents),
          reference: null,
          description: `Statement read from ${from}`,
          external_key: key,
          needs_review: notes.length > 0,
          review_note: notes.join(" ") || null,
          reported_by: null,
        });
      }
      continue;
    }

    if (doc.amountCents === null || doc.amountCents <= 0) {
      skipped.push({
        what: label,
        reason:
          doc.kind === "invoice"
            ? "couldn't find the total — enter it by hand"
            : "couldn't find the amount — enter it by hand",
      });
      continue;
    }
    if (!doc.sure.amount) notes.push("The reader wasn't sure of the amount — check it.");

    if (doc.kind === "payment") {
      if ((!doc.date || doc.date > ctx.day) && ctx.kind !== "bank") {
        skipped.push({ what: label, reason: "no date for the payment — enter it by hand" });
        continue;
      }
      // A bank's notice with no readable date is dated by the notice itself.
      const entryDate = doc.date && doc.date <= ctx.day ? doc.date : ctx.day;
      if (!doc.sure.date) notes.push("The reader wasn't sure of the date — check it.");
      const bank = ctx.kind === "bank";
      const key = `${origin}:${bank ? "bank" : "pay"}:${entryDate}:${doc.amountCents}`;
      entries.set(key, {
        supplier_id: ctx.supplierId,
        type: "payment",
        entry_date: entryDate,
        amount: centsText(doc.amountCents),
        stated_balance: null,
        reference: null,
        description: bank
          ? "Your bank's notice of a payment"
          : "The supplier's note that they received it",
        external_key: key,
        needs_review: notes.length > 0,
        review_note: notes.join(" ") || null,
        reported_by: bank ? "bank" : "supplier",
      });
      continue;
    }

    // An invoice.
    if (!doc.reference || !normalizeInvoiceRef(doc.reference)) {
      skipped.push({ what: label, reason: "no invoice number on it — enter it by hand" });
      continue;
    }
    if (!doc.sure.reference) notes.push("The reader wasn't sure of the invoice number — check it.");
    // The days to pay count from the date printed on the invoice, not from
    // the day it was emailed. A printed date that doesn't fit is not believed.
    let entryDate = ctx.day;
    if (
      doc.date &&
      doc.date <= ctx.day &&
      daysBetween(doc.date, ctx.day) <= PRINTED_DATE_MAX_AGE_DAYS
    ) {
      entryDate = doc.date;
      if (!doc.sure.date) notes.push("The reader wasn't sure of the date — check it.");
    } else if (doc.date) {
      notes.push(
        `The date printed on it (${doc.date}) doesn't fit an invoice ${dated} ${ctx.day}; dated by the day it was ${dated} instead.`,
      );
    } else {
      notes.push(`No date could be read on it; dated by the day it was ${dated} (${ctx.day}).`);
    }
    if (doc.linesCents !== null && doc.linesCents > 0 && doc.linesCents !== doc.amountCents) {
      notes.push(
        `Line amounts add up to ${money(doc.linesCents)} but the total reads ${money(doc.amountCents)} — check it.`,
      );
    }
    const key = `${origin}:inv:${normalizeInvoiceRef(doc.reference)}`.slice(0, 120);
    entries.set(key, {
      supplier_id: ctx.supplierId,
      type: "invoice",
      entry_date: entryDate,
      amount: centsText(doc.amountCents),
      stated_balance: null,
      reference: doc.reference,
      description: `Read from ${from}`,
      external_key: key,
      needs_review: notes.length > 0,
      review_note: notes.join(" ").slice(0, 500) || null,
      reported_by: null,
    });
  }
  return { entries: [...entries.values()], skipped };
}
