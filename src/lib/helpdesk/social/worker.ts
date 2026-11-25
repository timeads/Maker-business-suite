import type { SupabaseClient } from "@supabase/supabase-js";
import { getProviderToken, type TokenDeps } from "../../connections/tokens";
import { postAlert } from "../../messages/alerts";
import { withTenant } from "../../supabase/admin";
import { HELPDESK_MODULE, RULES_KEY, parseRules } from "../config";
import { fromBase64 } from "../files";
import { keepMessageFiles } from "../keep-files";
import { richToText } from "../rich";
import { CHANNEL_LABELS, isSocialChannel } from "./channels";
import { socialPayloadSchema } from "./deliver";
import { MetaRefused, readProfile, refusalText } from "./graph";
import { RetryLater, processMetaPayload, type FileResult, type IntakeDeps } from "./intake";
import { fetchMessageMedia } from "./media";
import { SocialNotSent, sendSocialReply } from "./server";

/**
 * The worker's side of Instagram and Facebook messages: filing what Meta
 * delivered, sending queued replies, and carrying out deletion requests.
 */

const check = (what: string, error: { message: string } | null) => {
  if (error) throw new Error(`${what}: ${error.message}`);
};

function intakeDeps(admin: SupabaseClient, tokenDeps: TokenDeps): IntakeDeps {
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
    fetchFiles: (event) => fetchMessageMedia(event.media),
    async keepFiles(where, result, files) {
      if (!result.ticket_id || !result.message_id) return;
      await keepMessageFiles(
        admin,
        { tenantId: where.tenantId, ticketId: result.ticket_id, messageId: result.message_id },
        files,
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
): Promise<number> {
  const { data, error } = await admin.rpc("claim_meta_events", { p_limit: 5 });
  check("Could not claim Meta deliveries", error);
  const events = (data ?? []) as { id: string; payload: unknown; attempts: number }[];
  const deps = intakeDeps(admin, tokenDeps);
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
): Promise<void> {
  const finish = (args: Record<string, unknown>) =>
    admin.rpc("finish_social_outbound", { p_id: row.id, ...args });
  const parsed = socialPayloadSchema.safeParse(row.payload);
  if (!parsed.success || !isSocialChannel(parsed.data.channel)) {
    await finish({ p_error: "unreadable" });
    return;
  }
  const payload = parsed.data;
  let went: Awaited<ReturnType<typeof sendSocialReply>>;
  try {
    went = await sendSocialReply({ tenantId: row.tenant_id, ticketId: row.ticket_id }, payload, {
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

/** Carries out deletion requests that came through Meta's callback. */
export async function runMetaDeletions(admin: SupabaseClient): Promise<number> {
  const { data, error } = await admin.rpc("run_meta_deletions", { p_limit: 20 });
  check("Could not run deletion requests", error);
  return Number(data ?? 0);
}
