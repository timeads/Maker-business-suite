import { z } from "zod";

/**
 * Which emails Stock may read to keep supplier balances up to date. Data,
 * like every other setting (CLAUDE.md rule 4): stored in `configs` under
 * module "stock" and parsed on every read. Everything that is particular to
 * one supplier or one bank lives here; the code knows no supplier by name.
 *
 * Only mail matched by one of these sources is ever looked at: who it is
 * from, plus an optional Gmail label and words in the subject.
 */
export const STOCK_EMAIL_SOURCES_KEY = "email_sources";

export const MAX_SUPPLIER_SOURCES = 30;
export const MAX_BANK_SOURCES = 5;

const id = z.string().regex(/^[a-z0-9]{6,16}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/**
 * "billing@mill.example" or just "mill.example" (anyone at that domain).
 * Lower case, and nothing that could mean something to Gmail's search.
 */
export const senderPattern = /^(?:[a-z0-9._%+-]+@)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const sender = z
  .string()
  .trim()
  .toLowerCase()
  .max(200)
  .regex(senderPattern, "An email address or a domain, like billing@mill.example or mill.example");

/** Plain words only: letters, digits, spaces and a little punctuation. */
const words = (max: number) =>
  z
    .string()
    .trim()
    .min(2)
    .max(max)
    .regex(/^[\p{L}\p{N} ._#&/'-]+$/u, "Letters, numbers and spaces only");

/** A Gmail label's name. Empty means "anywhere in the mailbox". */
const label = z
  .string()
  .trim()
  .max(80)
  .regex(/^[\p{L}\p{N} ._/&-]*$/u, "Letters, numbers and spaces only")
  .default("");

export const MAIL_KINDS = ["mixed", "invoice", "statement", "payment"] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

export const supplierSourceSchema = z.object({
  id,
  supplier_id: uuid,
  from: sender,
  label,
  /** Only mail whose subject carries one of these. Empty means any subject. */
  subject_words: z.array(words(40)).max(6).default([]),
  /** What such mail is. `mixed` lets the reader decide, document by document. */
  kind: z.enum(MAIL_KINDS).default("mixed"),
  /** Where the figures are: in the attached files, in the message itself, or either. */
  reads: z.enum(["both", "attachments", "message"]).default("both"),
  /** Attached files whose name carries one of these are never read (waybills, price lists…). */
  skip_file_words: z.array(words(40)).max(12).default([]),
  /** Mark everything read from this source "to check" (scans, hard-to-read layouts). */
  always_check: z.boolean().default(false),
});
export type SupplierSource = z.infer<typeof supplierSourceSchema>;

export const bankPayeeSchema = z.object({
  supplier_id: uuid,
  /**
   * How to tell a notice is about this supplier: its name as the bank writes
   * it, or the end of its account number as the notice shows it. A notice is
   * theirs when its subject or text carries any one of these.
   */
  words: z.array(words(60)).min(1).max(6),
  /**
   * Say so when no payment to this supplier has been filed for this many
   * days while money is still owed. Empty means never say.
   */
  quiet_days: z.number().int().min(1).max(120).nullable().default(null),
});
export type BankPayee = z.infer<typeof bankPayeeSchema>;

export const bankSourceSchema = z.object({
  id,
  from: sender,
  label,
  subject_words: z.array(words(40)).max(6).default([]),
  payees: z.array(bankPayeeSchema).max(20).default([]),
});
export type BankSource = z.infer<typeof bankSourceSchema>;

export const emailSourcesSchema = z.object({
  version: z.literal(1),
  /** "Read supplier emails". Off until a manager switches it on. */
  enabled: z.boolean().default(false),
  /** The hour of the day's read, on the workspace's own clock. */
  read_hour: z.number().int().min(0).max(23).default(6),
  suppliers: z.array(supplierSourceSchema).max(MAX_SUPPLIER_SOURCES).default([]),
  bank: z.array(bankSourceSchema).max(MAX_BANK_SOURCES).default([]),
});
export type EmailSources = z.infer<typeof emailSourcesSchema>;

export const DEFAULT_EMAIL_SOURCES: EmailSources = emailSourcesSchema.parse({ version: 1 });

export function parseEmailSources(body: unknown): EmailSources {
  const parsed = emailSourcesSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_EMAIL_SOURCES;
}

/** A short id for a new source: lowercase letters and digits. */
export function newSourceId(random: () => number = Math.random): string {
  let out = "";
  while (out.length < 8) out += Math.floor(random() * 36).toString(36);
  return out.slice(0, 8);
}
