import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getProviderToken, type TokenDeps } from "../../connections/tokens";
import { withTenant } from "../../supabase/admin";
import { HELPDESK_MODULE } from "../config";
import { FILES_BUCKET, fromBase64, sniffType } from "../files";
import { richToText } from "../rich";
import {
  CHANNELS_KEY,
  COMMENT_LIMITS,
  MAX_SOCIAL_IMAGE_BYTES,
  SOCIAL_IMAGE_TYPES,
  channelState,
  commentAbilities,
  commentState,
  isSocialChannel,
  parseChannelSettings,
  textFits,
  type ChannelSettings,
  type MetaConnectionFacts,
  type SocialChannel,
} from "./channels";
import { privateReplyState } from "./comments";
import { deliverSocial, type Delivered, type SocialPayload } from "./deliver";
import {
  MetaRefused,
  ownedElsewhere,
  replyToComment,
  requestThreadControl,
  sendPrivateReply,
  takeThreadControl,
} from "./graph";
import { replyWindow } from "./window";

/**
 * Sending a reply on Instagram or Facebook, for the server only. The app
 * (when there is no undo wait) and the worker (when there is) both come
 * through here, so there is one way a message goes out. Everything is
 * re-read from what is stored: who the person is, whether the channel is on
 * and connected with the right permissions, and whether Meta's reply window
 * is still open. The Page's token is read through `getProviderToken` and
 * goes no further than the request to Meta.
 */

/** Why nothing was sent, as the outbox writes it down. */
export class SocialNotSent extends Error {
  constructor(
    public code:
      | "no_conversation"
      | "not_connected"
      | "window_closed"
      | "too_long"
      | "files"
      | "no_comment"
      | "comment_changed"
      | "comment_hidden"
      | "private_used"
      | "private_expired"
      | "not_allowed"
      | "comments_off",
  ) {
    super(code);
    this.name = "SocialNotSent";
  }
}

export type ChannelFacts = { settings: ChannelSettings; connection: MetaConnectionFacts | null };

/** The workspace's channel switches and what its Meta connection says about itself. */
export async function loadChannelFacts(
  admin: SupabaseClient,
  tenantId: string,
): Promise<ChannelFacts> {
  return withTenant(
    tenantId,
    async (scope) => {
      const [{ data: config }, { data: rows }] = await Promise.all([
        scope
          .select("configs", "body")
          .eq("module", HELPDESK_MODULE)
          .eq("key", CHANNELS_KEY)
          .maybeSingle(),
        scope
          .select("connections", "status, scopes, display_name, metadata")
          .eq("provider", "meta")
          .limit(1),
      ]);
      const row = (rows as Record<string, unknown>[] | null)?.[0];
      return {
        settings: parseChannelSettings((config as { body?: unknown } | null)?.body),
        connection: row ? connectionFacts(row) : null,
      };
    },
    admin,
  );
}

/** A `connections` row (status, scopes, display_name, metadata) as the facts the channels go by. */
export function connectionFacts(row: Record<string, unknown>): MetaConnectionFacts {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return {
    status: text(row.status),
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : null,
    pageName: text(row.display_name)?.split(" · ")[0] ?? null,
    instagramId: text(metadata.instagram_id),
    instagramUsername: text(metadata.instagram_username),
  };
}

export type SocialSendDeps = {
  admin: SupabaseClient;
  tokenDeps?: TokenDeps;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** For tests: the workspace's switches and connection, instead of reading them. */
  facts?: () => Promise<ChannelFacts>;
};

/**
 * Sends one reply and says what went. Throws `SocialNotSent` when we stopped
 * before asking Meta, `MetaRefused` when Meta said no, and anything else
 * when there was no clear answer.
 */
export async function sendSocialReply(
  where: { tenantId: string; ticketId: string },
  payload: SocialPayload,
  deps: SocialSendDeps,
): Promise<Delivered & { channel: SocialChannel }> {
  const { admin } = deps;
  const { data: rows, error } = await admin.rpc("social_reply_context", {
    p_tenant_id: where.tenantId,
    p_ticket_id: where.ticketId,
  });
  const context = (rows as Record<string, string | null>[] | null)?.[0];
  if (error || !context?.external_id || !isSocialChannel(context.channel)) {
    throw new SocialNotSent("no_conversation");
  }
  const channel = context.channel;
  const facts = await (deps.facts?.() ?? loadChannelFacts(admin, where.tenantId));
  if (channelState(channel, facts.settings, facts.connection).state !== "on") {
    throw new SocialNotSent("not_connected");
  }
  const window = replyWindow(context.last_inbound_at, (deps.now ?? Date.now)(), {
    humanAgent: facts.settings.human_agent,
  });
  if (!window.open) throw new SocialNotSent("window_closed");

  const text = richToText(payload.doc);
  if (!textFits(channel, text)) throw new SocialNotSent("too_long");
  // A picture is believed by its own first bytes, as every file here is.
  const files = payload.files.map((file) => {
    const bytes = fromBase64(file.base64);
    const type = sniffType(bytes, { type: file.type, name: file.name });
    if (
      !type ||
      !SOCIAL_IMAGE_TYPES.some((allowed) => allowed === type) ||
      bytes.length > MAX_SOCIAL_IMAGE_BYTES
    ) {
      throw new SocialNotSent("files");
    }
    return { name: file.name, type, base64: file.base64, bytes };
  });
  if (!text && files.length === 0) throw new SocialNotSent("too_long");

  const stored = await getProviderToken(where.tenantId, "meta", deps.tokenDeps);
  const bucket = admin.storage.from(FILES_BUCKET);
  const staged: string[] = [];
  const target = {
    pageId: stored.externalAccountId,
    token: stored.token.access_token,
    recipientId: context.external_id,
    humanAgent: window.needsHumanAgentTag,
  };
  const deliver = () =>
    deliverSocial(target, channel, text, files, {
      fetchImpl: deps.fetchImpl,
      // Meta fetches a picture by address. It is put in the private bucket
      // under a name of our own and handed over as a link that works for a
      // few minutes, then taken away again.
      async stage(file) {
        const path = `${where.tenantId}/${where.ticketId}/outgoing/${randomUUID()}`;
        const match = files.find((f) => f.base64 === file.base64)!;
        const { error: uploadError } = await bucket.upload(path, match.bytes, {
          contentType: match.type,
          upsert: false,
        });
        if (uploadError) throw new Error("could not stage a picture");
        staged.push(path);
        const { data: link, error: linkError } = await bucket.createSignedUrl(path, 600);
        if (linkError || !link?.signedUrl) throw new Error("could not stage a picture");
        return link.signedUrl;
      },
      async unstage() {
        if (staged.length > 0) await bucket.remove(staged);
      },
    });
  // What Meta said about who answers this person, for the team to see. A
  // note only: trouble writing it never changes how the send went.
  const note = async (state: "ours" | "other") => {
    try {
      await admin.rpc("note_thread_control", {
        p_tenant_id: where.tenantId,
        p_channel: channel,
        p_external_id: context.external_id,
        p_state: state,
        p_app_id: null,
        p_at: new Date((deps.now ?? Date.now)()).toISOString(),
      });
    } catch {
      // Nothing to do about it here.
    }
  };
  let went: Delivered;
  try {
    went = await deliver();
  } catch (err) {
    // Another tool has the conversation. Meta said no, so nothing went.
    if (!(err instanceof MetaRefused) || !ownedElsewhere(err)) throw err;
    // Only a workspace that chose to may pull a conversation over to here.
    if (!facts.settings.take_control || !(await gainControl(target, deps.fetchImpl))) {
      await note("other");
      throw err;
    }
    try {
      went = await deliver();
    } catch (again) {
      if (again instanceof MetaRefused && ownedElsewhere(again)) await note("other");
      throw again;
    }
  }
  await note("ours");
  return { ...went, channel };
}

/**
 * Tries to make this app the one that answers, in the two ways Meta offers.
 * Taking works where the business set a default app and allowed this one to
 * "Take control of conversations"; asking works where it set none. Whichever
 * doesn't apply is refused by Meta, which is why both are tried. True when
 * Meta said yes to one: the reply is then worth one more try (the first was
 * refused outright, so nothing can go twice).
 */
async function gainControl(
  target: { pageId: string; token: string; recipientId: string },
  fetchImpl: typeof fetch | undefined,
): Promise<boolean> {
  for (const ask of [takeThreadControl, requestThreadControl]) {
    try {
      await ask(target, fetchImpl);
      return true;
    } catch {
      // Refused, or no clear answer: the other way, then give up.
    }
  }
  return false;
}

/** The customer's latest standing comment on a conversation, as the database tells it. */
export type CommentContext = {
  channel: SocialChannel;
  externalId: string;
  label: string | null;
  commentId: string | null;
  commentMessageId: string | null;
  commentAt: string | null;
  commentHidden: boolean;
  privateReply: string | null;
};

export async function loadCommentContext(
  admin: SupabaseClient,
  where: { tenantId: string; ticketId: string },
): Promise<CommentContext | null> {
  const { data: rows, error } = await admin.rpc("comment_reply_context", {
    p_tenant_id: where.tenantId,
    p_ticket_id: where.ticketId,
  });
  const row = (rows as Record<string, unknown>[] | null)?.[0];
  if (error || !row || !isSocialChannel(row.channel) || typeof row.external_id !== "string") {
    return null;
  }
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return {
    channel: row.channel,
    externalId: row.external_id,
    label: text(row.label),
    commentId: text(row.comment_id),
    commentMessageId: text(row.comment_message_id),
    commentAt: text(row.comment_at),
    commentHidden: row.comment_hidden === true,
    privateReply: text(row.private_reply),
  };
}

/**
 * Answers a comment: a public reply under it, or the one private message
 * about it. As with messages, everything is re-read from what is stored
 * before Meta is asked. For a private message the comment is claimed first
 * (`claim_private_reply`), which is what holds Meta's one-per-comment rule
 * here; a refusal gives the claim back, and no clear answer leaves it taken,
 * because the message may have gone.
 *
 * Returns Meta's id for what was sent. Throws `SocialNotSent` when we stopped
 * before asking Meta, `MetaRefused` when Meta said no, and anything else when
 * there was no clear answer.
 */
export async function sendCommentReply(
  where: { tenantId: string; ticketId: string },
  payload: SocialPayload,
  deps: SocialSendDeps,
): Promise<{ externalId: string; via: "public" | "private"; channel: SocialChannel }> {
  const { admin } = deps;
  const via = payload.via;
  if (via !== "public" && via !== "private") throw new SocialNotSent("no_conversation");
  const context = await loadCommentContext(admin, where);
  if (!context) throw new SocialNotSent("no_conversation");
  if (!context.commentId) throw new SocialNotSent("no_comment");
  // The reply was written under one comment: it never lands under another.
  if (payload.comment_id !== context.commentId) throw new SocialNotSent("comment_changed");
  const channel = context.channel;
  const facts = await (deps.facts?.() ?? loadChannelFacts(admin, where.tenantId));
  if (commentState(channel, facts.settings, facts.connection).state !== "on") {
    throw new SocialNotSent("comments_off");
  }
  const can = commentAbilities(channel, facts.connection?.scopes ?? null);
  const text = richToText(payload.doc).trim();
  if (!text) throw new SocialNotSent("too_long");

  if (via === "public") {
    if (!can.reply) throw new SocialNotSent("not_allowed");
    if ([...text].length > COMMENT_LIMITS[channel].max) throw new SocialNotSent("too_long");
    // Instagram refuses a reply to a hidden comment; say so in our own words first.
    if (channel === "instagram" && context.commentHidden) {
      throw new SocialNotSent("comment_hidden");
    }
    const stored = await getProviderToken(where.tenantId, "meta", deps.tokenDeps);
    const externalId = await replyToComment(
      channel,
      stored.token.access_token,
      context.commentId,
      text,
      deps.fetchImpl,
    );
    return { externalId, via, channel };
  }

  if (!textFits(channel, text)) throw new SocialNotSent("too_long");
  const state = privateReplyState(
    { at: context.commentAt, privateReply: context.privateReply },
    (deps.now ?? Date.now)(),
    can.privately,
  ).state;
  if (state === "not_allowed") throw new SocialNotSent("not_allowed");
  if (state === "expired") throw new SocialNotSent("private_expired");
  if (state !== "available") throw new SocialNotSent("private_used");
  const stored = await getProviderToken(where.tenantId, "meta", deps.tokenDeps);
  const { data: claimed, error } = await admin.rpc("claim_private_reply", {
    p_tenant_id: where.tenantId,
    p_ticket_id: where.ticketId,
    p_comment_id: context.commentId,
  });
  if (error) throw new SocialNotSent("no_conversation");
  if (claimed !== true) throw new SocialNotSent("private_used");
  try {
    const went = await sendPrivateReply(
      { pageId: stored.externalAccountId, token: stored.token.access_token },
      context.commentId,
      text,
      deps.fetchImpl,
    );
    return { externalId: went.messageId, via, channel };
  } catch (err) {
    // Meta said no, so nothing went: the comment keeps its one private message.
    if (err instanceof MetaRefused) {
      await admin.rpc("release_private_reply", {
        p_tenant_id: where.tenantId,
        p_comment_id: context.commentId,
      });
    }
    throw err;
  }
}
