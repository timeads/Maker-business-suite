/** The domain Postmark receives mail for, e.g. "inbound.example.com". */
export function inboundDomain(): string | null {
  return process.env.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase() || null;
}

/** The address customers write to, and that a studio forwards its support email to. */
export function supportAddress(slug: string, domain: string): string {
  return `support-${slug}@${domain}`;
}

/** The reply-to for one ticket: the part after "+" routes the customer's reply back to it. */
export function ticketReplyAddress(slug: string, replyKey: string, domain: string): string {
  return `support-${slug}+${replyKey}@${domain}`;
}

/** Pulls the workspace slug and (if present) the ticket's reply key out of a recipient address. */
export function parseSupportAddress(
  address: string,
  domain: string,
): { slug: string; replyKey: string | null } | null {
  const match = address
    .trim()
    .toLowerCase()
    .match(/^support-([a-z0-9]+(?:-[a-z0-9]+)*)(?:\+([a-z0-9]{8,64}))?@(.+)$/);
  if (!match || match[3] !== domain) return null;
  return { slug: match[1], replyKey: match[2] ?? null };
}
