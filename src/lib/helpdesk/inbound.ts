import { parseSupportAddress } from "./addresses";
import { looksAutomated } from "./auto-reply/rules";
import { actionsFor, type AutoTagRules, type RuleOutcome } from "./config";
import { contentId, fromBase64, type IncomingFile } from "./files";

/** The parts of a Postmark inbound webhook we use. */
export type PostmarkInbound = {
  MessageID?: string;
  From?: string;
  FromName?: string;
  FromFull?: { Email?: string; Name?: string };
  To?: string;
  ToFull?: { Email?: string; MailboxHash?: string }[];
  Cc?: string;
  CcFull?: { Email?: string }[];
  OriginalRecipient?: string;
  Subject?: string;
  TextBody?: string;
  StrippedTextReply?: string;
  HtmlBody?: string;
  Headers?: { Name?: string; Value?: string }[];
  /** Files and the pictures set into the email, as base64. */
  Attachments?: {
    Name?: string;
    Content?: string;
    ContentType?: string;
    ContentLength?: number;
    ContentID?: string;
  }[];
};

export type InboundEmail = {
  providerMessageId: string;
  slug: string;
  replyKey: string | null;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  body: string;
  /** Who else the email was written to, so "Reply all" can include them. Never our own inbound addresses. */
  to: string[];
  cc: string[];
  messageId: string | null;
  references: string[];
  /** Mail sent by a machine (auto-replies, bounces): filed, but must never trigger a reply loop. */
  automated: boolean;
  /**
   * Wider than `automated`: anything the automatic first reply must stay
   * away from (bulk and list mail, bounces, no-reply senders as well).
   */
  noAutoReply: boolean;
};

const MAX_BODY = 50_000;

const header = (email: PostmarkInbound, name: string) =>
  email.Headers?.find((h) => h.Name?.toLowerCase() === name.toLowerCase())?.Value ?? null;

const messageIds = (value: string | null) => value?.match(/<[^<>\s]+>/g) ?? [];

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
};

const codePoint = (value: number) =>
  value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : "";

/**
 * An HTML email as plain words we can keep: paragraphs and line breaks stay,
 * list items get a dash, a link keeps its address beside its words, a quoted
 * block becomes "> " lines (so it folds like any quoted reply), and a picture
 * set into the email leaves a "[cid:…]" mark where it stood. No markup
 * survives: what comes out is only ever shown as text.
 */
export function htmlToText(html: string): string {
  let quoted = 0;
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script|head|title|svg|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(
      /<a\b[^>]*?\bhref\s*=\s*["'](https?:[^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_whole, href: string, inner: string) => {
        const words = inner.replace(/<[^>]+>/g, "").trim();
        return !words || words === href || href.includes(words) ? href : `${words} (${href})`;
      },
    )
    .replace(/\r?\n/g, " ")
    .replace(/<img\b[^>]*?\bsrc\s*=\s*["']?cid:([^"'\s>]+)[^>]*>/gi, "\n[cid:$1]\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<hr\b[^>]*>/gi, "\n----------\n")
    .replace(/<\/(td|th)\s*>/gi, " ")
    .replace(
      /<(\/?)blockquote\b[^>]*>/gi,
      (_whole, close: string) => `\n\u0001${close ? "-" : "+"}\n`,
    )
    .replace(/<\/(p|div|tr|h[1-6]|table|ul|ol|section|article|header|footer|pre)\s*>/gi, "\n")
    .replace(/<(p|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_whole, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_whole, dec: string) => codePoint(Number(dec)))
    .replace(/&([a-z]{2,8});/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .flatMap((line) => {
      if (line === "\u0001+") {
        quoted += 1;
        return [];
      }
      if (line === "\u0001-") {
        quoted = Math.max(0, quoted - 1);
        return [];
      }
      return [quoted > 0 && line ? `${"> ".repeat(Math.min(quoted, 3))}${line}` : line];
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The words of an incoming email. The whole plain-text part is kept, quoted
 * history and signature included: the conversation folds the quoted part away
 * when it is shown, so nothing a customer wrote can be lost to a guess made
 * here. (The mail service's own "just the reply" guess is only a last resort:
 * on a forward or a short note above a signature it can come back holding
 * nothing but the signature.) An email with no plain-text part is read out of
 * its HTML.
 */
export function chooseBody(
  email: Pick<PostmarkInbound, "TextBody" | "HtmlBody" | "StrippedTextReply">,
): string {
  const text = (email.TextBody ?? "").replace(/\r\n?/g, "\n").trim();
  if (text) return text;
  const fromHtml = email.HtmlBody ? htmlToText(email.HtmlBody) : "";
  if (fromHtml) return fromHtml;
  return (email.StrippedTextReply ?? "").replace(/\r\n?/g, "\n").trim();
}

const ADDRESS = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;

/** The other people on an email: lower-cased, each once, never an address on our own inbound domain. */
function others(
  list: ({ Email?: string } | undefined)[] | undefined,
  domain: string,
  skip: string[],
) {
  const out: string[] = [];
  for (const entry of list ?? []) {
    const address = (entry?.Email ?? "").trim().toLowerCase();
    if (!ADDRESS.test(address) || address.length > 254) continue;
    if (address.endsWith(`@${domain}`) || skip.includes(address) || out.includes(address)) continue;
    out.push(address);
    if (out.length >= 10) break;
  }
  return out;
}

/** The files and set-in pictures an email carried, decoded. Capped so one email can't flood the worker. */
export function inboundFiles(email: Pick<PostmarkInbound, "Attachments">): IncomingFile[] {
  return (Array.isArray(email.Attachments) ? email.Attachments : []).slice(0, 40).map((file) => ({
    name: typeof file?.Name === "string" ? file.Name : "",
    claimed: typeof file?.ContentType === "string" ? file.ContentType : "",
    bytes: fromBase64(file?.Content),
    contentId: contentId(file?.ContentID),
    statedSize: typeof file?.ContentLength === "number" ? file.ContentLength : undefined,
  }));
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

  const text = chooseBody(email);
  const to = others(email.ToFull, domain, [fromEmail]);
  const cc = others(email.CcFull, domain, [fromEmail, ...to]);
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
    to,
    cc,
    messageId: messageIds(header(email, "Message-ID"))[0] ?? null,
    references: [...new Set(references)],
    automated,
    noAutoReply:
      automated ||
      looksAutomated(
        Object.fromEntries((email.Headers ?? []).map((h) => [h.Name ?? "", h.Value ?? ""])),
        fromEmail,
      ),
  };
}

export type IngestResult = {
  result: "unknown_workspace" | "duplicate" | "created" | "threaded";
  tenant_id?: string;
  ticket_id?: string;
  message_id?: string;
  number?: number;
  /** Where the conversation sat when the email arrived ("spam" and "trash" stay put). */
  kept_in?: string | null;
};

export type InboundDeps = {
  /** The workspace's auto-tag rules, by slug; null when there is no such workspace. */
  rulesFor(slug: string): Promise<AutoTagRules | null>;
  ingest(email: InboundEmail, tags: string[]): Promise<IngestResult>;
  /** Called once for a brand-new conversation, with what the rules decided. */
  onCreated?(email: InboundEmail, result: IngestResult, outcome: RuleOutcome): Promise<void>;
  /** Keeps the email's files. Called for a filed email, and again for one seen before, so a retry can finish the job. */
  keepFiles?(result: IngestResult, files: IncomingFile[]): Promise<void>;
  /**
   * Looks at a filed email for the automatic first reply (fixed words from
   * Settings; the rules live in `auto-reply/rules.ts`). Trouble here never
   * stops the email being filed.
   */
  autoReply?(email: InboundEmail, result: IngestResult): Promise<void>;
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
  const outcome = actionsFor(rules, { ...email, from: email.fromEmail });
  const tags = [...outcome.tags];
  if (email.automated) tags.push("automated");
  const result = await deps.ingest(email, tags);
  // Rules and the heads-up first: if keeping the files fails, the retry finds
  // the email already filed ("duplicate") and only finishes the files.
  if (result.result === "created") await deps.onCreated?.(email, result, outcome);
  // Asked for an email seen before as well: the claim is once per email, so a
  // retry only finishes what the first try didn't get to.
  if (result.result !== "unknown_workspace" && result.message_id && deps.autoReply) {
    await deps.autoReply(email, result).catch(() => undefined);
  }
  if (result.result !== "unknown_workspace" && result.message_id && deps.keepFiles) {
    const files = inboundFiles(payload);
    if (files.length > 0) await deps.keepFiles(result, files);
  }
  return result.result;
}
