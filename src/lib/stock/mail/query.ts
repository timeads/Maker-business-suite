import { senderPattern, type BankSource, type SupplierSource } from "./config";

/**
 * The Gmail search for one source, and the check made again on every message
 * it returns. Pure. A source's values were validated when the config was
 * saved; they are checked once more here, because whatever reaches a search
 * decides which of a person's mail we look at.
 */

/** How far back a look goes. Messages already looked at are never read twice. */
export const DAILY_LOOKBACK_DAYS = 10;
/** The first look, and "Try it": far enough back to catch up. */
export const CATCH_UP_DAYS = 45;

const SAFE_WORDS = /^[\p{L}\p{N} ._#&/'-]+$/u;
const quoted = (text: string) => `"${text.replace(/\s+/g, " ").trim()}"`;

/** Gmail writes a label's spaces and slashes as dashes in a search. */
const labelTerm = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s/&]+/g, "-");

export class BadSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadSourceError";
  }
}

type Searchable = Pick<SupplierSource, "from" | "label" | "subject_words"> & {
  reads?: SupplierSource["reads"];
};

/**
 * `from:(billing@mill.example) subject:("invoice" OR "statement") has:attachment newer_than:10d`.
 * Always carries a sender and a time window: there is no source that means
 * "the whole mailbox".
 */
export function buildQuery(source: Searchable, days: number): string {
  const from = source.from.trim().toLowerCase();
  if (!senderPattern.test(from)) throw new BadSourceError("That sender isn't an address or domain");
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new BadSourceError("A look goes back between 1 and 90 days");
  }
  const parts = [`from:(${from})`];
  if (source.label.trim()) {
    if (!/^[\p{L}\p{N} ._/&-]+$/u.test(source.label)) {
      throw new BadSourceError("That label has characters a search can't carry");
    }
    parts.push(`label:${labelTerm(source.label)}`);
  }
  if (source.subject_words.length > 0) {
    for (const word of source.subject_words) {
      if (!SAFE_WORDS.test(word)) {
        throw new BadSourceError("Subject words can only be letters, numbers and spaces");
      }
    }
    parts.push(`subject:(${source.subject_words.map(quoted).join(" OR ")})`);
  }
  if (source.reads === "attachments") parts.push("has:attachment");
  parts.push(`newer_than:${days}d`, "-in:chats", "-in:drafts");
  return parts.join(" ");
}

export const supplierQuery = (source: SupplierSource, days: number) => buildQuery(source, days);
export const bankQuery = (source: BankSource, days: number) => buildQuery(source, days);

/** The address inside a From header: `"Billing" <billing@mill.example>` → billing@mill.example. */
export function senderAddress(fromHeader: string): string {
  const angled = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(fromHeader.trim());
  const raw = (angled ? angled[1] : fromHeader).trim().toLowerCase();
  return /^[^\s@<>",;]+@[^\s@<>",;]+$/.test(raw) ? raw.slice(0, 200) : "";
}

/**
 * Is this message really from the source's sender? Gmail's search matches
 * whole conversations and display names, so each message is checked itself:
 * the business's own replies in the same thread are never read.
 */
export function senderMatches(fromHeader: string, from: string): boolean {
  const address = senderAddress(fromHeader);
  const want = from.trim().toLowerCase();
  if (!address || !want) return false;
  if (want.includes("@")) return address === want;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return domain === want || domain.endsWith(`.${want}`);
}

/** Does a subject carry one of the source's words (any capitals)? No words means yes. */
export function subjectMatches(subject: string, wordsWanted: readonly string[]): boolean {
  if (wordsWanted.length === 0) return true;
  const flat = subject.toLowerCase();
  return wordsWanted.some((word) => flat.includes(word.trim().toLowerCase()));
}

/** An attached file a source says never to read, by its name. */
export function fileSkipped(fileName: string, skipWords: readonly string[]): boolean {
  const flat = fileName.toLowerCase();
  return skipWords.some((word) => flat.includes(word.trim().toLowerCase()));
}

/**
 * Which supplier a bank's notice is about: the one whose words appear in its
 * subject or text. Worked out here, by plain matching on what the workspace
 * typed in, never by the reader. A notice that matches nobody is not read at
 * all; one that matches two suppliers is left for a person.
 */
export function payeeFor(
  source: BankSource,
  subject: string,
  text: string,
): { supplierId: string } | { none: true } | { several: true } {
  const flat = `${subject}\n${text}`.toLowerCase().replace(/\s+/g, " ");
  const hits = new Set<string>();
  for (const payee of source.payees) {
    if (payee.words.some((word) => flat.includes(word.trim().toLowerCase().replace(/\s+/g, " ")))) {
      hits.add(payee.supplier_id);
    }
  }
  if (hits.size === 0) return { none: true };
  if (hits.size > 1) return { several: true };
  return { supplierId: [...hits][0] };
}

/** A plain link that opens the message in the person's own Gmail. Nothing is fetched. */
export function gmailLink(messageId: string): string | null {
  return /^[0-9a-f]{8,32}$/i.test(messageId)
    ? `https://mail.google.com/mail/u/0/#all/${messageId.toLowerCase()}`
    : null;
}

export type SourceMatch =
  | { kind: "supplier"; source: SupplierSource }
  | { kind: "bank"; source: BankSource; supplierId: string }
  /** From a bank the workspace listed, but not about one supplier it listed. */
  | { kind: "bank-other"; several: boolean };

/**
 * Whose mail is this? Held against the workspace's own sources: the sender,
 * the subject words a source asks for and, for a bank, the supplier's words.
 * Null when no source claims it. Labels are Gmail's own business and are only
 * part of the search there; a forwarded message is matched without them.
 */
export function matchSource(
  config: { suppliers: readonly SupplierSource[]; bank: readonly BankSource[] },
  sender: string,
  subject: string,
  text: string,
): SourceMatch | null {
  for (const source of config.suppliers) {
    if (senderMatches(sender, source.from) && subjectMatches(subject, source.subject_words)) {
      return { kind: "supplier", source };
    }
  }
  let bankOther: SourceMatch | null = null;
  for (const source of config.bank) {
    if (!senderMatches(sender, source.from) || !subjectMatches(subject, source.subject_words)) {
      continue;
    }
    const payee = payeeFor(source, subject, text);
    if ("supplierId" in payee) return { kind: "bank", source, supplierId: payee.supplierId };
    bankOther ??= { kind: "bank-other", several: "several" in payee };
  }
  return bankOther;
}
