import { actionsFor, type AutoTagRules, type RuleOutcome } from "../config";
import type { IncomingFile } from "../files";
import { CHANNEL_LABELS, type CommentFilter, type SocialChannel } from "./channels";
import { commentSubject, startsConversation } from "./comments";
import {
  parseMetaPayload,
  reactionId,
  socialSubject,
  type CommentEvent,
  type SocialEvent,
} from "./events";

/**
 * Files one queued webhook delivery: each message or comment in it becomes,
 * or lands on, a conversation. Pure orchestration: every read and write is handed in,
 * so it can be tested without a database or Meta.
 */

/** Whose workspace an account belongs to, and the Page its messages are sent through. */
export type SocialWhere = { tenantId: string; pageId: string; channel: SocialChannel };

export type FileResult = {
  result: "created" | "threaded" | "duplicate" | "ignored" | "retry";
  ticket_id?: string;
  message_id?: string;
  contact_id?: string;
  number?: number;
  /** The person's name and handle haven't been read from Meta lately. */
  needs_profile?: boolean;
  kept_in?: string | null;
};

/** A workspace that takes comments from an account, and the account's own Instagram username. */
export type CommentWhere = SocialWhere & { ownHandle: string | null };
export type CommentFiled = Omit<FileResult, "result"> & {
  /** "filtered": not worth a conversation by itself, and none was going. */
  result: FileResult["result"] | "filtered";
  /** Our row for the post it is on. */
  post_id?: string;
  /** Meta hasn't been asked about that post yet. */
  needs_post?: boolean;
};
export type NewComment = Extract<CommentEvent, { type: "comment" }>;

type MessageEvent = Extract<SocialEvent, { type: "message" }>;
type EchoEvent = Extract<SocialEvent, { type: "echo" }>;
type ReactionEvent = Extract<SocialEvent, { type: "reaction" }>;

/** Who Meta lets answer a conversation, as far as we know. */
export type ThreadControl = "ours" | "other";

/**
 * What a change of hands means for us. Meta tells the receiving app about a
 * "pass" and the losing app about a "take"; where it names the new app and we
 * know our own id, that settles it instead.
 */
export function controlAfter(
  change: "pass" | "take",
  appId: string | null,
  ourAppId: string | null,
): ThreadControl {
  if (appId && ourAppId) return appId === ourAppId ? "ours" : "other";
  return change === "pass" ? "ours" : "other";
}

export type IntakeDeps = {
  now(): number;
  /** Our own Meta app's id: an echo carrying it is something the help desk sent, already on file. */
  ourAppId: string | null;
  /** Null when no workspace has this account connected with messages switched on. */
  whereFor(channel: SocialChannel, accountId: string): Promise<SocialWhere | null>;
  rulesFor(tenantId: string): Promise<AutoTagRules>;
  file(
    where: SocialWhere,
    event: MessageEvent,
    subject: string,
    tags: string[],
  ): Promise<FileResult>;
  echo(where: SocialWhere, event: EchoEvent): Promise<FileResult>;
  remove(where: SocialWhere, mid: string): Promise<void>;
  react(where: SocialWhere, event: ReactionEvent, id: string): Promise<void>;
  /**
   * Writes down who is answering a person's conversation at Meta, as far as
   * we were told: this app ("ours") or another tool ("other", with its app id
   * when Meta gave one). A note for the team, never a rule: Meta decides.
   */
  noteControl?(
    where: SocialWhere,
    personId: string,
    state: ThreadControl,
    appId: string | null,
    at: string,
  ): Promise<void>;
  /** Reads the person's name and handle from Meta and keeps them on the contact. */
  refreshProfile?(where: SocialWhere, personId: string, contactId: string): Promise<string | null>;
  /** Fetches the message's files from Meta's hosts. */
  fetchFiles?(event: MessageEvent): Promise<IncomingFile[]>;
  keepFiles?(where: SocialWhere, result: FileResult, files: IncomingFile[]): Promise<void>;
  /** Once for a brand-new conversation, with what the rules decided and who it is from. */
  onCreated?(
    where: SocialWhere,
    event: MessageEvent,
    result: FileResult,
    outcome: RuleOutcome,
    who: string | null,
  ): Promise<void>;
  /**
   * Looks at a filed message for the automatic first reply (fixed words from
   * Settings; the rules live in `auto-reply/rules.ts`). Only ever called for
   * a real message from a person: never for an echo, a reaction, an unsend,
   * a change of hands or a comment. Trouble here never stops the filing.
   */
  autoReply?(where: SocialWhere, event: MessageEvent, result: FileResult): Promise<void>;
  /**
   * Comments. Null when no workspace takes comments from this account
   * (not connected for them, or switched off). Without these, comments in a
   * delivery are simply dropped.
   */
  commentsFor?(channel: SocialChannel, accountId: string): Promise<CommentWhere | null>;
  /** Which comments start a conversation, from the workspace's settings. */
  commentFilterFor?(
    tenantId: string,
  ): Promise<{ comment_filter: CommentFilter; comment_words: readonly string[] }>;
  /** Files a customer's comment. `start` false means: only if a conversation is already going. */
  fileComment?(
    where: CommentWhere,
    event: NewComment,
    subject: string,
    tags: string[],
    start: boolean,
  ): Promise<CommentFiled>;
  /** Files a comment the Page or account wrote itself, under the comment it answers. */
  ownComment?(where: CommentWhere, event: NewComment): Promise<FileResult>;
  /** Changes a comment's words. False when we never had that comment. */
  editComment?(where: CommentWhere, event: NewComment): Promise<boolean>;
  removeComment?(where: CommentWhere, commentId: string): Promise<void>;
  hideComment?(where: CommentWhere, commentId: string, hidden: boolean): Promise<void>;
  /** Asks Meta once for the post's address and caption, and keeps them. */
  refreshPost?(where: CommentWhere, event: NewComment, postId: string): Promise<void>;
  fetchCommentFiles?(event: NewComment): Promise<IncomingFile[]>;
  onCommentCreated?(
    where: CommentWhere,
    event: NewComment,
    result: CommentFiled,
    outcome: RuleOutcome,
  ): Promise<void>;
};

/** Files one comment event. Returns what happened, in a word. */
async function processComment(
  event: CommentEvent,
  where: CommentWhere,
  deps: IntakeDeps,
): Promise<string> {
  if (event.type === "comment_removed") {
    await deps.removeComment?.(where, event.commentId);
    return "comment removed";
  }
  if (event.type === "comment_hidden") {
    await deps.hideComment?.(where, event.commentId, event.hidden);
    return event.hidden ? "comment hidden" : "comment shown";
  }
  // An edit of a comment we hold changes its words. One we never held (it
  // wasn't worth a conversation before) is looked at afresh, as a new comment.
  if (event.edited && (await deps.editComment?.(where, event))) return "comment edited";
  const own =
    event.own ||
    (event.handle !== null &&
      where.ownHandle !== null &&
      event.handle.toLowerCase() === where.ownHandle.toLowerCase());
  if (own) {
    // The team's, written in the app, or the help desk's own reply heard back.
    if (!event.parentId || !deps.ownComment) return "own comment ignored";
    const result = await deps.ownComment(where, event);
    if (result.result === "retry") throw new RetryLater();
    return `own comment ${result.result}`;
  }
  if (!deps.fileComment || !deps.commentFilterFor) return "dropped";
  const subject = commentSubject(event.channel, event.text, event.summary);
  const outcome = actionsFor(await deps.rulesFor(where.tenantId), {
    subject,
    body: event.text,
    from: CHANNEL_LABELS[event.channel],
  });
  const start = startsConversation(
    { text: event.text, hasMedia: event.media.length > 0 },
    await deps.commentFilterFor(where.tenantId),
  );
  const result = await deps.fileComment(where, event, subject, outcome.tags, start);
  if (result.result === "filtered") return "comment not kept";
  if (result.post_id && result.needs_post && deps.refreshPost) {
    // What the post says is a nicety: trouble reading it never loses the comment.
    await deps.refreshPost(where, event, result.post_id).catch(() => undefined);
  }
  if (result.result === "created") await deps.onCommentCreated?.(where, event, result, outcome);
  // A comment seen before still gets its files, so a retry can finish the job.
  if (result.message_id && event.media.length > 0 && deps.fetchCommentFiles && deps.keepFiles) {
    await deps.keepFiles(
      where,
      { ...result, result: "threaded" },
      await deps.fetchCommentFiles(event),
    );
  }
  return `comment ${result.result}`;
}

/** Come back to this delivery later (one of our own sends is still being written down). */
export class RetryLater extends Error {
  constructor() {
    super("retry later");
    this.name = "RetryLater";
  }
}

export async function processMetaPayload(payload: unknown, deps: IntakeDeps): Promise<string[]> {
  const outcomes: string[] = [];
  const places = new Map<string, SocialWhere | null>();
  const commentPlaces = new Map<string, CommentWhere | null>();
  for (const event of parseMetaPayload(payload, deps.now())) {
    const key = `${event.channel}:${event.accountId}`;
    if (
      event.type === "comment" ||
      event.type === "comment_removed" ||
      event.type === "comment_hidden"
    ) {
      // Comments have their own switch and their own permissions.
      if (!commentPlaces.has(key)) {
        commentPlaces.set(key, (await deps.commentsFor?.(event.channel, event.accountId)) ?? null);
      }
      const place = commentPlaces.get(key);
      outcomes.push(place ? await processComment(event, place, deps) : "dropped");
      continue;
    }
    if (!places.has(key)) places.set(key, await deps.whereFor(event.channel, event.accountId));
    const where = places.get(key);
    if (!where) {
      outcomes.push("dropped");
      continue;
    }
    if (event.type === "control") {
      // Another tool asking us for the conversation changes nothing by itself:
      // handing one over is a person's choice, made in Meta's settings.
      if (event.change === "request") {
        outcomes.push("control asked");
        continue;
      }
      const state = controlAfter(event.change, event.appId, deps.ourAppId);
      await deps
        .noteControl?.(
          where,
          event.personId,
          state,
          state === "other" ? event.appId : null,
          event.at,
        )
        .catch(() => undefined);
      outcomes.push(`control ${state}`);
    } else if (event.type === "removed") {
      await deps.remove(where, event.mid);
      outcomes.push("removed");
    } else if (event.type === "reaction") {
      await deps.react(where, event, reactionId(event.mid, event.personId));
      outcomes.push(event.action);
    } else if (event.type === "echo") {
      // What the help desk itself sent is filed by the send, with its author.
      if (deps.ourAppId && event.appId === deps.ourAppId) {
        outcomes.push("ours");
        continue;
      }
      const result = await deps.echo(where, event);
      if (result.result === "retry") throw new RetryLater();
      outcomes.push(`echo ${result.result}`);
    } else {
      const subject = socialSubject(event.channel, event.text, event.summary);
      const outcome = actionsFor(await deps.rulesFor(where.tenantId), {
        subject,
        body: event.text,
        from: CHANNEL_LABELS[event.channel],
      });
      const result = await deps.file(where, event, subject, outcome.tags);
      let who: string | null = null;
      if (result.contact_id && result.needs_profile && deps.refreshProfile) {
        who = await deps.refreshProfile(where, event.personId, result.contact_id).catch(() => null);
      }
      if (result.result === "created") {
        await deps.onCreated?.(where, event, result, outcome, who);
      }
      // Asked for a message seen before as well: the claim is once per message,
      // so a retry only finishes what the first try didn't get to.
      if (result.message_id && result.result !== "ignored" && result.result !== "retry") {
        await deps.autoReply?.(where, event, result).catch(() => undefined);
      }
      // A message seen before still gets its files, so a retry can finish the job.
      if (result.message_id && event.media.length > 0 && deps.fetchFiles && deps.keepFiles) {
        if (result.result !== "ignored") {
          await deps.keepFiles(where, result, await deps.fetchFiles(event));
        }
      }
      // It came on Meta's standby channel: another tool was answering then.
      if (event.standby && result.result !== "ignored") {
        await deps
          .noteControl?.(where, event.personId, "other", null, event.at)
          .catch(() => undefined);
      }
      outcomes.push(event.standby ? `${result.result} (standby)` : result.result);
    }
  }
  return outcomes;
}
