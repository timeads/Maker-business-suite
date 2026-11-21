type InviteEmail = {
  to: string;
  workspaceName: string;
  inviterEmail: string | undefined;
  link: string;
};

/**
 * Sends a plain-text email through Postmark when it's configured. Returns
 * false when it isn't (or the send fails) so callers can fall back.
 */
export async function sendEmail(message: {
  to: string;
  subject: string;
  text: string;
}): Promise<boolean> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  const from = process.env.EMAIL_FROM;
  if (!token || !from) return false;
  try {
    const res = await fetch("https://api.postmarkapp.com/email", {
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
        MessageStream: "outbound",
      }),
    });
    if (!res.ok) {
      console.error(`Email failed: Postmark responded ${res.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Email failed", error instanceof Error ? error.message : error);
    return false;
  }
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
