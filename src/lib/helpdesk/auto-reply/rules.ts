import { localClock, type AvailabilityRule } from "../../bookings/slots";
import {
  messagesNeeded,
  type AutoReplies,
  type AutoReplyChannel,
  type AutoReplyChannelSettings,
} from "./config";

/**
 * The rules for an automatic first reply. Pure: every fact is handed in, so
 * the whole decision can be tested, clocks changing included. The words that
 * go out are the ones a person saved, with two placeholders filled in here.
 * No model is asked for anything, here or anywhere on this path.
 */

/** A message older than this when the worker gets to it is answered by a person, not by us. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/** The only placeholders. Anything else in double braces is left exactly as typed. */
export const PLACEHOLDERS = ["first_name", "business_name"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
/** What "{{first_name}}" reads as when we don't know one. */
export const NAME_FALLBACK = "there";

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/gi;

/**
 * A first name fit to greet someone by, or null. Only from a name with a
 * given name's shape: letters (any alphabet), an apostrophe or a hyphen, 2 to
 * 30 long. A handle, an email address, a link or "Facebook user" gives none,
 * so nothing a stranger chose as a display name is echoed back in the
 * business's voice beyond a plain first name.
 */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  if (!/^\p{L}[\p{L}'’-]{1,29}$/u.test(first)) return null;
  if (/^(facebook|instagram|user|customer|guest|unknown)$/i.test(first)) return null;
  return first;
}

/** A business's name as it may appear in a message: one line, no braces to fill in twice. */
const cleanBusinessName = (name: string) =>
  name
    .replace(/[\r\n\t{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

/** Fills the placeholders in. Values are never looked at for placeholders again. */
export function fillWords(
  text: string,
  facts: { firstName: string | null; businessName: string },
): string {
  const values: Record<Placeholder, string> = {
    first_name: firstNameOf(facts.firstName) ?? NAME_FALLBACK,
    business_name: cleanBusinessName(facts.businessName),
  };
  return text
    .replace(/\r\n?/g, "\n")
    .replace(PLACEHOLDER, (whole, key: string) => {
      const known = PLACEHOLDERS.find((one) => one === key.toLowerCase());
      return known ? values[known] : whole;
    })
    .trim();
}

/** Double-brace words in a message that we don't fill in, so the screen can say so. */
export function unknownPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    const key = match[1].toLowerCase();
    if (!PLACEHOLDERS.some((one) => one === key)) found.add(match[0]);
  }
  return [...found];
}

/**
 * Whether the business is open at an instant: its clocks, read in its own
 * timezone, sit inside one of the week's stretches. Following the clocks is
 * what makes this right on the days they change: an hour that is skipped is
 * simply never read, and an hour that comes twice counts both times.
 */
export function isOpenAt(
  hours: readonly AvailabilityRule[],
  instant: number,
  timeZone: string,
): boolean {
  let clock: ReturnType<typeof localClock>;
  try {
    clock = localClock(new Date(instant), timeZone);
  } catch {
    // A timezone we can't read: treat the business as open, so nobody is told it is closed by mistake.
    return true;
  }
  return hours.some(
    (rule) =>
      rule.weekday === clock.weekday &&
      clock.minute >= rule.start_minute &&
      clock.minute < rule.end_minute,
  );
}

/** Kinds of message a person really wrote to the business. Not a reaction, a mention or a comment. */
const REAL_KINDS = ["reply", "story_reply", "share"];

export type AutoReplyFacts = {
  channel: AutoReplyChannel;
  /** "message", or "comment" for a conversation about a comment on a post. */
  ticketKind: string;
  direction: string;
  /** The message's kind as filed: "reply", "story_reply", "share", "reaction", "comment"… */
  messageKind: string;
  /** The person took the message back. */
  removed: boolean;
  /** Archive, Spam or Trash, as the conversation stood after the message was filed. */
  shelf: string | null;
  /** When the person wrote, and now (both in milliseconds). */
  receivedAt: number;
  now: number;
  /** The last time an automatic reply was claimed for this person on this channel. */
  lastAutoReplyAt: number | null;
  /** Someone on the team has answered (or is sending an answer) since this message. */
  teamAnsweredSince: boolean;
  /** Came on Meta's standby list: another inbox tool has the conversation. */
  standby: boolean;
  /** The workspace chose to take conversations over from another tool. */
  takeControl: boolean;
  /** Email only: the mail looks machine-sent, or comes from one of our own addresses. */
  automatedMail: boolean;
  fromOwnAddress: boolean;
  /** The workspace's timezone and name, and the person's name when we have one. */
  timeZone: string;
  businessName: string;
  contactName: string | null;
};

export type AutoReplySkip =
  | "off"
  | "not_a_message"
  | "shelved"
  | "automated"
  | "own_address"
  | "another_tool"
  | "stale"
  | "answered"
  | "quiet"
  | "inside_hours"
  | "no_words";

export type AutoReplyDecision =
  { send: false; reason: AutoReplySkip } | { send: true; variant: "usual" | "away"; text: string };

/** Which of a channel's two messages applies at an instant, or null when neither does. */
export function variantAt(
  channel: AutoReplyChannelSettings,
  hours: readonly AvailabilityRule[],
  instant: number,
  timeZone: string,
): "usual" | "away" | null {
  if (channel.when === "always") return "usual";
  const open = isOpenAt(hours, instant, timeZone);
  if (channel.when === "outside_hours") return open ? null : "away";
  return open ? "usual" : "away";
}

/**
 * Whether an inbound message gets the automatic reply, and with which words.
 * The reasons for saying no come in a fixed order, so the same message
 * always gets the same answer. The database checks the two that can change
 * under us (the quiet period and a team answer) again when it takes the claim.
 */
export function shouldAutoReply(settings: AutoReplies, facts: AutoReplyFacts): AutoReplyDecision {
  const no = (reason: AutoReplySkip): AutoReplyDecision => ({ send: false, reason });
  const channel = settings[facts.channel];
  if (!channel?.on) return no("off");
  // Only a real message from a person, in a private conversation: never a
  // comment on a post (those are public), a reaction, or something of ours.
  if (
    facts.direction !== "inbound" ||
    facts.ticketKind !== "message" ||
    facts.removed ||
    !REAL_KINDS.includes(facts.messageKind)
  ) {
    return no("not_a_message");
  }
  if (facts.shelf === "spam" || facts.shelf === "trash") return no("shelved");
  if (facts.channel === "email") {
    if (facts.fromOwnAddress) return no("own_address");
    if (facts.automatedMail) return no("automated");
  } else if (facts.standby && !facts.takeControl) {
    // Another tool is answering this person: Meta would refuse us, and that tool may have said hello.
    return no("another_tool");
  }
  if (!Number.isFinite(facts.receivedAt) || facts.now - facts.receivedAt > STALE_AFTER_MS) {
    return no("stale");
  }
  if (facts.teamAnsweredSince) return no("answered");
  if (
    facts.lastAutoReplyAt !== null &&
    facts.now - facts.lastAutoReplyAt < settings.quiet_hours * 60 * 60 * 1000
  ) {
    return no("quiet");
  }
  // Open or closed is asked of the moment the person wrote, not of when we got to it.
  const variant = variantAt(channel, settings.hours, facts.receivedAt, facts.timeZone);
  if (!variant) return no("inside_hours");
  const text = fillWords(variant === "away" ? channel.away_message : channel.message, {
    firstName: facts.contactName,
    businessName: facts.businessName,
  });
  if (!text) return no("no_words");
  return { send: true, variant, text };
}

/** What is wrong with a channel's settings before saving, in words, or null. */
export function channelProblem(label: string, channel: AutoReplyChannelSettings): string | null {
  if (!channel.on) return null;
  const needs = messagesNeeded(channel.when);
  if (needs.message && !channel.message.trim()) {
    return `${label}: write the message before switching it on.`;
  }
  if (needs.away && !channel.away_message.trim()) {
    return `${label}: write the away message before switching it on.`;
  }
  return null;
}

/**
 * Mail we must never answer by machine (RFC 3834 and the usual loop checks,
 * ported from the owner's help desk): anything that says it was sent
 * automatically, bulk and list mail, bounces, and no-reply senders.
 */
export function looksAutomated(
  headers: Record<string, string | null | undefined>,
  fromEmail: string,
): boolean {
  const get = (name: string) => {
    const key = Object.keys(headers).find((one) => one.toLowerCase() === name);
    return key ? (headers[key] ?? "").trim().toLowerCase() : "";
  };
  const autoSubmitted = get("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (/\b(bulk|list|junk|auto_reply)\b/.test(get("precedence"))) return true;
  if (
    get("list-id") ||
    get("list-unsubscribe") ||
    get("list-post") ||
    get("x-autoreply") ||
    get("x-autorespond") ||
    get("x-auto-response-suppress") ||
    get("x-loop") ||
    get("feedback-id")
  ) {
    return true;
  }
  // A bounce has an empty return path.
  if (get("return-path") === "<>") return true;
  const local = fromEmail.trim().toLowerCase().split("@")[0] ?? "";
  return /^(mailer-daemon|postmaster|bounces?|no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply|notifications?|auto[-_.]?(reply|responder|confirm)|listserv|majordomo)([+-].*)?$/.test(
    local,
  );
}

/** Whether an address is one of the business's own: the desk's on our mail domain, or one it forwards from. */
export function isOwnAddress(
  address: string,
  own: { domain: string | null; addresses: readonly string[] },
): boolean {
  const from = address.trim().toLowerCase();
  if (own.domain && from.endsWith(`@${own.domain.toLowerCase()}`)) return true;
  return own.addresses.some((one) => one.trim().toLowerCase() === from);
}
