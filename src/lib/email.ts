type InviteEmail = {
  to: string;
  workspaceName: string;
  inviterEmail: string | undefined;
  link: string;
};

/**
 * Sends the invite through Postmark when it's configured. Returns false when
 * it isn't (or the send fails) so the UI can fall back to a copyable link.
 */
export async function sendInviteEmail(invite: InviteEmail): Promise<boolean> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  const from = process.env.EMAIL_FROM;
  if (!token || !from) return false;

  const who = invite.inviterEmail ?? "A teammate";
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
        To: invite.to,
        Subject: `You're invited to ${invite.workspaceName}`,
        TextBody: [
          `${who} invited you to join ${invite.workspaceName} on Maker Business Suite.`,
          "",
          `Accept the invite: ${invite.link}`,
          "",
          "The link works for 7 days. If you weren't expecting this, you can ignore it.",
        ].join("\n"),
        MessageStream: "outbound",
      }),
    });
    if (!res.ok) {
      console.error(`Invite email failed: Postmark responded ${res.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Invite email failed", error instanceof Error ? error.message : error);
    return false;
  }
}
