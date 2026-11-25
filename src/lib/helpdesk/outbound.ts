import { supportAddress, ticketReplyAddress } from "./addresses";
import { ReplyRefused, replySubject } from "./reply";
import { isPlain, richToHtml, richToText, type RichDoc } from "./rich";

/**
 * Mail the team sends from a conversation: a reply, a reply with copies, or
 * a forward. It goes out through the same mail service and from the same
 * support address as before; this only adds who else gets it, simple
 * formatting we write ourselves, and files.
 */

const ADDRESS = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;

/** Addresses typed in a To, Cc or Bcc box: split on commas, semicolons and spaces, each once. */
export function parseRecipients(text: string): { ok: string[]; bad: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const piece of text.split(/[,;\s]+/)) {
    const address = piece.trim().toLowerCase();
    if (!address) continue;
    if (!ADDRESS.test(address) || address.length > 254) bad.push(piece.trim());
    else if (!ok.includes(address)) ok.push(address);
  }
  return { ok, bad };
}

/**
 * Who "Reply all" copies in: everyone the customer's last email was written
 * to, less the customer themselves and every address that is the business's
 * own (the desk's addresses on our mail domain, and the support addresses it
 * forwards from), which would only send the reply straight back to the desk.
 */
export function replyAllCopies(
  last: { from_email: string; to_emails?: string[] | null; cc_emails?: string[] | null } | null,
  own: { domain: string | null; addresses: string[] },
): string[] {
  if (!last) return [];
  const mine = new Set(own.addresses.map((address) => address.trim().toLowerCase()));
  const sender = last.from_email.trim().toLowerCase();
  const out: string[] = [];
  for (const raw of [...(last.to_emails ?? []), ...(last.cc_emails ?? [])]) {
    const address = raw.trim().toLowerCase();
    if (!ADDRESS.test(address) || address === sender || mine.has(address)) continue;
    if (own.domain && address.endsWith(`@${own.domain.toLowerCase()}`)) continue;
    if (!out.includes(address)) out.push(address);
  }
  return out.slice(0, MAX_RECIPIENTS - 1);
}

export const MAX_RECIPIENTS = 10;
export const MAX_FILES = 5;
/** All files on one email together. The page's own upload limit is a little above this. */
export const MAX_FILES_BYTES = 4 * 1024 * 1024;
/** A forward: what was picked plus the conversation's own kept files, together. The mail service takes 10 MB. */
export const MAX_FORWARD_BYTES = 8 * 1024 * 1024;

/**
 * Which of a conversation's kept files ride along on a forward: in the order
 * given, each while it still fits. What doesn't fit is named so the email can
 * say so.
 */
export function pickCarried<T extends { name: string; size: number }>(
  files: T[],
  alreadyBytes: number,
): { carried: T[]; left: T[] } {
  let total = alreadyBytes;
  const carried: T[] = [];
  const left: T[] = [];
  for (const file of files) {
    if (carried.length < 10 && total + file.size <= MAX_FORWARD_BYTES) {
      carried.push(file);
      total += file.size;
    } else left.push(file);
  }
  return { carried, left };
}
/** Kinds of file the mail service refuses, or that nobody should be emailing a customer. */
const REFUSED = /\.(exe|bat|cmd|com|scr|js|vbs|msi|jar|ps1|sh|app|dll|lnk)$/i;

export type OutgoingFile = { name: string; type: string; size: number; base64: string };

/** What is wrong with the files picked, in words, or null when they can go. */
export function filesProblem(files: { name: string; size: number }[]): string | null {
  if (files.length > MAX_FILES) return `An email can carry up to ${MAX_FILES} files.`;
  const refused = files.find((file) => REFUSED.test(file.name));
  if (refused) return `“${refused.name}” is a kind of file that can't be emailed.`;
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_FILES_BYTES) {
    return "Those files are too big to email together (4 MB at most). A link to them works better.";
  }
  return null;
}

export const fileSize = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const forwardSubject = (subject: string) =>
  /^(fwd?|fw):/i.test(subject.trim()) ? subject.trim() : `Fwd: ${subject.trim()}`;

/** The conversation so far, as plain text under a forward. Newest last, the way it was written. */
export function forwardedThread(
  thread: { from: string; at: string; body: string }[],
  limit = 30_000,
): string {
  const parts = thread.map((m) => `From: ${m.from}\nDate: ${m.at}\n\n${m.body.trim()}`);
  const text = `---------- Forwarded conversation ----------\n\n${parts.join("\n\n----------\n\n")}`;
  return text.length > limit ? `${text.slice(0, limit)}\n\n[…cut short]` : text;
}

export type Outgoing = {
  kind: "reply" | "forward";
  workspaceName: string;
  slug: string;
  domain: string;
  replyKey: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  doc: RichDoc;
  /** Plain text added under the person's words (the forwarded conversation). */
  appendix?: string;
  inReplyTo: string | null;
  files: OutgoingFile[];
  /** The automatic first reply: marked so that no other machine answers it. */
  automatic?: boolean;
};

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** The words kept as the message, and sent as the plain-text part. */
export function outgoingText(doc: RichDoc, appendix?: string): string {
  return [richToText(doc), appendix?.trim()].filter(Boolean).join("\n\n");
}

/** The mail service's request. Separate from sending so it can be tested. */
export function buildOutboundRequest(mail: Outgoing) {
  const from = supportAddress(mail.slug, mail.domain);
  const name = mail.workspaceName.replace(/["<>\r\n]/g, "").trim();
  const text = outgoingText(mail.doc, mail.appendix);
  // A plain reply stays a plain email; formatting adds an HTML part we wrote ourselves.
  const html =
    isPlain(mail.doc) && !mail.appendix
      ? null
      : richToHtml(mail.doc) +
        (mail.appendix
          ? `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(mail.appendix.trim())}</pre>`
          : "");
  return {
    From: `"${name}" <${from}>`,
    ReplyTo: ticketReplyAddress(mail.slug, mail.replyKey, mail.domain),
    To: mail.to.join(", "),
    ...(mail.cc.length > 0 ? { Cc: mail.cc.join(", ") } : {}),
    ...(mail.bcc.length > 0 ? { Bcc: mail.bcc.join(", ") } : {}),
    Subject: mail.kind === "forward" ? forwardSubject(mail.subject) : replySubject(mail.subject),
    TextBody: text,
    ...(html ? { HtmlBody: html } : {}),
    MessageStream: "outbound",
    Headers: [
      ...(mail.kind === "reply" && mail.inReplyTo
        ? [
            { Name: "In-Reply-To", Value: mail.inReplyTo },
            { Name: "References", Value: mail.inReplyTo },
          ]
        : []),
      // RFC 3834: say it was sent by a machine, so autoresponders don't answer it.
      ...(mail.automatic
        ? [
            { Name: "Auto-Submitted", Value: "auto-replied" },
            { Name: "X-Auto-Response-Suppress", Value: "All" },
          ]
        : []),
    ],
    ...(mail.files.length > 0
      ? {
          Attachments: mail.files.map((file) => ({
            Name: file.name.replace(/[\r\n"]/g, "").slice(0, 120),
            Content: file.base64,
            ContentType: /^[\w.+-]+\/[\w.+-]+$/.test(file.type)
              ? file.type
              : "application/octet-stream",
          })),
        }
      : {}),
  };
}

/** Sends through Postmark. Returns its id for the message. */
export async function sendOutbound(
  mail: Outgoing,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token)
    throw new Error("Missing environment variable POSTMARK_SERVER_TOKEN. See .env.example.");
  const response = await fetchImpl("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify(buildOutboundRequest(mail)),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => ({}))) as {
    MessageID?: string;
    ErrorCode?: number;
  };
  if (!response.ok || !data.MessageID)
    throw new ReplyRefused(response.status, data.ErrorCode ?? null);
  return data.MessageID;
}
