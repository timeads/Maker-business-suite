import { z } from "zod";
import { TAG_PATTERN } from "../config";
import { richDocSchema, richToText } from "../rich";
import { SOCIAL_CHANNELS, textFits, type SocialChannel } from "./channels";
import {
  MetaRefused,
  MetaUnsure,
  refusalText,
  sendImages,
  sendText,
  type SendTarget,
} from "./graph";

/**
 * A reply on Instagram or Facebook, as it waits in the help desk's outbox
 * and as it is sent. It travels the same road as an email (queued with the
 * undo wait, sent by the worker, filed as its author) with a deliverer of
 * its own: plain words, then any pictures, through Meta's Send API.
 */
export const socialPayloadSchema = z.object({
  kind: z.literal("social"),
  channel: z.enum(SOCIAL_CHANNELS),
  /** The person's words as the small document every reply uses (plain: no formatting is sent). */
  doc: richDocSchema,
  then: z.enum(["pending", "open", "closed", "snoozed", "keep"]),
  snooze_until: z.string().datetime().nullable().default(null),
  files: z
    .array(
      z.object({
        name: z.string().max(300),
        type: z.string().max(120),
        size: z.number().int().nonnegative(),
        base64: z.string(),
      }),
    )
    .max(3)
    .default([]),
  add_tags: z.array(z.string().regex(TAG_PATTERN)).max(10).default([]),
  assign_to: z.string().uuid().nullable().default(null),
  /**
   * How it goes: a message in the person's message conversation, or, on a
   * conversation about a comment, a public reply under the comment or the
   * one private message about it.
   */
  via: z.enum(["message", "public", "private"]).default("message"),
  /** Meta's id for the comment being answered (public and private only). */
  comment_id: z.string().min(1).max(200).nullable().default(null),
  /**
   * The automatic first reply: fixed words from Settings, queued by the
   * worker with no author. Only the database sets this (`claim_auto_reply`);
   * a person's own reply has it taken off when it is queued.
   */
  automatic: z.boolean().default(false),
});
export type SocialPayload = z.infer<typeof socialPayloadSchema>;

/** What the conversation shows while the message waits. */
export function socialSummary(payload: SocialPayload, to: string) {
  return {
    kind: "social",
    channel: payload.channel,
    via: payload.via,
    to: [to],
    preview: richToText(payload.doc).replace(/\s+/g, " ").slice(0, 200),
  };
}

export type Delivered = {
  /** Meta's ids for what went: the words first, then the pictures. */
  mids: string[];
  /** Set when the words went and the pictures didn't. */
  problem: string | null;
};

export type DeliverDeps = {
  fetchImpl?: typeof fetch;
  /** Puts a picture where Meta can fetch it once, and returns that short-lived address. */
  stage(file: { name: string; type: string; base64: string }): Promise<string>;
  /** Takes the staged pictures away again, whatever happened. */
  unstage(): Promise<void>;
};

/**
 * Sends one reply. Throws `MetaRefused` when Meta said no and nothing went,
 * `MetaUnsure` when there was no clear answer to the first call. Once the
 * words have gone, trouble with the pictures is reported, never thrown: the
 * reply is filed as what really went.
 */
export async function deliverSocial(
  target: SendTarget,
  channel: SocialChannel,
  text: string,
  files: { name: string; type: string; base64: string }[],
  deps: DeliverDeps,
): Promise<Delivered> {
  if (!text && files.length === 0) throw new MetaRefused(400, null, null, "Nothing to send");
  if (!textFits(channel, text)) throw new MetaRefused(400, null, null, "Too long for one message");
  const mids: string[] = [];
  if (text) mids.push(await sendText(target, text, deps.fetchImpl));
  if (files.length === 0) return { mids, problem: null };
  try {
    const urls: string[] = [];
    for (const file of files) urls.push(await deps.stage(file));
    mids.push(await sendImages(target, urls, deps.fetchImpl));
    return { mids, problem: null };
  } catch (err) {
    // Nothing has gone yet: let the caller say so.
    if (mids.length === 0) throw err;
    return {
      mids,
      problem:
        err instanceof MetaRefused
          ? refusalText(err, true)
          : err instanceof MetaUnsure
            ? "meta:x:x:partial:No clear answer about the pictures"
            : "meta:x:x:partial:The pictures couldn't be made ready",
    };
  } finally {
    await deps.unstage().catch(() => undefined);
  }
}
