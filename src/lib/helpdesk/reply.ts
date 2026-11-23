import { supportAddress, ticketReplyAddress } from "./addresses";

export type OutgoingReply = {
  workspaceName: string;
  slug: string;
  domain: string;
  replyKey: string;
  to: string;
  subject: string;
  body: string;
  /** The customer's last Message-ID, so their mail app threads our reply. */
  inReplyTo: string | null;
};

export const replySubject = (subject: string) =>
  /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;

/** The Postmark request for a reply. Separate from sending so it can be tested. */
export function buildReplyRequest(reply: OutgoingReply) {
  const from = supportAddress(reply.slug, reply.domain);
  // Quotes and angle brackets would break the From header.
  const name = reply.workspaceName.replace(/["<>\r\n]/g, "").trim();
  return {
    From: `"${name}" <${from}>`,
    // Replies come back to this ticket, whatever the customer's mail app does to the headers.
    ReplyTo: ticketReplyAddress(reply.slug, reply.replyKey, reply.domain),
    To: reply.to,
    Subject: replySubject(reply.subject),
    TextBody: reply.body,
    MessageStream: "outbound",
    Headers: reply.inReplyTo
      ? [
          { Name: "In-Reply-To", Value: reply.inReplyTo },
          { Name: "References", Value: reply.inReplyTo },
        ]
      : [],
  };
}

/** Sends a reply through Postmark. Returns Postmark's id for the message. */
export async function sendReply(
  reply: OutgoingReply,
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
    body: JSON.stringify(buildReplyRequest(reply)),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json().catch(() => ({}))) as {
    MessageID?: string;
    Message?: string;
    ErrorCode?: number;
  };
  if (!response.ok || !data.MessageID) {
    throw new ReplyRefused(response.status, data.ErrorCode ?? null);
  }
  return data.MessageID;
}

/**
 * The mail service said no. Its numeric code says why; its message is not
 * kept, because it can quote the customer's address.
 */
export class ReplyRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
  ) {
    super(`Postmark refused the reply (${status}, code ${code ?? "none"})`);
  }
}

/** What to tell the person who pressed send, in words they can act on. */
export function replyProblem(err: unknown): string {
  const code = err instanceof ReplyRefused ? err.code : null;
  // The sending address or its domain hasn't been confirmed with the mail service.
  if (code === 400 || code === 401) {
    return "Replies can't be sent yet: the support address hasn't been confirmed for sending. Nothing was sent. Whoever set up email for this workspace needs to verify the sending domain.";
  }
  // A new mail account that hasn't been approved can only write to its own domain.
  if (code === 412) {
    return "Replies can't go to outside addresses yet: the email account is still waiting for approval from the mail service. Nothing was sent.";
  }
  if (code === 406) {
    return "This address has bounced or complained before, so the mail service won't send to it. Nothing was sent.";
  }
  if (code === 300) {
    return "That customer's email address doesn't look right, so the reply couldn't be sent.";
  }
  return "We couldn't send that reply. Nothing was sent; try again in a moment.";
}
