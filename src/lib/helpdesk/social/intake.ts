import { actionsFor, type AutoTagRules, type RuleOutcome } from "../config";
import type { IncomingFile } from "../files";
import { CHANNEL_LABELS, type SocialChannel } from "./channels";
import { parseMetaPayload, reactionId, socialSubject, type SocialEvent } from "./events";

/**
 * Files one queued webhook delivery: each message in it becomes, or lands
 * on, a conversation. Pure orchestration: every read and write is handed in,
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

type MessageEvent = Extract<SocialEvent, { type: "message" }>;
type EchoEvent = Extract<SocialEvent, { type: "echo" }>;
type ReactionEvent = Extract<SocialEvent, { type: "reaction" }>;

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
};

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
  for (const event of parseMetaPayload(payload, deps.now())) {
    const key = `${event.channel}:${event.accountId}`;
    if (!places.has(key)) places.set(key, await deps.whereFor(event.channel, event.accountId));
    const where = places.get(key);
    if (!where) {
      outcomes.push("dropped");
      continue;
    }
    if (event.type === "removed") {
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
      // A message seen before still gets its files, so a retry can finish the job.
      if (result.message_id && event.media.length > 0 && deps.fetchFiles && deps.keepFiles) {
        if (result.result !== "ignored") {
          await deps.keepFiles(where, result, await deps.fetchFiles(event));
        }
      }
      outcomes.push(result.result);
    }
  }
  return outcomes;
}
