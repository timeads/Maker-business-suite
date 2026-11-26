type InviteEmail = {
  to: string;
  workspaceName: string;
  inviterEmail: string | undefined;
  link: string;
};

/**
 * How a send went, told apart so a caller that keeps a record can decide
 * what happens next:
 *  - `sent`: the mail service took it.
 *  - `refused`: it said no, or we never reached it; trying again may work.
 *  - `rejected`: it said no for good (an address that can't be written to).
 *  - `unsure`: we asked and never heard back, so it may have gone.
 *  - `off`: email isn't set up here; nothing was tried.
 */
export type Delivery = {
  outcome: "sent" | "refused" | "rejected" | "unsure" | "off";
  /** A few plain words for the record. Never the message or a key. */
  detail: string;
};

export const emailConfigured = () =>
  Boolean(process.env.POSTMARK_SERVER_TOKEN && process.env.EMAIL_FROM);

/** Postmark's own codes for an address that will never work: not valid, or switched off. */
const DEAD_ADDRESS = new Set([300, 406]);
/** Failures that happen before a single byte leaves, so nothing can have been sent. */
const NEVER_LEFT = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);

/** Sends a plain-text email through Postmark and says exactly how it went. */
export async function deliverEmail(
  message: { to: string; subject: string; text: string; replyTo?: string },
  fetcher: typeof fetch = fetch,
): Promise<Delivery> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  const from = process.env.EMAIL_FROM;
  if (!token || !from) return { outcome: "off", detail: "Email isn't set up." };
  let res: Response;
  try {
    res = await fetcher("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": token,
      },
      body: JSON.stringify({
        From: from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        // Where a customer's reply goes, when the business has said. One plain address only.
        ...(message.replyTo && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(message.replyTo)
          ? { ReplyTo: message.replyTo }
          : {}),
        MessageStream: "outbound",
      }),
    });
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    console.error("Email failed", error instanceof Error ? error.message : error);
    return typeof code === "string" && NEVER_LEFT.has(code)
      ? { outcome: "refused", detail: "We couldn't reach the mail service." }
      : { outcome: "unsure", detail: "We never heard back from the mail service." };
  }
  if (res.ok) return { outcome: "sent", detail: "" };
  console.error(`Email failed: Postmark responded ${res.status}`);
  let code: unknown;
  try {
    code = ((await res.json()) as { ErrorCode?: unknown } | null)?.ErrorCode;
  } catch {
    code = undefined;
  }
  if (res.status === 422 && typeof code === "number" && DEAD_ADDRESS.has(code)) {
    return { outcome: "rejected", detail: "The mail service won't send to this address." };
  }
  return { outcome: "refused", detail: `The mail service refused it (${res.status}).` };
}

/**
 * Sends a plain-text email through Postmark when it's configured. Returns
 * false when it isn't (or the send fails) so callers can fall back.
 */
export async function sendEmail(message: {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}): Promise<boolean> {
  return (await deliverEmail(message)).outcome === "sent";
}

/** Invite to a workspace. The UI shows a copyable link when this returns false. */
export function sendInviteEmail(invite: InviteEmail): Promise<boolean> {
  const who = invite.inviterEmail ?? "A teammate";
  return sendEmail({
    to: invite.to,
    subject: `You're invited to ${invite.workspaceName}`,
    text: [
      `${who} invited you to join ${invite.workspaceName} on Maker Business Suite.`,
      "",
      `Accept the invite: ${invite.link}`,
      "",
      "The link works for 7 days. If you weren't expecting this, you can ignore it.",
    ].join("\n"),
  });
}
