import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getProviderToken, type TokenDeps } from "../../connections/tokens";
import { withTenant } from "../../supabase/admin";
import { HELPDESK_MODULE } from "../config";
import { FILES_BUCKET, fromBase64, sniffType } from "../files";
import { richToText } from "../rich";
import {
  CHANNELS_KEY,
  MAX_SOCIAL_IMAGE_BYTES,
  SOCIAL_IMAGE_TYPES,
  channelState,
  isSocialChannel,
  parseChannelSettings,
  textFits,
  type ChannelSettings,
  type MetaConnectionFacts,
  type SocialChannel,
} from "./channels";
import { deliverSocial, type Delivered, type SocialPayload } from "./deliver";
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
    public code: "no_conversation" | "not_connected" | "window_closed" | "too_long" | "files",
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
  const facts = await loadChannelFacts(admin, where.tenantId);
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
  const went = await deliverSocial(
    {
      pageId: stored.externalAccountId,
      token: stored.token.access_token,
      recipientId: context.external_id,
      humanAgent: window.needsHumanAgentTag,
    },
    channel,
    text,
    files,
    {
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
    },
  );
  return { ...went, channel };
}
