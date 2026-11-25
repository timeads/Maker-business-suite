import { graphUrl } from "../../connections/providers/meta";
import { tidyHandle, type SocialChannel } from "./channels";

/**
 * The few calls the help desk makes to Meta's Graph API: send a message,
 * read a person's name, and switch a Page's webhook on or off. The Page's
 * token goes in the Authorization header, never in an address, and is never
 * logged or returned.
 */

/** Meta said no, in so many words: nothing was sent. */
export class MetaRefused extends Error {
  constructor(
    public status: number,
    public code: number | null,
    public subcode: number | null,
    /** Meta's own sentence, trimmed. Shown to the team; never anything about a token. */
    public reason: string,
  ) {
    super(`Meta refused (${code ?? status})`);
    this.name = "MetaRefused";
  }
}

/** No clear answer (a timeout, a broken reply): it may or may not have gone. */
export class MetaUnsure extends Error {
  constructor(message = "No clear answer from Meta") {
    super(message);
    this.name = "MetaUnsure";
  }
}

const tidyReason = (raw: unknown): string =>
  (typeof raw === "string" ? raw : "")
    // Meta's sentences sometimes carry a link or an id; neither helps the person reading.
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

async function call<T>(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  init: { method?: "GET" | "POST" | "DELETE"; query?: Record<string, string>; json?: unknown } = {},
  timeoutMs = 30_000,
): Promise<T> {
  const query = init.query ? `?${new URLSearchParams(init.query)}` : "";
  let response: Response;
  try {
    response = await fetchImpl(`${graphUrl(path)}${query}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.json === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new MetaUnsure();
  }
  let data: unknown;
  try {
    data = JSON.parse(await response.text());
  } catch {
    data = null;
  }
  const error = (data as { error?: Record<string, unknown> } | null)?.error;
  if (error && typeof error === "object") {
    const number = (value: unknown) => (typeof value === "number" ? value : null);
    throw new MetaRefused(
      response.status,
      number(error.code),
      number(error.error_subcode),
      tidyReason(error.message),
    );
  }
  // An error status with nothing we can read: on a send, we can't say it didn't go.
  if (!response.ok || data === null) {
    if (response.status >= 400 && response.status < 500) {
      throw new MetaRefused(response.status, null, null, "");
    }
    throw new MetaUnsure();
  }
  return data as T;
}

export type SendTarget = {
  /** The Facebook Page (for Instagram: the Page the account is linked to). */
  pageId: string;
  token: string;
  /** The customer's Page-scoped or Instagram-scoped id. */
  recipientId: string;
  /** Only when the reply is past 24 hours and the workspace says its app has the Human Agent feature. */
  humanAgent?: boolean;
};

const envelope = (target: SendTarget) => ({
  recipient: { id: target.recipientId },
  ...(target.humanAgent
    ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" }
    : { messaging_type: "RESPONSE" }),
});

const messageId = (data: { message_id?: unknown }): string => {
  if (typeof data.message_id !== "string" || !data.message_id) throw new MetaUnsure();
  return data.message_id;
};

/** Sends plain words. Returns Meta's id for the message. */
export async function sendText(
  target: SendTarget,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return messageId(
    await call<{ message_id?: unknown }>(
      fetchImpl,
      target.token,
      `/${encodeURIComponent(target.pageId)}/messages`,
      { method: "POST", json: { ...envelope(target), message: { text } } },
    ),
  );
}

/** Sends pictures, each by a short-lived link Meta fetches once. Returns Meta's id for the message. */
export async function sendImages(
  target: SendTarget,
  urls: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const image = (url: string) => ({ type: "image", payload: { url } });
  return messageId(
    await call<{ message_id?: unknown }>(
      fetchImpl,
      target.token,
      `/${encodeURIComponent(target.pageId)}/messages`,
      {
        method: "POST",
        json: {
          ...envelope(target),
          message:
            urls.length === 1 ? { attachment: image(urls[0]) } : { attachments: urls.map(image) },
        },
      },
      90_000,
    ),
  );
}

/**
 * A person's name and, on Instagram, their username. Never their picture.
 * Meta may say nothing at all (no permission, a blocked account): that is
 * an answer of "unknown", not an error.
 */
export async function readProfile(
  channel: SocialChannel,
  token: string,
  personId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ name: string | null; handle: string | null }> {
  const unknown = { name: null, handle: null };
  try {
    const data = await call<Record<string, unknown>>(
      fetchImpl,
      token,
      `/${encodeURIComponent(personId)}`,
      { query: { fields: channel === "instagram" ? "name,username" : "first_name,last_name" } },
      15_000,
    );
    const words = (value: unknown) =>
      typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    const name =
      channel === "instagram"
        ? words(data.name)
        : [words(data.first_name), words(data.last_name)].filter(Boolean).join(" ");
    return {
      name: name || null,
      handle: channel === "instagram" ? tidyHandle(data.username) : null,
    };
  } catch {
    return unknown;
  }
}

/**
 * A public reply under a comment, written as the Page or the Instagram
 * account. Returns Meta's id for the new comment. Plain words only.
 */
export async function replyToComment(
  channel: SocialChannel,
  token: string,
  commentId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const data = await call<{ id?: unknown }>(
    fetchImpl,
    token,
    // Facebook: a comment on the comment. Instagram: the comment's replies.
    `/${encodeURIComponent(commentId)}/${channel === "instagram" ? "replies" : "comments"}`,
    { method: "POST", json: { message: text } },
  );
  if (typeof data.id !== "string" || !data.id) throw new MetaUnsure();
  return data.id;
}

/**
 * The one private message Meta allows about a comment: the Send API with the
 * comment as the recipient. Returns Meta's id for the message and the
 * person's id, under which their answer (if any) will arrive as a message.
 */
export async function sendPrivateReply(
  target: { pageId: string; token: string },
  commentId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ messageId: string; recipientId: string | null }> {
  const data = await call<{ message_id?: unknown; recipient_id?: unknown }>(
    fetchImpl,
    target.token,
    `/${encodeURIComponent(target.pageId)}/messages`,
    { method: "POST", json: { recipient: { comment_id: commentId }, message: { text } } },
  );
  return {
    messageId: messageId(data),
    recipientId:
      typeof data.recipient_id === "string" && data.recipient_id ? data.recipient_id : null,
  };
}

const done = (data: { success?: unknown }) => {
  if (data.success !== true && data.success !== "true") throw new MetaUnsure();
};

/** Hides a comment from everyone but its author and their friends, or shows it again. */
export async function setCommentHidden(
  channel: SocialChannel,
  token: string,
  commentId: string,
  hidden: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  done(
    await call<{ success?: unknown }>(
      fetchImpl,
      token,
      `/${encodeURIComponent(commentId)}`,
      channel === "instagram"
        ? { method: "POST", query: { hide: String(hidden) } }
        : { method: "POST", json: { is_hidden: hidden } },
    ),
  );
}

/** Deletes a comment on the platform. There is no undoing it. */
export async function deleteComment(
  token: string,
  commentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  done(
    await call<{ success?: unknown }>(fetchImpl, token, `/${encodeURIComponent(commentId)}`, {
      method: "DELETE",
    }),
  );
}

/**
 * A post's address and caption, so the team can see what a comment is about.
 * Only those two fields are asked for: never its pictures or video. Throws
 * `MetaRefused` when Meta won't say (a post that has gone, no permission).
 */
export async function readPost(
  channel: SocialChannel,
  token: string,
  postId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ permalink: string | null; caption: string }> {
  const data = await call<Record<string, unknown>>(
    fetchImpl,
    token,
    `/${encodeURIComponent(postId)}`,
    { query: { fields: channel === "instagram" ? "caption,permalink" : "message,permalink_url" } },
    15_000,
  );
  const words = (value: unknown) => (typeof value === "string" ? value : "");
  return channel === "instagram"
    ? { permalink: words(data.permalink) || null, caption: words(data.caption) }
    : { permalink: words(data.permalink_url) || null, caption: words(data.message) };
}

/**
 * Meta lets one tool at a time answer a conversation ("thread control", part
 * of its Conversation Routing). These are its refusals to a tool that isn't
 * the one: Instagram's (#100, 2534037: "not the thread owner"), Messenger's
 * (#10, 2018300: "another app controls the conversation"), and the same said
 * in other words by older versions (secondary receiver, standby).
 */
export function ownedElsewhere(refusal: {
  code: number | null;
  subcode: number | null;
  reason: string;
}): boolean {
  return (
    (refusal.code === 100 && refusal.subcode === 2534037) ||
    (refusal.code === 10 && refusal.subcode === 2018300) ||
    /thread[ _]owner|another app (controls|is controlling|has control)|controls the conversation|thread control|secondary receiver|standby/i.test(
      refusal.reason,
    )
  );
}

const asked = (data: { success?: unknown }) => {
  if (data.success !== true && data.success !== "true") throw new MetaUnsure();
};

/**
 * Makes this app the one that answers a conversation. Meta only allows it
 * where the business has a default app set for the channel AND has allowed
 * this app to "Take control of conversations"; otherwise it refuses
 * (`MetaRefused`). Never called unless the workspace switched it on.
 */
export async function takeThreadControl(
  target: { pageId: string; token: string; recipientId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  asked(
    await call<{ success?: unknown }>(
      fetchImpl,
      target.token,
      `/${encodeURIComponent(target.pageId)}/take_thread_control`,
      { method: "POST", json: { recipient: { id: target.recipientId } } },
      15_000,
    ),
  );
}

/**
 * Asks for a conversation. Meta only offers this where the business has NOT
 * set a default app: an idle conversation is handed over at once, and for one
 * another tool is answering, that tool is asked and may or may not pass it on.
 * "Yes" here means the asking was heard, not that the conversation is ours.
 */
export async function requestThreadControl(
  target: { pageId: string; token: string; recipientId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  asked(
    await call<{ success?: unknown }>(
      fetchImpl,
      target.token,
      `/${encodeURIComponent(target.pageId)}/request_thread_control`,
      { method: "POST", json: { recipient: { id: target.recipientId } } },
      15_000,
    ),
  );
}

/** What we ask a Page to send us for messages. Instagram's messages ride on the Page's `messages` field. */
export const SUBSCRIBED_FIELDS = ["messages", "message_echoes", "message_reactions"] as const;
/**
 * And for comments: the Page's `feed`. Instagram's comments are a field of
 * the app's own Instagram webhook; they start arriving for an account once
 * its Page has the app installed with any field, so `feed` does for both.
 */
export const COMMENT_FIELDS = ["feed"] as const;

/**
 * And for a business that has more than one inbox tool on the account:
 * `standby` carries the messages of a conversation another tool is answering
 * (without it they never reach us at all), and `messaging_handovers` says
 * when a conversation changes hands. Asked for with messages; if Meta won't
 * have them, the Page is subscribed without (`subscribePage`).
 */
export const CONTROL_FIELDS = ["standby", "messaging_handovers"] as const;

/** The fields a Page should be subscribed with, for what is granted and switched on. */
export function subscribedFieldsFor(want: { messages: boolean; comments: boolean }): string[] {
  return [
    ...(want.messages ? [...SUBSCRIBED_FIELDS, ...CONTROL_FIELDS] : []),
    ...(want.comments ? COMMENT_FIELDS : []),
  ];
}

/** Asks Meta to send this Page's (and its Instagram account's) activity to our webhook. */
export async function subscribePage(
  pageId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  fields: readonly string[] = SUBSCRIBED_FIELDS,
): Promise<void> {
  const ask = (list: readonly string[]) =>
    call(fetchImpl, token, `/${encodeURIComponent(pageId)}/subscribed_apps`, {
      method: "POST",
      query: { subscribed_fields: list.join(",") },
    });
  try {
    await ask(fields);
  } catch (err) {
    // The two hand-over fields are a nicety: a Page Meta won't subscribe with
    // them is subscribed without, so messages still arrive.
    const plain = fields.filter((field) => !CONTROL_FIELDS.some((one) => one === field));
    if (!(err instanceof MetaRefused) || plain.length === fields.length || plain.length === 0) {
      throw err;
    }
    await ask(plain);
  }
}

/** Stops them. Best effort: a Page that was never subscribed is fine. */
export async function unsubscribePage(
  pageId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await call(fetchImpl, token, `/${encodeURIComponent(pageId)}/subscribed_apps`, {
    method: "DELETE",
  });
}

/** How a refused send is written down: Meta's numbers, then its own short sentence. */
export const refusalText = (err: MetaRefused, partial = false): string =>
  `meta:${err.code ?? "x"}:${err.subcode ?? "x"}:${partial ? "partial" : "none"}:${err.reason}`.slice(
    0,
    200,
  );

/** A stored refusal read back into Meta's numbers and sentence. Null for our own codes. */
function refusalParts(stored: string | null) {
  const match = /^meta:([^:]*):([^:]*):(partial|none):([\s\S]*)$/.exec(stored ?? "");
  if (!match) return null;
  const number = (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : null);
  return {
    code: number(match[1]),
    subcode: number(match[2]),
    partial: match[3] === "partial",
    reason: match[4].trim(),
  };
}

/**
 * For the team, when another tool has the conversation. Waiting isn't
 * offered as a way out: Meta's documentation says that once a conversation
 * has gone quiet only the business's chosen ("default") app may write.
 */
export const OWNED_ELSEWHERE =
  "Another inbox tool is answering this conversation just now, and Meta lets only one tool reply at a time, so nothing was sent. You can answer from that tool (Meta's own inbox counts as one). To answer from here, an owner can choose which tool replies in Meta Business Suite → Settings → Conversation routing: see Settings → Help desk → Channels.";

/** Whether a stored refusal is Meta saying another tool has the conversation. */
export const storedOwnedElsewhere = (stored: string | null): boolean => {
  const parts = refusalParts(stored);
  return parts !== null && ownedElsewhere(parts);
};

/**
 * Meta's own words and numbers for a refusal, for a "Details" line under our
 * plain ones. Null when there are none, or our words already quote them.
 */
export function refusalDetails(stored: string | null): string | null {
  const parts = refusalParts(stored);
  if (!parts || !parts.reason) return null;
  if (refusalWords(stored).includes(parts.reason)) return null;
  const numbers = [
    parts.code === null ? null : `code ${parts.code}`,
    parts.subcode === null ? null : `subcode ${parts.subcode}`,
  ].filter(Boolean);
  return `Meta said: “${parts.reason}”${numbers.length ? ` (${numbers.join(", ")})` : ""}`;
}

/** Our words and, after them, Meta's own: for a place with one line to say it in. */
export function refusalWithDetails(stored: string | null): string {
  const details = refusalDetails(stored);
  return details ? `${refusalWords(stored)} Details: ${details}.` : refusalWords(stored);
}

/** The words for the team about a send that didn't go (or only partly went). */
export function refusalWords(stored: string | null): string {
  if (stored === "window_closed") {
    return "It has been more than 24 hours since their last message, so it couldn't be sent. You can reply once they write again.";
  }
  if (stored === "not_connected") {
    return "Facebook & Instagram isn't connected for messages just now. Reconnect it in Settings → Help desk → Channels.";
  }
  if (stored === "too_long") return "It was longer than one message can hold.";
  if (stored === "no_comment") {
    return "There is no comment left here to answer: it was removed.";
  }
  if (stored === "comment_changed") {
    return "They commented again while this was waiting, so it wasn't sent. Have a look at what they said and send it again.";
  }
  if (stored === "comment_hidden") {
    return "Instagram doesn't allow a public reply to a hidden comment. Show the comment again first, or message them privately.";
  }
  if (stored === "private_used") {
    return "This comment has already had its one private message, which is all Meta allows. If they answer, it arrives as its own message conversation.";
  }
  if (stored === "private_expired") {
    return "A private message can only be sent within seven days of the comment, and that has passed. You can still reply publicly.";
  }
  if (stored === "not_allowed") {
    return "Facebook didn't give permission for that. An owner or admin can allow it in Settings → Help desk → Channels.";
  }
  if (stored === "comments_off") {
    return "Comments aren't switched on and connected just now. See Settings → Help desk → Channels.";
  }
  if (stored === "files") return "The pictures couldn't be read. Attach them again.";
  const parts = refusalParts(stored);
  if (!parts) return "Meta didn't take it. Try again in a moment.";
  const { code, subcode, reason } = parts;
  const start = parts.partial ? "Your words were sent, but the pictures weren't. " : "";
  const said = reason ? ` Meta said: “${reason}”` : "";
  if (ownedElsewhere(parts)) return `${start}${OWNED_ELSEWHERE}`;
  if (code === 190) {
    return `${start}Meta no longer accepts this connection. Reconnect Facebook & Instagram in Settings → Connections.`;
  }
  if (code === 10 && (subcode === 2018278 || subcode === 2534022)) {
    return `${start}It has been more than 24 hours since their last message, so Meta wouldn't deliver it. You can reply once they write again.`;
  }
  if ((code === 10 && subcode === 2018108) || code === 551 || subcode === 1545041) {
    return `${start}This person can't receive messages from you right now. They may have blocked or muted the conversation.`;
  }
  if (code === 200 && subcode === 2534041) {
    return `${start}Instagram isn't letting connected tools read messages. In the Instagram app: Settings → Messages and story replies → Message requests → Allow access to messages.`;
  }
  if (/private repl|already (been )?replied/i.test(reason)) {
    return `${start}That comment has already had its one private message, which is all Meta allows.`;
  }
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80001) {
    return `${start}Meta is limiting how fast messages can be sent just now. Try again in a few minutes.`;
  }
  if (code === 10 || code === 200 || code === 230) {
    return `${start}Meta didn't allow that. The Meta app may be missing a permission, or this person isn't someone it can message yet.${said}`;
  }
  return `${start}Meta didn't take it.${said}`;
}
