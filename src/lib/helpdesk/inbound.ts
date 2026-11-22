import { parseSupportAddress } from "./addresses";
import { tagsFor, type AutoTagRules } from "./config";

/** The parts of a Postmark inbound webhook we use. */
export type PostmarkInbound = {
  MessageID?: string;
  From?: string;
  FromName?: string;
  FromFull?: { Email?: string; Name?: string };
  To?: string;
  ToFull?: { Email?: string; MailboxHash?: string }[];
  CcFull?: { Email?: string }[];
  OriginalRecipient?: string;
  Subject?: string;
  TextBody?: string;
  StrippedTextReply?: string;
  HtmlBody?: string;
  Headers?: { Name?: string; Value?: string }[];
};

export type InboundEmail = {
  providerMessageId: string;
  slug: string;
  replyKey: string | null;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  body: string;
  messageId: string | null;
  references: string[];
  /** Mail sent by a machine (auto-replies, bounces): filed, but must never trigger a reply loop. */
  automated: boolean;
};

const MAX_BODY = 50_000;

const header = (email: PostmarkInbound, name: string) =>
  email.Headers?.find((h) => h.Name?.toLowerCase() === name.toLowerCase())?.Value ?? null;

const messageIds = (value: string | null) => value?.match(/<[^<>\s]+>/g) ?? [];

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Turns a Postmark payload into the email we file, or null when it isn't
 * addressed to a workspace on our inbound domain.
 */
export function parseInboundEmail(email: PostmarkInbound, domain: string): InboundEmail | null {
  if (!email.MessageID) return null;
  const recipients = [
    email.OriginalRecipient,
    ...(email.ToFull ?? []).map((to) => to.Email),
    ...(email.CcFull ?? []).map((cc) => cc.Email),
  ].filter((value): value is string => Boolean(value));
  const target = recipients.map((r) => parseSupportAddress(r, domain)).find(Boolean);
  if (!target) return null;

  const fromEmail = (email.FromFull?.Email ?? email.From ?? "").trim().toLowerCase();
  if (!fromEmail.includes("@")) return null;

  // Prefer the new text of a reply over the whole quoted thread.
  const text =
    email.StrippedTextReply?.trim() ||
    email.TextBody?.trim() ||
    (email.HtmlBody ? htmlToText(email.HtmlBody) : "");
  const references = [
    ...messageIds(header(email, "In-Reply-To")),
    ...messageIds(header(email, "References")),
  ];
  const autoSubmitted = header(email, "Auto-Submitted");
  const automated =
    (autoSubmitted !== null && autoSubmitted.toLowerCase() !== "no") ||
    header(email, "X-Autoreply") !== null ||
    /^(mailer-daemon|postmaster|no-?reply)@/.test(fromEmail);

  return {
    providerMessageId: email.MessageID,
    slug: target.slug,
    replyKey: target.replyKey,
    fromEmail,
    fromName: email.FromFull?.Name?.trim() || email.FromName?.trim() || null,
    subject: (email.Subject ?? "").trim(),
    body: text.slice(0, MAX_BODY),
    messageId: messageIds(header(email, "Message-ID"))[0] ?? null,
    references: [...new Set(references)],
    automated,
  };
}

export type IngestResult = {
  result: "unknown_workspace" | "duplicate" | "created" | "threaded";
  tenant_id?: string;
  ticket_id?: string;
  number?: number;
};

export type InboundDeps = {
  /** The workspace's auto-tag rules, by slug; null when there is no such workspace. */
  rulesFor(slug: string): Promise<AutoTagRules | null>;
  ingest(email: InboundEmail, tags: string[]): Promise<IngestResult>;
};

/** Files one queued inbound email. Returns what happened, for the worker's log. */
export async function processInboundEmail(
  payload: PostmarkInbound,
  domain: string,
  deps: InboundDeps,
): Promise<"ignored" | IngestResult["result"]> {
  const email = parseInboundEmail(payload, domain);
  if (!email) return "ignored";
  const rules = await deps.rulesFor(email.slug);
  if (!rules) return "unknown_workspace";
  const tags = tagsFor(rules, email);
  if (email.automated) tags.push("automated");
  return (await deps.ingest(email, tags)).result;
}
