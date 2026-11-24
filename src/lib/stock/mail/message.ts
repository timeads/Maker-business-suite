import { createHash } from "node:crypto";

/**
 * One email as the reader sees it, however it arrived (read from Gmail,
 * forwarded to the bills address, or a file a manager uploaded), and the
 * limits on what of it is read. Nothing here is kept after the read.
 */

export type MailFile = { name: string; kind: "pdf" | "png" | "jpeg"; base64: string };

export type MailMessage = {
  /** The sender's address, lower case. */
  from: string;
  subject: string;
  sentAt: Date;
  /** The message's own words, as plain text. */
  text: string;
  files: MailFile[];
};

/** An attached file bigger than this is not read. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Files read per message; the rest are noted as left out. */
export const MAX_FILES_PER_MESSAGE = 3;
/** Characters of a message's own text handed to the reader. */
export const MAX_TEXT_CHARS = 20_000;
/** Messages read in one look at Gmail, across every source. */
export const MAX_MESSAGES_PER_LOOK = 40;
/** Messages found per source in one look (one page of Gmail's list). */
export const MAX_MESSAGES_PER_SOURCE = 25;
/** Messages read for a workspace in any 24 hours, by every road in. */
export const MAX_MESSAGES_PER_DAY = 120;
/** Messages "Try it" reads. */
export const MAX_MESSAGES_PER_TRY = 3;

/**
 * Only PDFs and two kinds of picture are ever read. Some senders' PDFs arrive
 * labelled as plain "octet-stream", so a `.pdf` name counts as well.
 */
export function fileKind(name: string, mimeType: string): MailFile["kind"] | null {
  const type = mimeType.trim().toLowerCase().split(";")[0];
  const lower = name.trim().toLowerCase();
  if (type === "application/pdf") return "pdf";
  if (type === "image/png") return "png";
  if (type === "image/jpeg" || type === "image/jpg") return "jpeg";
  if ((type === "application/octet-stream" || type === "") && lower.endsWith(".pdf")) return "pdf";
  return null;
}

/** Does the file start the way its kind must? A renamed file of another kind is not read. */
export function looksLike(kind: MailFile["kind"], bytes: Uint8Array): boolean {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (kind === "pdf") return starts(0x25, 0x50, 0x44, 0x46);
  if (kind === "png") return starts(0x89, 0x50, 0x4e, 0x47);
  return starts(0xff, 0xd8, 0xff);
}

/**
 * The key a message is known by, from its own Message-ID header: the same
 * message read from Gmail and forwarded to the bills address gets the same
 * key, so it files once. `fallback` is used for the rare message without one.
 */
export function messageKey(rfcMessageId: string | null | undefined, fallback: string): string {
  const id = (rfcMessageId ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
  return createHash("sha256")
    .update(id ? `id:${id}` : `fallback:${fallback}`)
    .digest("hex")
    .slice(0, 32);
}

/** A fingerprint of an uploaded file's bytes: the same file again is the same upload. */
export function uploadKey(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 24);
}

/** Only the newest message: everything from the first quoted reply onwards is history. */
export function topMessage(body: string): string {
  const cut = body.search(/^\s*(From:\s|On .{5,200} wrote:|-{3,}\s*Original Message)/m);
  return cut >= 0 ? body.slice(0, cut) : body;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * For a message forwarded by hand: the address in the "From:" line of the
 * forwarded header inside it ("---------- Forwarded message ---------").
 * Plain matching; null when there is no such line.
 */
export function forwardedSender(text: string): string | null {
  const marker = text.search(
    /^[>\s]*(-{2,}\s*(Forwarded|Original) message\s*-{2,}|Begin forwarded message:)/im,
  );
  if (marker < 0) return null;
  const match = /^[>\s]*From:\s*(?:.*?<)?([^\s<>"']+@[^\s<>"']+?)>?\s*$/im.exec(text.slice(marker));
  const address = match?.[1]?.toLowerCase() ?? "";
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(address) ? address : null;
}

/** The workspace's calendar day (YYYY-MM-DD) of an instant. */
export function dayIn(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
