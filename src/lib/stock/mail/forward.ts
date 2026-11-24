import { moduleOpen } from "../../module-access";
import {
  claudeAllowanceLeft,
  intakeMessage,
  loadWorkspace,
  messageSeen,
  messagesLeftToday,
  noteUnread,
  recordTokens,
  turnedAwayToday,
  type IntakeDeps,
} from "./intake";
import {
  MAX_FILES_PER_MESSAGE,
  MAX_FILE_BYTES,
  fileKind,
  forwardedSender,
  htmlToText,
  looksLike,
  messageKey,
  type MailFile,
  type MailMessage,
} from "./message";
import type { Skipped } from "./plan";
import { fileSkipped, matchSource, type SourceMatch } from "./query";

/**
 * "Bills by email": mail a workspace forwards to its own private address,
 * `bills-<token>@<the inbound domain>`. It arrives through the same webhook
 * and queue as the help desk's mail; the worker hands anything addressed to
 * a bills address here, and it never becomes a ticket.
 *
 * The token is the only thing that says whose mail it is. It is treated like
 * a secret: never logged, never part of an error message.
 */

const TOKEN = /^bills-([0-9a-f]{32})@(.+)$/;

/** The address a workspace forwards its bills to. */
export function billsAddress(token: string, domain: string): string {
  return `bills-${token}@${domain}`;
}

/** The token out of a recipient address, when it is a bills address on our domain. */
export function parseBillsAddress(address: string, domain: string): string | null {
  const match = TOKEN.exec(address.trim().toLowerCase());
  return match && match[2] === domain ? match[1] : null;
}

/** The parts of a Postmark inbound webhook the bills reader uses. */
export type ForwardedPayload = {
  MessageID?: string;
  From?: string;
  FromFull?: { Email?: string };
  ToFull?: { Email?: string }[];
  CcFull?: { Email?: string }[];
  BccFull?: { Email?: string }[];
  OriginalRecipient?: string;
  Subject?: string;
  Date?: string;
  TextBody?: string;
  HtmlBody?: string;
  Headers?: { Name?: string; Value?: string }[];
  Attachments?: { Name?: string; Content?: string; ContentType?: string; ContentLength?: number }[];
};

/** Is this message for a bills address? Looked at before the help desk sees it. */
export function billsTokenOf(payload: ForwardedPayload, domain: string): string | null {
  const recipients = [
    payload.OriginalRecipient,
    ...(payload.ToFull ?? []).map((to) => to.Email),
    ...(payload.CcFull ?? []).map((cc) => cc.Email),
    ...(payload.BccFull ?? []).map((bcc) => bcc.Email),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const recipient of recipients) {
    const token = parseBillsAddress(recipient, domain);
    if (token) return token;
  }
  return null;
}

const header = (payload: ForwardedPayload, name: string) =>
  payload.Headers?.find((h) => h.Name?.toLowerCase() === name.toLowerCase())?.Value?.trim() ?? null;

/** Gmail's own sender for "confirm this forwarding address". */
const GMAIL_CONFIRM_SENDER = "forwarding-noreply@google.com";
/** The only places a confirmation link may point for us to show it. */
const GOOGLE_HOSTS = new Set(["mail.google.com", "mail-settings.google.com"]);

export type ForwardConfirmation = {
  code: string | null;
  link: string | null;
  account: string | null;
};

/**
 * When someone adds the bills address as a forwarding address in Gmail,
 * Gmail writes to the address with a code and a link to confirm it. Known by
 * who sent it; the code is the long number in it, and the link is kept only
 * if it points at Google's own mail site. We never open the link: it is shown
 * to a manager, who presses it themselves.
 */
export function gmailConfirmation(payload: ForwardedPayload): ForwardConfirmation | null {
  const from = (payload.FromFull?.Email ?? payload.From ?? "").trim().toLowerCase();
  if (from !== GMAIL_CONFIRM_SENDER && !from.endsWith(`<${GMAIL_CONFIRM_SENDER}>`)) return null;
  const subject = payload.Subject ?? "";
  const text = payload.TextBody?.trim() || (payload.HtmlBody ? htmlToText(payload.HtmlBody) : "");
  const code = /\(#\s*(\d{4,12})\)/.exec(subject)?.[1] ?? /\b(\d{6,12})\b/.exec(text)?.[1] ?? null;
  let link: string | null = null;
  for (const candidate of text.match(/https:\/\/[^\s<>"')\]]+/g) ?? []) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && GOOGLE_HOSTS.has(url.hostname) && candidate.length <= 600) {
        link = url.toString();
        break;
      }
    } catch {
      // Not an address: ignore it.
    }
  }
  const account =
    /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i.exec(subject)?.[0]?.toLowerCase() ?? null;
  return { code, link, account };
}

/** The message as the reader sees it, with what was left out of its files and why. */
export function forwardedMessage(
  payload: ForwardedPayload,
  now: Date,
): { message: MailMessage; notes: Skipped[]; rfcMessageId: string | null } {
  const from = (payload.FromFull?.Email ?? payload.From ?? "").trim().toLowerCase();
  const sent = payload.Date ? new Date(payload.Date) : now;
  const files: MailFile[] = [];
  const notes: Skipped[] = [];
  for (const att of payload.Attachments ?? []) {
    const name = (att.Name ?? "").slice(0, 300) || "a file";
    const kind = fileKind(att.Name ?? "", att.ContentType ?? "");
    if (!kind || typeof att.Content !== "string") continue;
    // Base64 is four characters to three bytes: sized before it is decoded.
    if (
      Number(att.ContentLength ?? 0) > MAX_FILE_BYTES ||
      att.Content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4
    ) {
      notes.push({ what: name, reason: "the file is over 5 MB — add it by hand" });
      continue;
    }
    if (files.length >= MAX_FILES_PER_MESSAGE) {
      notes.push({
        what: name,
        reason: `only the first ${MAX_FILES_PER_MESSAGE} files of a message are read`,
      });
      continue;
    }
    const bytes = Buffer.from(att.Content, "base64");
    if (!looksLike(kind, bytes)) {
      notes.push({ what: name, reason: "the file isn't what its name says it is" });
      continue;
    }
    files.push({ name, kind, base64: bytes.toString("base64") });
  }
  return {
    message: {
      from: /^[^\s@<>",;]+@[^\s@<>",;]+$/.test(from) ? from.slice(0, 200) : "",
      subject: (payload.Subject ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      sentAt: Number.isNaN(sent.getTime()) || sent > now ? now : sent,
      text: payload.TextBody?.trim() || (payload.HtmlBody ? htmlToText(payload.HtmlBody) : ""),
      files,
    },
    notes,
    rfcMessageId: header(payload, "Message-ID"),
  };
}

export type ForwardDeps = IntakeDeps & {
  /** Which workspace a token is for (and notes that mail arrived); null for nobody's. */
  tenantFor(token: string): Promise<string | null>;
  stockOpen?(tenantId: string): Promise<boolean>;
};

export type ForwardOutcome =
  | "dropped"
  | "confirmation"
  | "repeated"
  | "over_limit"
  | "filed"
  | "to_check"
  | "unassigned"
  | "skipped";

/**
 * Deals with one message sent to a bills address. Throws only for trouble
 * worth another try (the queue retries it); everything else ends here, so the
 * queued copy is cleared.
 */
export async function processForwardedBill(
  payload: ForwardedPayload,
  token: string,
  deps: ForwardDeps,
): Promise<ForwardOutcome> {
  const { admin } = deps;
  const tenantId = await deps.tenantFor(token);
  // A token nobody has (never made, or replaced by a new address): dropped quietly.
  if (!tenantId) return "dropped";
  const open = deps.stockOpen ?? ((id: string) => moduleOpen(id, "stock", admin));
  if (!(await open(tenantId))) return "dropped";

  const confirmation = gmailConfirmation(payload);
  if (confirmation) {
    const { error } = await admin.rpc("note_bills_confirmation", {
      p_tenant_id: tenantId,
      p_code: confirmation.code ?? "",
      p_link: confirmation.link,
      p_for: confirmation.account,
    });
    if (error) throw new Error(`note_bills_confirmation failed: ${error.message}`);
    return "confirmation";
  }

  const ws = await loadWorkspace(tenantId, admin);
  if (!ws) return "dropped";
  const now = deps.now();
  const { message, notes, rfcMessageId } = forwardedMessage(payload, now);
  const record = {
    messageKey: messageKey(rfcMessageId, `postmark:${payload.MessageID ?? ""}`),
    route: "forward" as const,
    gmailId: null,
    threadId: null,
  };
  const closeRun = async (
    counts: Record<string, number | boolean>,
    skipped: Skipped[],
  ): Promise<void> => {
    const { error } = await admin.rpc("record_stock_email_read", {
      p_tenant_id: tenantId,
      p_source: "forward",
      p_counts: counts,
      p_skipped: skipped.slice(0, 60),
    });
    if (error) console.error(`could not record a forwarded read: ${error.message}`);
  };

  // Already here (read from Gmail, or forwarded twice)? Then there is nothing to do.
  if (await messageSeen(tenantId, admin, record.messageKey)) return "repeated";

  // The caps hold for every road in. What is over is written down, not read.
  const left = await messagesLeftToday(tenantId, admin, now);
  const allowance = left > 0 ? await claudeAllowanceLeft(tenantId, admin, now) : 0;
  if (left <= 0 || allowance <= 0) {
    const reason: Skipped = {
      what: message.subject || "a forwarded message",
      reason:
        left <= 0
          ? "today's limit on messages read was reached — forward it again tomorrow, or add it by hand"
          : "this month's Claude allowance is used up — add it by hand",
    };
    // Past the limit a flood leaves a few lines behind, not thousands.
    if ((await turnedAwayToday(tenantId, admin, now)) < 5) {
      await closeRun({ seen: 1, read: 0, filed: 0, to_check: 0, skipped: 1, capped: true }, [
        reason,
      ]);
    }
    return "over_limit";
  }

  // Whose is it? An automatic forward keeps the first sender; a forward by
  // hand names them inside the message. Both are held against the
  // workspace's own list, and nothing is guessed.
  const inside = forwardedSender(message.text);
  const place = (sender: string | null): SourceMatch | null =>
    sender ? matchSource(ws.sources, sender, message.subject, message.text) : null;
  const first = place(message.from) ?? place(inside);
  if (first?.kind === "bank-other") {
    // The bank's notice about somebody we weren't asked to follow: not read.
    await noteUnread(
      ws,
      record,
      message,
      {
        what: message.subject || "a bank notice",
        reason: first.several
          ? "it matches more than one supplier's words — add the payment by hand"
          : "a bank notice that isn't about a supplier you listed, so it wasn't read",
      },
      deps,
    );
    return "skipped";
  }
  const skipWords = first?.kind === "supplier" ? first.source.skip_file_words : [];
  const kept = message.files.filter((file) => {
    if (!fileSkipped(file.name, skipWords)) return true;
    notes.push({ what: file.name, reason: "its name is on this source's “never read” list" });
    return false;
  });

  const result = await intakeMessage(
    ws,
    {
      record,
      message: { ...message, files: kept },
      match:
        first ??
        ((originalSender) => {
          const late = place(originalSender);
          return late && late.kind !== "bank-other" ? late : null;
        }),
      notes,
    },
    deps,
  );
  await recordTokens(admin, tenantId, result.tokens);
  if (result.outcome === "repeated") return "repeated";
  await closeRun(
    {
      seen: 1,
      read: result.tokens > 0 ? 1 : 0,
      filed: result.filed,
      to_check: result.toCheck,
      skipped: result.skipped.length,
      capped: false,
    },
    result.skipped,
  );
  return result.outcome;
}
