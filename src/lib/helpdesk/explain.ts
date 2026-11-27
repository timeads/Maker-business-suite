import { variantAt } from "./auto-reply/rules";
import type { AutoReplies, AutoReplyChannel } from "./auto-reply/config";
import { CHANNEL_LABELS, type SocialChannel } from "./social/channels";
import type { ReplyWindow } from "./social/window";
import { SHELF_LABELS, STATUS_LABELS, VIEWS, inView, isSnoozed, type TicketFacts } from "./views";

/**
 * "How this is worked out" for the help desk: why a conversation sits where
 * it does, how long a reply can still go on Instagram or Facebook, and why an
 * automatic reply did or didn't go. Pure, from the same facts the inbox
 * decides with (`inView`, `replyWindow`, the automatic reply's own rules).
 * No model; nothing here reaches the automatic reply's sending path.
 */

type Format = (instant: string) => string;

/** Why a conversation shows where it does, and every built-in view it is in. */
export function viewExplained(
  ticket: TicketFacts,
  me: string,
  now: number,
  format: Format,
  names: { folder?: string | null } = {},
): string[] {
  const lines: string[] = [];
  if (ticket.merged_into) {
    lines.push(
      "It was joined into another conversation, so it shows only under All tickets. New mail on it goes to that one.",
    );
  } else if (ticket.shelf) {
    lines.push(
      ticket.shelf === "archived"
        ? "It's archived: closed, and out of every working view. It comes back by itself if the customer writes again."
        : `It's ${SHELF_LABELS[ticket.shelf].toLowerCase()}: closed, out of every working view and All tickets, and it stays there even if they write again.`,
    );
  } else if (ticket.folder_id && ticket.status !== "closed") {
    lines.push(
      `It's filed in ${names.folder ? `“${names.folder}”` : "a folder"}, so it has left the inbox views. It stays there until it's closed or moved back to the inbox.`,
    );
  } else if (ticket.status !== "closed" && isSnoozed(ticket, now) && ticket.snoozed_until) {
    lines.push(
      `It's snoozed until ${format(ticket.snoozed_until)}, so it waits under Snoozed and is back in ${STATUS_LABELS[ticket.status]} after that by itself. Nothing has to run for that: it's worked out each time you look.`,
    );
  } else {
    lines.push(
      ticket.status === "pending"
        ? "It's in progress: you've answered and are waiting on the customer. It's open again when they write."
        : ticket.status === "closed"
          ? "It's closed. It opens again when the customer writes."
          : `It's open${ticket.assignee_id === null ? " and nobody has it yet" : ticket.assignee_id === me ? " and it's yours" : " and someone on the team has it"}.`,
    );
  }
  const shown = VIEWS.filter((view) => inView(ticket, view.key, me, now)).map((v) => v.label);
  if (shown.length > 0) lines.push(`It shows in: ${shown.join(", ")}.`);
  return lines;
}

/** How long a reply can still go, in Meta's words of the 24-hour window. */
export function replyWindowExplained(
  channel: SocialChannel,
  window: ReplyWindow,
  format: Format,
  humanAgent: boolean,
): string[] {
  const name = CHANNEL_LABELS[channel];
  const lines = [
    `${name} lets a business reply for 24 hours after the customer's last message or reaction, counted in plain hours, so the clocks changing makes no difference.`,
  ];
  if (!window.closesAt) {
    lines.push("Nothing has come in from them yet, so there's nothing to reply to.");
  } else if (window.open) {
    lines.push(`This one can be answered until ${format(window.closesAt)}.`);
  } else {
    lines.push(
      `That passed ${format(window.closesAt)}. A reply can go again as soon as they write; a note for the team works any time.`,
    );
  }
  lines.push(
    humanAgent
      ? "Your workspace says Meta approved it for a person's reply up to seven days later, so the window runs a week."
      : "We stop a minute early rather than race Meta's clock.",
  );
  return lines;
}

export type AutoReplyFactsOnRead = {
  channel: AutoReplyChannel;
  /** "message", or "comment" for a conversation about a comment on a post. */
  ticketKind: string;
  /** An automatic reply is in the conversation. */
  sent: boolean;
  /** When the customer first wrote, if they have. */
  firstInboundAt: string | null;
  timeZone: string;
};

/**
 * Why an automatic first reply did or didn't go, as far as the
 * conversation and the settings can tell on read. The worker's own reasons
 * at the time (the quiet period, mail that looked machine-sent, someone
 * answering first, another inbox tool) aren't kept, so they are named as
 * possibilities, never claimed.
 */
export function autoReplyExplained(settings: AutoReplies, facts: AutoReplyFactsOnRead): string[] {
  const label = facts.channel === "email" ? "Email" : CHANNEL_LABELS[facts.channel];
  const channel = settings[facts.channel];
  if (facts.sent) {
    return [
      `An automatic reply went, with the words saved for ${label} under Settings → Help desk → Automatic replies. Only those words are ever sent; nobody writes them on the spot.`,
      "It doesn't count as the team answering: the conversation stays open until someone replies.",
    ];
  }
  if (facts.ticketKind === "comment") {
    return ["Comments on posts never get an automatic reply: they're public."];
  }
  if (!channel.on) {
    return [`Automatic replies are off for ${label}, so none was sent.`];
  }
  if (!facts.firstInboundAt) return ["Nothing has come in from the customer yet."];
  const at = Date.parse(facts.firstInboundAt);
  if (Number.isFinite(at) && !variantAt(channel, settings.hours, at, facts.timeZone)) {
    return [
      `They wrote during your opening hours, and ${label}'s automatic reply only goes outside them.`,
    ];
  }
  return [
    `Automatic replies are on for ${label}, but none went here. One is held back when this person had one in the last ${settings.quiet_hours} hours, when the email looked machine-sent or came from your own address, when it reached us more than an hour late, when someone on the team answered first, or when another inbox tool has the conversation.`,
  ];
}
