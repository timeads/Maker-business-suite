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
  };
  if (!response.ok || !data.MessageID) {
    throw new Error(`Postmark refused the reply (${response.status})`);
  }
  return data.MessageID;
}
