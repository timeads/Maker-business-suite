import {
  CHANNEL_LABELS,
  type ChannelSettings,
  type CommentFilter,
  type SocialChannel,
} from "./channels";

/**
 * Comments on a business's own Instagram and Facebook posts, as help desk
 * conversations: which ones are worth a conversation, what they are called,
 * and how a comment may be answered. Everything here is pure; the rules about
 * one private message per comment are held again by the database
 * (`claim_private_reply`).
 */

/**
 * Emoji-only, tag-only ("@friend 😍") and one-word cheers aren't worth a
 * conversation. Ported from the owner's help desk. The short list of cheers
 * is plain English praise, the same for every workspace; a workspace's own
 * words live in its settings, never here.
 */
export function isNoise(text: string): boolean {
  const words = text.replace(/@[\w.]+/g, " ").replace(/https?:\/\/\S+/g, " ");
  const letters = words.match(/[\p{L}\p{N}]/gu) ?? [];
  if (letters.length < 3) return true;
  // Tagging a friend with a word or two ("@amy look!", "@sam we need this"), unless it's a question.
  if (
    /@[\w.]/.test(text) &&
    !text.includes("?") &&
    words
      .trim()
      .split(/\s+/)
      .filter((word) => /[\p{L}\p{N}]/u.test(word)).length <= 4
  ) {
    return true;
  }
  return /^\s*(love( it| this)?|wow|nice|cool|amazing|beautiful|gorgeous|so cute|cute|yes+|omg|obsessed|need( this)?|want( this)?|goals|stunning|fire|great( job| work)?)[\s!.❤️♥️🔥😍🙌👏✨]*$/iu.test(
    words.trim(),
  );
}

/** Whether a comment has one of the workspace's own words in it, as a whole word, any case. */
export function hasOwnWord(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((raw) => {
    const word = raw.trim().toLowerCase();
    if (word.length < 2) return false;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(word, from);
      if (at < 0) return false;
      const before = at === 0 ? "" : lower[at - 1];
      const after = lower[at + word.length] ?? "";
      const edge = (char: string) => char === "" || !/[\p{L}\p{N}]/u.test(char);
      if (edge(before) && edge(after)) return true;
      from = at + 1;
    }
  });
}

/**
 * Whether a comment starts a conversation by itself. (One that doesn't is
 * still kept when the person already has a conversation going on that post.)
 */
export function startsConversation(
  comment: { text: string; hasMedia: boolean },
  settings: { comment_filter: CommentFilter; comment_words: readonly string[] },
): boolean {
  const text = comment.text.trim();
  if (!text && !comment.hasMedia) return false;
  if (settings.comment_filter === "all") return true;
  if (hasOwnWord(text, settings.comment_words)) return true;
  if (settings.comment_filter === "matching") return text.includes("?");
  return comment.hasMedia || !isNoise(text);
}

/** The subject a new conversation starts with: "Instagram comment: <first line>". */
export function commentSubject(
  channel: SocialChannel,
  body: string,
  summary: string | null,
): string {
  const first =
    body
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ??
    summary ??
    "New comment";
  const chars = [...first];
  return `${CHANNEL_LABELS[channel]} comment: ${chars.length > 70 ? `${chars.slice(0, 67).join("")}…` : first}`;
}

/** "Instagram comment" / "Facebook message": what a conversation is, for the list and the panel. */
export const conversationWords = (channel: SocialChannel, kind: string | null | undefined) =>
  `${CHANNEL_LABELS[channel]} ${kind === "comment" ? "comment" : "message"}`;

const POST_HOSTS: Record<SocialChannel, readonly string[]> = {
  facebook: ["facebook.com", "www.facebook.com"],
  instagram: ["instagram.com", "www.instagram.com"],
};

/** A post's address when it is on the platform itself, over https; otherwise null. Shown as a plain link. */
export function postLink(channel: SocialChannel, raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return POST_HOSTS[channel].includes(url.hostname.toLowerCase()) ? url.toString() : null;
}

export const POST_EXCERPT_MAX = 280;

/** The start of a post's caption as one line of plain text. */
export function postExcerpt(raw: unknown): string {
  const text = (typeof raw === "string" ? raw : "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...text];
  return chars.length > POST_EXCERPT_MAX
    ? `${chars
        .slice(0, POST_EXCERPT_MAX - 1)
        .join("")
        .trimEnd()}…`
    : text;
}

/**
 * Meta allows one private message about a comment, sent within seven days
 * of it. Worked out on read from the comment itself: nothing runs on a timer.
 */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Sends this close to the end are refused here rather than raced against Meta's clock. */
export const PRIVATE_REPLY_MARGIN_MS = 5 * 60 * 1000;

export type PrivateReplyState =
  /** It can be sent. */
  | "available"
  /** One is being sent right now (or was started and never heard back about). */
  | "sending"
  /** The comment has had its one private message. */
  | "used"
  /** More than seven days have passed since the comment. */
  | "expired"
  /** The connection wasn't given permission to send messages. */
  | "not_allowed"
  /** There is no comment left to answer. */
  | "none";

export function privateReplyState(
  comment: { at: string | null; privateReply: string | null } | null,
  now: number,
  allowed: boolean,
): { state: PrivateReplyState; until: string | null } {
  if (!comment) return { state: "none", until: null };
  if (comment.privateReply === "sent") return { state: "used", until: null };
  if (comment.privateReply === "claimed") return { state: "sending", until: null };
  if (!allowed) return { state: "not_allowed", until: null };
  const from = comment.at ? Date.parse(comment.at) : NaN;
  if (!Number.isFinite(from)) return { state: "expired", until: null };
  const closes = from + PRIVATE_REPLY_WINDOW_MS;
  return {
    state: now < closes - PRIVATE_REPLY_MARGIN_MS ? "available" : "expired",
    until: new Date(closes).toISOString(),
  };
}

/** Why the private choice is or isn't there, for the reply box. */
export function privateReplyWords(
  channel: SocialChannel,
  state: PrivateReplyState,
  until: string | null,
  format: (instant: string) => string,
): string {
  const name = CHANNEL_LABELS[channel];
  switch (state) {
    case "available":
      return `${name} allows one private message about a comment${until ? `, until ${format(until)}` : ""}. If they answer, it carries on as an ordinary ${name} message conversation.`;
    case "used":
      return `You've sent your one private message about this comment, which is all ${name} allows. If they answer, it arrives as a ${name} message conversation.`;
    case "sending":
      return "A private message about this comment is on its way (or was started and we never heard back). It can't be sent twice.";
    case "expired":
      return `${name} only allows a private message within seven days of the comment, and that has passed. You can still reply publicly.`;
    case "not_allowed":
      return `A private message needs ${name} messages allowed as well. An owner or admin can allow them in Settings → Help desk → Channels.`;
    default:
      return "There is no comment left here to answer.";
  }
}

export type CommentVia = "public" | "private";

/** The latest comment from the customer that still stands: replies go under it. */
export function latestComment<
  T extends {
    direction: string;
    kind?: string | null;
    removed_at?: string | null;
    sent_at?: string | null;
    created_at: string;
  },
>(messages: T[]): T | null {
  let latest: T | null = null;
  for (const message of messages) {
    if (message.direction !== "inbound" || message.kind !== "comment" || message.removed_at) {
      continue;
    }
    const at = Date.parse(message.sent_at ?? message.created_at);
    if (!latest || at > Date.parse(latest.sent_at ?? latest.created_at)) latest = message;
  }
  return latest;
}

/** The settings the filter reads, from the whole channel settings. */
export const commentFilterOf = (settings: ChannelSettings) => ({
  comment_filter: settings.comment_filter,
  comment_words: settings.comment_words,
});
