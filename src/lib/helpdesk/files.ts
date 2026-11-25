/**
 * The pictures and files that travel with an email, in or out. Pure: what a
 * file really is (read from its first bytes, never from its name or the type
 * it claims), whether we keep it, and how it is handed back to a browser.
 *
 * Nothing here trusts the sender. A file we don't recognise is not kept; the
 * conversation only notes that it came ("a file we didn't keep").
 */

export const FILES_BUCKET = "helpdesk";

/** One file: 25 MB. The mail service takes about 35 MB a message, so a phone video fits. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** All the kept files on one email together. */
export const MAX_MESSAGE_BYTES = 35 * 1024 * 1024;
/** How many files one email can leave behind (kept or not). */
export const MAX_MESSAGE_FILES = 20;
/** What one workspace can keep in a day, in and out together. */
export const MAX_DAILY_BYTES = 500 * 1024 * 1024;

export const KEPT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "application/pdf",
  "video/mp4",
  "video/quicktime",
  "text/plain",
  "text/csv",
] as const;
export type KeptType = (typeof KEPT_TYPES)[number];

export const isKeptType = (value: unknown): value is KeptType =>
  KEPT_TYPES.some((type) => type === value);

/** Types a browser may draw in the page. Everything else is only ever a download. */
const INLINE_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "video/mp4",
  "video/quicktime",
]);
/** Pictures every browser can draw (HEIC is a download unless the browser manages it). */
export const isPicture = (type: string) =>
  type === "image/jpeg" || type === "image/png" || type === "image/gif" || type === "image/webp";
export const isVideo = (type: string) => type === "video/mp4" || type === "video/quicktime";

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, Math.min(to, bytes.length)));
const starts = (bytes: Uint8Array, ...sig: number[]) =>
  bytes.length >= sig.length && sig.every((value, i) => bytes[i] === value);

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "M4V ",
  "mmp4",
  "3gp4",
  "3gp5",
  "dash",
]);

/** Markup and scripts dressed up as text. */
const LOOKS_LIKE_MARKUP = /<\s*(!doctype|html|head|body|svg|script|iframe|object|embed|\?xml)\b/i;

function isPlainText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 64 * 1024);
  for (const byte of sample) {
    // Control characters other than tab, line feed and carriage return.
    if (byte < 9 || (byte > 13 && byte < 32) || byte === 11 || byte === 12) return false;
  }
  let text: string;
  try {
    // A sample can end mid-character, so only the whole file is held to strict UTF-8.
    text = new TextDecoder("utf-8", { fatal: sample.length === bytes.length }).decode(sample);
  } catch {
    return false;
  }
  return !LOOKS_LIKE_MARKUP.test(text);
}

/**
 * What a file is, from its own first bytes. Text has no signature, so it is
 * only believed when the sender also called it text or CSV and it reads as
 * plain words with no markup. Null means "not one of the kinds we keep".
 */
export function sniffType(
  bytes: Uint8Array,
  declared: { type?: string | null; name?: string | null } = {},
): KeptType | null {
  if (bytes.length === 0) return null;
  if (starts(bytes, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  const head = ascii(bytes, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (HEIC_BRANDS.has(brand)) return "image/heic";
    if (brand === "qt  ") return "video/quicktime";
    if (MP4_BRANDS.has(brand)) return "video/mp4";
    return null;
  }
  const type = (declared.type ?? "").split(";")[0].trim().toLowerCase();
  const name = (declared.name ?? "").toLowerCase();
  const saysCsv = type === "text/csv" || name.endsWith(".csv");
  const saysText = type === "text/plain" || name.endsWith(".txt");
  if ((saysCsv || saysText) && isPlainText(bytes)) return saysCsv ? "text/csv" : "text/plain";
  return null;
}

/**
 * A file's name as people will read it: no path, no control or direction
 * characters, a sensible length. It is only ever shown as text and sent in a
 * header we quote; it is never part of where the file is stored.
 */
export function displayName(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const base = text.split(/[\\/]/).pop() ?? "";
  const clean = base
    // Control characters, and the marks that reverse text to disguise an extension.
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/["<>|:*?]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!clean) return "file";
  if (clean.length <= 120) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : "";
  return clean.slice(0, 120 - ext.length) + ext;
}

/** The type a sender claimed, tidied enough to show for a file we didn't keep. Never trusted. */
export function claimedType(raw: unknown): string {
  const text = (typeof raw === "string" ? raw : "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]{0,40}\/[a-z0-9][a-z0-9.+-]{0,60}$/.test(text) ? text : "unknown";
}

/** A Content-ID as mail writes it ("<abc@x>") down to the bare id an image refers to. */
export function contentId(raw: unknown): string | null {
  const text = (typeof raw === "string" ? raw : "").trim().replace(/^<|>$/g, "");
  return text && text.length <= 200 && !/[\s<>"]/.test(text) ? text : null;
}

export type IncomingFile = {
  name: string;
  /** The type the sender claimed. Shown for files we don't keep; never trusted. */
  claimed: string;
  bytes: Uint8Array;
  contentId: string | null;
  /** The size the sender stated, for a file whose content never arrived. */
  statedSize?: number;
};

export type NotKeptReason = "type" | "too_big" | "message_cap" | "daily_cap" | "failed";

export type FilePlan = {
  name: string;
  type: string;
  size: number;
  contentId: string | null;
} & ({ keep: true; bytes: Uint8Array } | { keep: false; reason: NotKeptReason });

/**
 * Decides, file by file, what is kept. Order matters only for the caps: the
 * first files that fit are the ones kept. A file that isn't kept is still
 * written down with its name, the type it claimed and its size.
 */
export function planFiles(files: IncomingFile[], usedToday: number): FilePlan[] {
  let message = 0;
  let day = Math.max(0, usedToday);
  return files.slice(0, MAX_MESSAGE_FILES).map((file): FilePlan => {
    const size = file.bytes.length || Math.max(0, Math.round(file.statedSize ?? 0));
    const base = { name: displayName(file.name), size, contentId: file.contentId };
    const skip = (reason: NotKeptReason): FilePlan => ({
      ...base,
      type: claimedType(file.claimed),
      keep: false,
      reason,
    });
    if (size > MAX_FILE_BYTES) return skip("too_big");
    const type = sniffType(file.bytes, { type: file.claimed, name: file.name });
    if (!type) return skip("type");
    if (message + size > MAX_MESSAGE_BYTES) return skip("message_cap");
    if (day + size > MAX_DAILY_BYTES) return skip("daily_cap");
    message += size;
    day += size;
    return { ...base, type, keep: true, bytes: file.bytes };
  });
}

/** Why a file wasn't kept, in a few plain words. */
export function notKeptWords(reason: string | null): string {
  switch (reason) {
    case "too_big":
      return "too big to keep";
    case "message_cap":
      return "this email carried more than we keep";
    case "daily_cap":
      return "today's file allowance was used up";
    case "failed":
      return "it couldn't be saved";
    default:
      return "not a kind of file we keep";
  }
}

/**
 * The headers a kept file is served with. Only pictures, PDFs and video are
 * shown in the page; anything else comes down as a download. The type is the
 * one we worked out from the bytes, the browser is told not to guess, and the
 * file may load nothing and run nothing.
 */
export function fileHeaders(
  file: { name: string; mime_type: string; bytes?: number | null },
  options: { download?: boolean } = {},
): Record<string, string> {
  const type = isKeptType(file.mime_type) ? file.mime_type : "application/octet-stream";
  const inline = INLINE_TYPES.has(type) && !options.download;
  const name = displayName(file.name);
  // An ASCII stand-in, plus the real name in the form browsers read for other alphabets.
  const plain = name.replace(/[^\x20-\x7e]/g, "_").replace(/[\\"]/g, "_");
  const headers: Record<string, string> = {
    "content-type": type.startsWith("text/") ? "text/plain; charset=utf-8" : type,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "x-content-type-options": "nosniff",
    // A PDF is drawn by the browser's own viewer, which a sandbox would switch off.
    "content-security-policy": `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; ${
      type === "application/pdf" ? "object-src 'self'" : "sandbox"
    }`,
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
  };
  if (file.bytes && file.bytes > 0) headers["content-length"] = String(file.bytes);
  return headers;
}

/** Where a kept file lives: under the workspace, the conversation and the message, with a name of our own. */
export function storagePath(
  tenantId: string,
  ticketId: string,
  messageId: string,
  random: string,
): string {
  return `${tenantId}/${ticketId}/${messageId}/${random}`;
}

/** Decodes the base64 a mail service hands over. Bad input is an empty file, which is never kept. */
export function fromBase64(content: unknown): Uint8Array {
  if (typeof content !== "string" || content.length === 0) return new Uint8Array();
  try {
    return new Uint8Array(Buffer.from(content, "base64"));
  } catch {
    return new Uint8Array();
  }
}

/**
 * A line telling a drafting prompt that a message carried files: their names
 * and kinds only. The files themselves are never sent to the model.
 */
export function filesNote(files: { name: string; mime_type: string }[]): string {
  if (files.length === 0) return "";
  const list = files
    .slice(0, 12)
    .map((file) => `${displayName(file.name).slice(0, 60)} (${claimedType(file.mime_type)})`)
    .join(", ");
  return `\n\n[This email came with ${files.length === 1 ? "a file" : `${files.length} files`}, which you cannot see: ${list}]`;
}
