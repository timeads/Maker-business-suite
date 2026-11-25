import type { SupabaseClient } from "@supabase/supabase-js";
import { getProviderToken, type TokenDeps } from "../../connections/tokens";
import { postAlert } from "../../messages/alerts";
import { withTenant } from "../../supabase/admin";
import { considerAutoReply, type AutoReplyDeps } from "../auto-reply/worker";
import { HELPDESK_MODULE, RULES_KEY, parseRules } from "../config";
import { fromBase64 } from "../files";
import { keepMessageFiles } from "../keep-files";
import { richToText } from "../rich";
import { CHANNELS_KEY, CHANNEL_LABELS, isSocialChannel, parseChannelSettings } from "./channels";
import { commentFilterOf, postExcerpt, postLink } from "./comments";
import { socialPayloadSchema } from "./deliver";
import { MetaRefused, readPost, readProfile, refusalText } from "./graph";
import {
  RetryLater,
  processMetaPayload,
  type CommentFiled,
  type FileResult,
  type IntakeDeps,
} from "./intake";
import { fetchMessageMedia } from "./media";
import { SocialNotSent, sendCommentReply, sendSocialReply, type SocialSendDeps } from "./server";

/**
 * The worker's side of Instagram and Facebook messages: filing what Meta
 * delivered, sending queued replies, and carrying out deletion requests.
 */

const check = (what: string, error: { message: string } | null) => {
  if (error) throw new Error(`${what}: ${error.message}`);
};

function intakeDeps(
  admin: SupabaseClient,
  tokenDeps: TokenDeps,
  autoReply?: AutoReplyDeps,
): IntakeDeps {
  const token = async (tenantId: string) =>
    (await getProviderToken(tenantId, "meta", tokenDeps)).token.access_token;
  return {
    now: Date.now,
    ourAppId: process.env.META_APP_ID || null,
    async whereFor(channel, accountId) {
      const { data, error } = await admin.rpc("resolve_meta_channel", {
        p_object: channel === "instagram" ? "instagram" : "page",
        p_account_id: accountId,
      });
      check("could not look up an account", error);
      const row = (data as { tenant_id: string; page_id: string }[] | null)?.[0];
      return row ? { tenantId: row.tenant_id, pageId: row.page_id, channel } : null;
    },
    rulesFor: (tenantId) =>
      withTenant(
        tenantId,
        async (scope) => {
          const { data: config } = await scope
            .select("configs", "body")
            .eq("module", HELPDESK_MODULE)
            .eq("key", RULES_KEY)
            .maybeSingle();
          return parseRules((config as { body?: unknown } | null)?.body);
        },
        admin,
      ),
    async file(where, event, subject, tags) {
      const { data, error } = await admin.rpc("file_social_message", {
        p_tenant_id: where.tenantId,
        p_channel: where.channel,
        p_external_id: event.personId,
        p_mid: event.mid,
        p_body: event.text,
        p_kind: event.kind,
        p_summary: event.summary,
        p_subject: subject,
        p_sent_at: event.at,
        p_tags: tags,
      });
      check("could not file a message", error);
      return data as FileResult;
    },
    async echo(where, event) {
      const { data, error } = await admin.rpc("file_social_echo", {
        p_tenant_id: where.tenantId,
        p_channel: where.channel,
        p_external_id: event.personId,
        p_mid: event.mid,
        p_body: event.text,
        p_summary: event.summary,
        p_sent_at: event.at,
      });
      check("could not file an echo", error);
      return data as FileResult;
    },
    async remove(where, mid) {
      const { error } = await admin.rpc("remove_social_message", {
        p_tenant_id: where.tenantId,
        p_mid: mid,
      });
      check("could not remove a message", error);
    },
    async react(where, event, id) {
      const { error } = await admin.rpc("set_social_reaction", {
        p_tenant_id: where.tenantId,
        p_reaction_id: id,
        p_target_mid: event.mid,
        // "unreact", or a reaction Meta sent no emoji for, leaves nothing behind.
        p_emoji: event.action === "react" ? event.emoji : null,
        p_sent_at: event.at,
      });
      check("could not note a reaction", error);
    },
    async noteControl(where, personId, state, appId, at) {
      const { error } = await admin.rpc("note_thread_control", {
        p_tenant_id: where.tenantId,
        p_channel: where.channel,
        p_external_id: personId,
        p_state: state,
        p_app_id: appId,
        p_at: at,
      });
      // A note for the team; never a reason to file the delivery again.
      if (error) console.error(`could not note who answers a conversation: ${error.message}`);
    },
    async refreshProfile(where, personId, contactId) {
      const profile = await readProfile(where.channel, await token(where.tenantId), personId);
      const { error } = await admin.rpc("set_social_profile", {
        p_tenant_id: where.tenantId,
        p_contact_id: contactId,
        p_name: profile.name,
        p_handle: profile.handle,
      });
      check("could not keep a profile", error);
      return profile.handle ? `@${profile.handle}` : profile.name;
    },
    async autoReply(where, event, result) {
      if (!autoReply || !result.message_id) return;
      try {
        const outcome = await considerAutoReply(
          { tenantId: where.tenantId, messageId: result.message_id, standby: event.standby },
          autoReply,
        );
        if (outcome !== "off") console.log(`automatic reply: ${outcome}`);
      } catch (err) {
        console.error("automatic reply not queued", err instanceof Error ? err.message : err);
      }
    },
    fetchFiles: (event) => fetchMessageMedia(event.media),
    async keepFiles(where, result, files) {
      if (!result.ticket_id || !result.message_id) return;
      await keepMessageFiles(
        admin,
        { tenantId: where.tenantId, ticketId: result.ticket_id, messageId: result.message_id },
        files,
      );
    },
    async commentsFor(channel, accountId) {
      const { data, error } = await admin.rpc("resolve_meta_comments", {
        p_object: channel === "instagram" ? "instagram" : "page",
        p_account_id: accountId,
      });
      check("could not look up an account", error);
      const row = (
        data as { tenant_id: string; page_id: string; own_handle: string | null }[] | null
      )?.[0];
      return row
        ? { tenantId: row.tenant_id, pageId: row.page_id, channel, ownHandle: row.own_handle }
        : null;
    },
    commentFilterFor: (tenantId) =>
      withTenant(
        tenantId,
        async (scope) => {
          const { data: config } = await scope
            .select("configs", "body")
            .eq("module", HELPDESK_MODULE)
            .eq("key", CHANNELS_KEY)
            .maybeSingle();
          return commentFilterOf(parseChannelSettings((config as { body?: unknown } | null)?.body));
        },
        admin,
      ),
    async fileComment(where, event, subject, tags, start) {
      const { data, error } = await admin.rpc("file_social_comment", {
        p_tenant_id: where.tenantId,
        p_channel: where.channel,
        p_external_id: event.personId,
        p_name: event.name,
        p_handle: event.handle,
        p_comment_id: event.commentId,
        p_parent_id: event.parentId,
        p_post_external_id: event.postId,
        p_body: event.text,
        p_summary: event.summary,
        p_subject: subject,
        p_sent_at: event.at,
        p_start: start,
        p_tags: tags,
      });
      check("could not file a comment", error);
      return data as CommentFiled;
    },
    async ownComment(where, event) {
      const { data, error } = await admin.rpc("file_own_comment", {
        p_tenant_id: where.tenantId,
        p_channel: where.channel,
        p_comment_id: event.commentId,
        p_parent_id: event.parentId,
        p_body: event.text,
        p_sent_at: event.at,
      });
      check("could not file a reply", error);
      return data as FileResult;
    },
    async editComment(where, event) {
      const { data, error } = await admin.rpc("edit_social_comment", {
        p_tenant_id: where.tenantId,
        p_comment_id: event.commentId,
        p_body: event.text,
        p_edited_at: new Date().toISOString(),
      });
      check("could not change a comment", error);
      return data === true;
    },
    async removeComment(where, commentId) {
      const { error } = await admin.rpc("remove_social_comment", {
        p_tenant_id: where.tenantId,
        p_comment_id: commentId,
      });
      check("could not remove a comment", error);
    },
    async hideComment(where, commentId, hidden) {
      const { error } = await admin.rpc("set_comment_hidden", {
        p_tenant_id: where.tenantId,
        p_comment_id: commentId,
        p_hidden: hidden,
      });
      check("could not note a hidden comment", error);
    },
    async refreshPost(where, event, postId) {
      let post: { permalink: string | null; caption: string };
      try {
        post = await readPost(where.channel, await token(where.tenantId), event.postId);
      } catch (err) {
        // Meta won't say (the post has gone, or it isn't ours to read): don't ask again.
        if (!(err instanceof MetaRefused)) throw err;
        post = { permalink: null, caption: "" };
      }
      const { error } = await admin.rpc("set_comment_post", {
        p_tenant_id: where.tenantId,
        p_post_id: postId,
        p_permalink: postLink(where.channel, post.permalink),
        p_excerpt: postExcerpt(post.caption),
      });
      check("could not keep a post", error);
    },
    fetchCommentFiles: (event) => fetchMessageMedia(event.media),
    async onCommentCreated(where, event, result, outcome) {
      if (!result.ticket_id) return;
      if (outcome.priority || outcome.assignTo) {
        const { error } = await admin.rpc("apply_ticket_rules", {
          p_tenant_id: where.tenantId,
          p_ticket_id: result.ticket_id,
          p_priority: outcome.priority,
          p_assignee_id: outcome.assignTo,
        });
        if (error) console.error(`could not apply rules: ${error.message}`);
      }
      const who = event.handle ? `@${event.handle}` : event.name;
      // Who it is from, never what they said.
      await postAlert(
        admin,
        where.tenantId,
        "helpdesk",
        `New ${CHANNEL_LABELS[where.channel]} comment, conversation #${result.number}${who ? ` from ${who}` : ""}${outcome.priority === "urgent" ? " (urgent)" : ""}`,
      );
    },
    async onCreated(where, _event, result, outcome, who) {
      if (!result.ticket_id) return;
      if (outcome.priority || outcome.assignTo) {
        const { error } = await admin.rpc("apply_ticket_rules", {
          p_tenant_id: where.tenantId,
          p_ticket_id: result.ticket_id,
          p_priority: outcome.priority,
          p_assignee_id: outcome.assignTo,
        });
        if (error) console.error(`could not apply rules: ${error.message}`);
      }
      // Who it is from, never what they said.
      await postAlert(
        admin,
        where.tenantId,
        "helpdesk",
        `New ${CHANNEL_LABELS[where.channel]} message, conversation #${result.number}${who ? ` from ${who}` : ""}${outcome.priority === "urgent" ? " (urgent)" : ""}`,
      );
    },
  };
}

/** Files queued deliveries from Meta into help desk conversations. */
export async function drainMetaEvents(
  admin: SupabaseClient,
  tokenDeps: TokenDeps,
  /** The automatic first reply's reads and its claim; left out, none is ever queued. */
  autoReply?: AutoReplyDeps,
): Promise<number> {
  const { data, error } = await admin.rpc("claim_meta_events", { p_limit: 5 });
  check("Could not claim Meta deliveries", error);
  const events = (data ?? []) as { id: string; payload: unknown; attempts: number }[];
  const deps = intakeDeps(admin, tokenDeps, autoReply);
  for (const event of events) {
    let failure: string | null = null;
    try {
      const outcomes = await processMetaPayload(event.payload, deps);
      console.log(
        `meta delivery ${event.id.slice(0, 12)}: ${outcomes.join(", ") || "nothing to file"}`,
      );
    } catch (err) {
      failure =
        err instanceof RetryLater ? "retry" : err instanceof Error ? err.message : String(err);
      if (!(err instanceof RetryLater)) {
        console.error(`meta delivery ${event.id.slice(0, 12)} failed (attempt ${event.attempts})`);
      }
    }
    const { error: doneError } = await admin.rpc("complete_meta_event", {
      p_id: event.id,
      p_error: failure,
    });
    if (doneError) console.error(`could not mark a Meta delivery: ${doneError.message}`);
  }
  return events.length;
}

/** Whether a row from the outbox is an Instagram or Facebook reply (rather than an email). */
export const isSocialPayload = (payload: unknown): boolean =>
  typeof payload === "object" &&
  payload !== null &&
  (payload as { kind?: unknown }).kind === "social";

/**
 * Sends one queued Instagram or Facebook reply and writes down how it went.
 * A refusal is "failed" with Meta's reason (nothing went; the words are kept
 * to put back). No clear answer is left claimed, which the database turns
 * into "we don't know if it went": never sent again by itself.
 */
export async function sendQueuedSocial(
  admin: SupabaseClient,
  row: { id: string; tenant_id: string; ticket_id: string; payload: unknown },
  tokenDeps: TokenDeps,
  /** For tests: a stand-in for Meta, the clock and the workspace's switches. */
  send: Pick<SocialSendDeps, "fetchImpl" | "now" | "facts"> = {},
): Promise<void> {
  const finish = (args: Record<string, unknown>) =>
    admin.rpc("finish_social_outbound", { p_id: row.id, ...args });
  const parsed = socialPayloadSchema.safeParse(row.payload);
  if (!parsed.success || !isSocialChannel(parsed.data.channel)) {
    await finish({ p_error: "unreadable" });
    return;
  }
  const payload = parsed.data;
  if (payload.via !== "message") {
    await sendQueuedComment(admin, row, payload, tokenDeps);
    return;
  }
  let went: Awaited<ReturnType<typeof sendSocialReply>>;
  try {
    went = await sendSocialReply({ tenantId: row.tenant_id, ticketId: row.ticket_id }, payload, {
      ...send,
      admin,
      tokenDeps,
    });
  } catch (err) {
    if (err instanceof SocialNotSent) await finish({ p_error: err.code });
    else if (err instanceof MetaRefused) {
      await finish({ p_error: refusalText(err) });
      console.error(`help desk message ${row.id} refused by Meta (${err.code ?? err.status})`);
    } else {
      // No clear answer: left claimed, to be marked "unsure". Never resent here.
      console.error(`help desk message ${row.id}: no clear answer from Meta`);
    }
    return;
  }
  const sentFiles = went.problem ? [] : payload.files;
  const { data: messageId, error } = await finish({
    p_mids: went.mids,
    p_body: richToText(payload.doc),
    p_attachments: sentFiles.map((file) => ({ name: file.name.slice(0, 120), size: file.size })),
    p_error: went.problem,
  });
  if (error) console.error(`help desk message ${row.id} went but wasn't filed`);
  if (messageId && sentFiles.length > 0) {
    try {
      await keepMessageFiles(
        admin,
        { tenantId: row.tenant_id, ticketId: row.ticket_id, messageId: String(messageId) },
        sentFiles.map((file) => ({
          name: file.name,
          claimed: file.type,
          bytes: fromBase64(file.base64),
          contentId: null,
        })),
      );
    } catch (err) {
      console.error("sent pictures weren't kept", err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Sends one queued answer to a comment (a public reply, or the one private
 * message) and writes down how it went, by the same rules as a message: a
 * refusal is "failed" with the reason and the words kept; no clear answer is
 * left claimed and never sent again by itself.
 */
async function sendQueuedComment(
  admin: SupabaseClient,
  row: { id: string; tenant_id: string; ticket_id: string },
  payload: ReturnType<typeof socialPayloadSchema.parse>,
  tokenDeps: TokenDeps,
): Promise<void> {
  const finish = (args: Record<string, unknown>) =>
    admin.rpc("finish_comment_outbound", { p_id: row.id, ...args });
  let went: Awaited<ReturnType<typeof sendCommentReply>>;
  try {
    went = await sendCommentReply({ tenantId: row.tenant_id, ticketId: row.ticket_id }, payload, {
      admin,
      tokenDeps,
    });
  } catch (err) {
    if (err instanceof SocialNotSent) await finish({ p_error: err.code });
    else if (err instanceof MetaRefused) {
      await finish({ p_error: refusalText(err) });
      console.error(`help desk reply ${row.id} refused by Meta (${err.code ?? err.status})`);
    } else {
      // No clear answer: left claimed, to be marked "unsure". Never resent here.
      console.error(`help desk reply ${row.id}: no clear answer from Meta`);
    }
    return;
  }
  const { error } = await finish({
    p_external_id: went.externalId,
    p_body: richToText(payload.doc).trim(),
  });
  if (error) console.error(`help desk reply ${row.id} went but wasn't filed`);
}

/** Carries out deletion requests that came through Meta's callback. */
export async function runMetaDeletions(admin: SupabaseClient): Promise<number> {
  const { data, error } = await admin.rpc("run_meta_deletions", { p_limit: 20 });
  check("Could not run deletion requests", error);
  return Number(data ?? 0);
}
