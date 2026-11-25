/**
 * Meta's reply window. A business may answer for 24 hours after the
 * customer's last message (or reaction); after that Meta refuses the reply.
 * It is plain elapsed time, so clocks changing for daylight saving make no
 * difference. Worked out on read from the conversation itself: nothing is
 * stored and no timer runs.
 */
export const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
/** With Meta's Human Agent feature (needs its own approval): seven days. */
export const HUMAN_AGENT_WINDOW_MS = 7 * STANDARD_WINDOW_MS;
/** Sends this close to the end are refused here rather than raced against Meta's clock. */
export const WINDOW_MARGIN_MS = 60 * 1000;

export type ReplyWindow = {
  open: boolean;
  /** When the last chance to reply passes; null when the customer has never written. */
  closesAt: string | null;
  /** The reply needs Meta's HUMAN_AGENT tag: past 24 hours, inside seven days, and switched on. */
  needsHumanAgentTag: boolean;
};

/** The newest thing the customer did, from the messages on a conversation. */
export function lastInboundAt(
  messages: { direction: string; sent_at?: string | null; created_at: string }[],
): string | null {
  let latest: string | null = null;
  for (const message of messages) {
    if (message.direction !== "inbound") continue;
    const at = message.sent_at ?? message.created_at;
    if (!latest || Date.parse(at) > Date.parse(latest)) latest = at;
  }
  return latest;
}

export function replyWindow(
  lastInbound: string | null,
  now: number,
  options: { humanAgent?: boolean } = {},
): ReplyWindow {
  const from = lastInbound ? Date.parse(lastInbound) : NaN;
  if (!Number.isFinite(from)) return { open: false, closesAt: null, needsHumanAgentTag: false };
  const length = options.humanAgent ? HUMAN_AGENT_WINDOW_MS : STANDARD_WINDOW_MS;
  const closes = from + length;
  const open = now < closes - WINDOW_MARGIN_MS;
  return {
    open,
    closesAt: new Date(closes).toISOString(),
    needsHumanAgentTag:
      open && Boolean(options.humanAgent) && now >= from + STANDARD_WINDOW_MS - WINDOW_MARGIN_MS,
  };
}

/** What the reply box says about the window. */
export function windowWords(
  channel: "instagram" | "facebook",
  window: ReplyWindow,
  format: (instant: string) => string,
): string {
  const name = channel === "instagram" ? "Instagram" : "Facebook";
  if (window.open && window.closesAt) {
    return `You can reply until ${format(window.closesAt)}${window.needsHumanAgentTag ? " (sent as a person's reply, which Meta allows for seven days)" : ""}.`;
  }
  if (!window.closesAt) {
    return `${name} only lets a business reply after the customer has written. Nothing has come in on this conversation yet.`;
  }
  return `${name} only allows replies within 24 hours of the customer's last message, and that passed ${format(window.closesAt)}. You can reply once they write again; a note for the team still works.`;
}
