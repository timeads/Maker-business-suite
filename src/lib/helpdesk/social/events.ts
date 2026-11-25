import { CHANNEL_LABELS, channelOfObject, type SocialChannel } from "./channels";

/**
 * Meta's webhook payload, read into the few things the help desk files.
 * Messenger and Instagram use one shape: `entry[].messaging[]`, each with a
 * sender, a recipient, a timestamp and one of `message`, `reaction`, `read`,
 * `postback`… Comments arrive beside them as `entry[].changes[]`: a Page's
 * `feed` field and an Instagram account's `comments` field. Everything here is data from outside: nothing is trusted beyond
 * its type, and anything we don't file is simply left out.
 */

export type MediaKind = "image" | "video" | "audio" | "file";
export type MessageKind = "reply" | "story_reply" | "story_mention" | "share";

type Common = {
  channel: SocialChannel;
  /** The Page's id (Facebook) or the Instagram professional account's id: `entry.id`. */
  accountId: string;
  /** The customer's id as Meta scopes it to this Page or Instagram account. */
  personId: string;
  /** When Meta says it happened. */
  at: string;
};

export type SocialEvent =
  | (Common & {
      type: "message";
      mid: string;
      text: string;
      kind: MessageKind;
      /** Files to fetch from Meta's hosts (the links expire). */
      media: { kind: MediaKind; url: string }[];
      /** A few of our own words for a message that isn't only text ("Sent a photo"). */
      summary: string | null;
    })
  | (Common & {
      type: "echo";
      mid: string;
      text: string;
      summary: string | null;
      /** The app that sent it, when Meta says. Ours means the help desk sent it. */
      appId: string | null;
    })
  | (Common & { type: "removed"; mid: string })
  | (Common & {
      type: "reaction";
      /** The message reacted to. */
      mid: string;
      action: "react" | "unreact";
      emoji: string | null;
    })
  | CommentEvent;

/**
 * A comment on one of the account's own posts, and what happens to it after.
 * Facebook says what happened with a verb (add, edited, remove, hide,
 * unhide); Instagram only ever says "here is a comment".
 */
type CommentBase = {
  channel: SocialChannel;
  /** The Page's id (Facebook) or the Instagram professional account's id: `entry.id`. */
  accountId: string;
  at: string;
  /** Meta's id for the comment. */
  commentId: string;
};
export type CommentEvent =
  | (CommentBase & {
      type: "comment";
      /** The commenter's id as Meta scopes it to this Page or Instagram account. */
      personId: string;
      /** Facebook gives a name, Instagram a username: no profile needs reading. */
      name: string | null;
      handle: string | null;
      /** The post (Facebook) or media (Instagram) it is on. */
      postId: string;
      /** The comment it was written under, when it is a reply. */
      parentId: string | null;
      text: string;
      /** A picture or video attached to a Facebook comment, to fetch from Meta's hosts. */
      media: { kind: MediaKind; url: string }[];
      summary: string | null;
      /** Written by the Page or the Instagram account itself. */
      own: boolean;
      /** Facebook's "edited": the same comment with new words. */
      edited: boolean;
    })
  | (CommentBase & { type: "comment_removed" })
  | (CommentBase & { type: "comment_hidden"; hidden: boolean });

const MAX_TEXT = 8000;
const MAX_MEDIA = 10;
const ID = /^[A-Za-z0-9_.:$-]{1,200}$/;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const id = (value: unknown): string | null => {
  const raw = typeof value === "number" ? String(value) : text(value);
  return ID.test(raw) ? raw : null;
};
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** A webhook timestamp (milliseconds; older Messenger events use seconds) as an instant, never in the future. */
export function eventTime(raw: unknown, now: number): string {
  let ms = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return new Date(now).toISOString();
  if (ms < 100_000_000_000) ms *= 1000;
  return new Date(Math.min(ms, now)).toISOString();
}

const MEDIA_KINDS: Record<string, MediaKind> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "file",
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** Our own few words for what a message carried besides text. */
export function mediaWords(types: string[], extras: { story?: boolean; unsupported?: boolean }) {
  if (extras.story) return "Replied to your story";
  const count = (type: string) => types.filter((t) => t === type).length;
  if (types.includes("story_mention")) return "Mentioned you in their story";
  if (types.some((t) => t === "reel" || t === "ig_reel")) return "Shared a reel";
  if (types.some((t) => t === "share" || t === "post" || t === "ig_post")) return "Shared a post";
  const kinds = new Set(types);
  if (kinds.size > 1 && types.length > 1) return `Sent ${types.length} attachments`;
  if (count("image") > 0) return `Sent ${plural(count("image"), "a photo", "photos")}`;
  if (count("video") > 0) return `Sent ${plural(count("video"), "a video", "videos")}`;
  if (count("audio") > 0) return "Sent a voice message";
  if (count("file") > 0) return `Sent ${plural(count("file"), "a file", "files")}`;
  if (count("sticker") > 0) return "Sent a sticker";
  if (count("ephemeral") > 0) return "Sent a photo that disappears, which can't be shown here";
  if (count("fallback") > 0) return "Shared a link";
  if (extras.unsupported || types.length > 0) return "Sent something that can't be shown here";
  return null;
}

/** The subject a new conversation starts with: "Instagram message: <first line>". */
export function socialSubject(
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
    "New message";
  const chars = [...first];
  return `${CHANNEL_LABELS[channel]} message: ${chars.length > 70 ? `${chars.slice(0, 67).join("")}…` : first}`;
}

function readMessage(common: Common, message: Record<string, unknown>): SocialEvent | null {
  const mid = id(message.mid);
  // A hand-off note from a Meta tool has no message of its own: nothing to file.
  if (!mid) return null;
  if (message.is_deleted === true) return { ...common, type: "removed", mid };

  const attachments = list(message.attachments).slice(0, 30);
  const types = attachments.map((a) => text(a.type).toLowerCase()).filter(Boolean);
  const story = Boolean(
    object(object(message.reply_to).story).id ?? object(message.reply_to).story,
  );
  const summary = mediaWords(types, { story, unsupported: message.is_unsupported === true });
  const body = text(message.text)
    .replace(/\u0000/g, "")
    .slice(0, MAX_TEXT);

  if (message.is_echo === true) {
    return { ...common, type: "echo", mid, text: body, summary, appId: id(message.app_id) };
  }

  // A sticker arrives twice while Meta changes its format: once as a sticker, once as an image.
  const stickers = new Set(
    attachments
      .filter((a) => text(a.type).toLowerCase() === "sticker")
      .map((a) => text(object(a.payload).url)),
  );
  const media: { kind: MediaKind; url: string }[] = [];
  for (const attachment of attachments) {
    const kind = MEDIA_KINDS[text(attachment.type).toLowerCase()];
    const url = text(object(attachment.payload).url);
    if (!kind || !url || stickers.has(url)) continue;
    if (media.length < MAX_MEDIA) media.push({ kind, url });
  }
  const kind: MessageKind = story
    ? "story_reply"
    : types.includes("story_mention")
      ? "story_mention"
      : types.some((t) => ["share", "post", "ig_post", "reel", "ig_reel"].includes(t))
        ? "share"
        : "reply";
  if (!body && !summary) return null;
  return { ...common, type: "message", mid, text: body, kind, media, summary };
}

/** One of a Facebook Page's `feed` changes, when it is about a comment. */
function readFeedChange(
  accountId: string,
  value: Record<string, unknown>,
  now: number,
): CommentEvent | null {
  if (text(value.item) !== "comment") return null;
  const commentId = id(value.comment_id);
  if (!commentId) return null;
  const base: CommentBase = {
    channel: "facebook",
    accountId,
    at: eventTime(value.created_time, now),
    commentId,
  };
  const verb = text(value.verb);
  if (verb === "remove") return { ...base, type: "comment_removed" };
  if (verb === "hide" || verb === "unhide") {
    return { ...base, type: "comment_hidden", hidden: verb === "hide" };
  }
  if (verb !== "add" && verb !== "edited" && verb !== "edit") return null;
  const from = object(value.from);
  const personId = id(from.id);
  const postId = id(value.post_id);
  // Without knowing who wrote it or on what, it can't be put on a conversation.
  if (!personId || !postId) return null;
  const parent = id(value.parent_id);
  const media: { kind: MediaKind; url: string }[] = [];
  if (text(value.photo)) media.push({ kind: "image", url: text(value.photo) });
  if (text(value.video)) media.push({ kind: "video", url: text(value.video) });
  const body = text(value.message)
    .replace(/\u0000/g, "")
    .slice(0, MAX_TEXT);
  const summary = media.length
    ? media[0].kind === "video"
      ? "Posted a video"
      : "Posted a photo"
    : null;
  if (!body && !summary) return null;
  return {
    ...base,
    type: "comment",
    personId,
    name: text(from.name).replace(/\s+/g, " ").trim().slice(0, 80) || null,
    handle: null,
    postId,
    // A top-level comment names its post as its parent.
    parentId: parent && parent !== postId ? parent : null,
    text: body,
    media,
    summary,
    own: personId === accountId,
    edited: verb !== "add",
  };
}

/** One of an Instagram account's `comments` changes. (Live comments and mentions are left out.) */
function readInstagramComment(
  accountId: string,
  value: Record<string, unknown>,
  at: string,
): CommentEvent | null {
  // Meta's reference names the comment's id `id`; its Facebook Login example names it `comment_id`.
  const commentId = id(value.id) ?? id(value.comment_id);
  const from = object(value.from);
  const personId = id(from.id);
  const postId = id(object(value.media).id);
  if (!commentId || !personId || !postId) return null;
  const body = text(value.text)
    .replace(/\u0000/g, "")
    .slice(0, MAX_TEXT);
  if (!body) return null;
  const username = text(from.username).replace(/^@/, "");
  return {
    channel: "instagram",
    accountId,
    at,
    commentId,
    type: "comment",
    personId,
    name: null,
    handle: /^[A-Za-z0-9._]{1,30}$/.test(username) ? username : null,
    postId,
    parentId: id(value.parent_id),
    text: body,
    media: [],
    summary: null,
    own: personId === accountId,
    edited: false,
  };
}

/**
 * Every event in one webhook delivery that the help desk files, in Meta's
 * order. Reads, deliveries, postbacks, hand-offs, a Page's other feed changes
 * (posts, reactions, shares), Instagram's live comments and mentions, and
 * anything unknown are left out.
 */
export function parseMetaPayload(payload: unknown, now: number = Date.now()): SocialEvent[] {
  const root = object(payload);
  const channel = channelOfObject(root.object);
  if (!channel) return [];
  const events: SocialEvent[] = [];
  for (const entry of list(root.entry).slice(0, 100)) {
    const accountId = id(entry.id);
    if (!accountId) continue;
    for (const change of list(entry.changes).slice(0, 100)) {
      const field = text(change.field);
      const value = object(change.value);
      const event =
        channel === "facebook" && field === "feed"
          ? readFeedChange(accountId, value, now)
          : channel === "instagram" && field === "comments"
            ? readInstagramComment(accountId, value, eventTime(entry.time, now))
            : null;
      if (event) events.push(event);
    }
    for (const item of list(entry.messaging).slice(0, 100)) {
      const sender = id(object(item.sender).id);
      const recipient = id(object(item.recipient).id);
      if (!sender || !recipient) continue;
      const at = eventTime(item.timestamp, now);
      const message = object(item.message);
      const echo = message.is_echo === true;
      // An echo is ours going out: the customer is the one it was sent to.
      const personId = echo ? recipient : sender;
      if (personId === accountId) continue;
      const common: Common = { channel, accountId, personId, at };
      if (item.message !== undefined) {
        const event = readMessage(common, message);
        if (event) events.push(event);
        continue;
      }
      const reaction = object(item.reaction);
      const target = id(reaction.mid);
      if (item.reaction !== undefined && target) {
        const emoji = text(reaction.emoji).slice(0, 16);
        events.push({
          ...common,
          type: "reaction",
          mid: target,
          action: reaction.action === "unreact" ? "unreact" : "react",
          emoji: emoji || null,
        });
      }
    }
  }
  return events;
}

/** Every account (`entry.id`) a payload is about, to find whose workspace it belongs to. */
export function payloadAccounts(payload: unknown): string[] {
  return [
    ...new Set(
      list(object(payload).entry)
        .map((entry) => id(entry.id))
        .filter((value): value is string => value !== null),
    ),
  ];
}

/** The id a reaction is filed under: one per person per message, so a changed reaction replaces the last. */
export const reactionId = (mid: string, personId: string) => `react:${personId}:${mid}`;
