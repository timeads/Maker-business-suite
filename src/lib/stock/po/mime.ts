/**
 * Builds the raw email Gmail's messages.send takes (ported from TuftStock's
 * src/lib/gmail/mime.ts, with a Cc line added): a plain-text message with one
 * attachment, the order's PDF, as RFC 2822 / MIME, then base64url. Pure, and
 * with no library.
 *
 * A resend passes `inReplyTo` (the Message-ID of the first send) so the
 * supplier's mail program files it in the same conversation; Gmail keeps it
 * in the thread by threadId.
 */

export interface MimeMessage {
  from: { name?: string | null; email: string };
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  attachment: { filename: string; contentType: string; content: Buffer };
  /** Our own Message-ID, e.g. "<po-abc123@example.com>". */
  messageId: string;
  /** Message-ID this replies to (a resend of the order). */
  inReplyTo?: string | null;
  /** Fixed in tests. */
  boundary?: string;
}

const CRLF = "\r\n";
const PLAIN = /^[\x20-\x7e]*$/;
const BREAKS = /[\r\n\x00]+/g;

/** A header can never carry a line break: that is how one header is turned into two. */
const oneLine = (value: string) => value.replace(BREAKS, " ").trim();

/** "Purchase order — Nov" → RFC 2047 encoded-words when it isn't plain ASCII. */
export function encodeHeader(input: string): string {
  const value = oneLine(input);
  if (PLAIN.test(value)) return value;
  // Split on whole characters so no UTF-8 sequence is cut across encoded-words.
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words
    .map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`)
    .join(`${CRLF} `);
}

function mailbox(m: { name?: string | null; email: string }): string {
  const email = oneLine(m.email).replace(/[<>\s]/g, "");
  const name = oneLine(m.name ?? "");
  if (!name) return email;
  return PLAIN.test(name)
    ? `"${name.replace(/(["\\])/g, "\\$1")}" <${email}>`
    : `${encodeHeader(name)} <${email}>`;
}

/** Base64, wrapped at 76 characters as MIME requires. */
function base64Lines(buf: Buffer): string {
  return (buf.toString("base64").match(/.{1,76}/g) ?? []).join(CRLF);
}

/** A filename safe to put in a quoted header parameter. */
function safeFilename(name: string): string {
  return name.replace(/["\\\r\n\x00]/g, "_").replace(/[^\x20-\x7e]/g, "_");
}

const addresses = (list: string[]) =>
  list.map((address) => oneLine(address).replace(/[<>\s,;]/g, "")).filter(Boolean);

export function buildMime(m: MimeMessage): string {
  const boundary =
    m.boundary ?? `mbs-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const file = safeFilename(m.attachment.filename);
  const cc = addresses(m.cc ?? []);
  const headers = [
    `From: ${mailbox(m.from)}`,
    `To: ${addresses(m.to).join(", ")}`,
    ...(cc.length > 0 ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encodeHeader(m.subject)}`,
    `Message-ID: ${oneLine(m.messageId)}`,
    ...(m.inReplyTo
      ? [`In-Reply-To: ${oneLine(m.inReplyTo)}`, `References: ${oneLine(m.inReplyTo)}`]
      : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const text = m.text.replace(/\r?\n/g, CRLF);
  return [
    ...headers,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(text, "utf8")),
    `--${boundary}`,
    `Content-Type: ${m.attachment.contentType}; name="${file}"`,
    `Content-Disposition: attachment; filename="${file}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(m.attachment.content),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}

/** What messages.send wants in `raw`. */
export function toRaw(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}

/** A fresh Message-ID on the sender's own domain. */
export function newMessageId(
  fromEmail: string,
  random = Math.random().toString(36).slice(2) + Date.now().toString(36),
): string {
  const domain = (fromEmail.split("@")[1] ?? "").replace(/[^A-Za-z0-9.-]/g, "") || "mail.invalid";
  return `<po-${random.replace(/[^A-Za-z0-9]/g, "")}@${domain}>`;
}

/** "a@x.example, B <b@x.example>; bad" → valid addresses, and the entries that aren't. */
export function parseRecipients(s: string): { ok: string[]; bad: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const part of s
    .split(/[,;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)) {
    const addr = part.match(/<([^>]+)>$/)?.[1]?.trim() ?? part;
    if (/^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/.test(addr)) {
      if (!ok.some((e) => e.toLowerCase() === addr.toLowerCase())) ok.push(addr);
    } else bad.push(part);
  }
  return { ok, bad };
}
