"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getProviderToken } from "@/lib/connections/tokens";
import { getEntitlements } from "@/lib/entitlements";
import { HELPDESK_MODULE, templateActionsSchema } from "@/lib/helpdesk/config";
import { fromBase64, type IncomingFile } from "@/lib/helpdesk/files";
import { keepMessageFiles } from "@/lib/helpdesk/keep-files";
import { parseRichDoc, richToText, textToRich } from "@/lib/helpdesk/rich";
import { DESK_SETTINGS_KEY, parseDeskSettings } from "@/lib/helpdesk/settings";
import {
  CHANNELS_KEY,
  CHANNEL_LABELS,
  COMMENT_FILTERS,
  COMMENT_LIMITS,
  channelSettingsSchema,
  channelState,
  commentAbilities,
  commentScopesAllow,
  commentState,
  isSocialChannel,
  parseChannelSettings,
  scopesAllow,
  socialFilesProblem,
  textFits,
  TEXT_LIMITS,
  type SocialChannel,
} from "@/lib/helpdesk/social/channels";
import { privateReplyState, privateReplyWords } from "@/lib/helpdesk/social/comments";
import { socialPayloadSchema, socialSummary } from "@/lib/helpdesk/social/deliver";
import {
  MetaRefused,
  deleteComment,
  refusalText,
  refusalWithDetails,
  refusalWords,
  setCommentHidden,
  subscribePage,
  subscribedFieldsFor,
  unsubscribePage,
} from "@/lib/helpdesk/social/graph";
import {
  SocialNotSent,
  loadChannelFacts,
  loadCommentContext,
  sendCommentReply,
  sendSocialReply,
} from "@/lib/helpdesk/social/server";
import { replyWindow, windowWords } from "@/lib/helpdesk/social/window";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import type { HelpdeskState, SendState } from "./actions";

const NO_ACCESS = "The help desk isn't part of this workspace's plan right now.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/helpdesk`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.helpdesk")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  return { user, tenant: ctx.tenant, role: ctx.role, supabase: await createClient() } as const;
}

const THENS = ["pending", "open", "closed", "snoozed", "keep"] as const;

/**
 * A reply on Instagram or Facebook, from the same reply box as an email. It
 * takes the same road out: with an undo wait it is queued and the worker
 * sends it; without one it is sent here. Either way the server re-reads who
 * the person is and whether Meta's reply window is open, and only plain
 * words (and JPEG or PNG pictures) go.
 */
export async function sendSocialMessage(
  slug: string,
  ticketId: string,
  formData: FormData,
): Promise<SendState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!ID.test(ticketId)) return { error: "That conversation couldn't be found." };
  // Confirm the conversation is one this member can see before using elevated access.
  const { data: ticket } = await ctx.supabase
    .from("tickets")
    .select("id, number, merged_into, channel, kind")
    .eq("id", ticketId)
    .eq("tenant_id", ctx.tenant.id)
    .maybeSingle();
  if (!ticket || !isSocialChannel(ticket.channel)) {
    return { error: "That conversation couldn't be found." };
  }
  if (ticket.merged_into) return { error: "This conversation was joined into another one." };
  const channel = ticket.channel;
  // A conversation about a comment is answered under the comment or privately about it.
  if (ticket.kind === "comment") {
    return sendCommentAnswer(
      ctx,
      { id: ticketId, number: ticket.number as number },
      channel,
      formData,
    );
  }
  const name = CHANNEL_LABELS[channel];

  // Whatever the editor held, only its plain words go.
  let text = "";
  try {
    const doc = parseRichDoc(JSON.parse(String(formData.get("doc") ?? "[]")));
    text = doc ? richToText(doc).trim() : "";
  } catch {
    return { error: "That message couldn't be read. Try typing it again." };
  }
  const picked = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const filesWrong = socialFilesProblem(
    picked.map((file) => ({ name: file.name, size: file.size, type: file.type })),
  );
  if (filesWrong) return { error: filesWrong };
  if (!text && picked.length === 0) return { error: "Write a reply first." };
  if (!textFits(channel, text)) {
    const limit = TEXT_LIMITS[channel];
    return {
      error: `That is longer than one ${name} message can hold (${limit.max.toLocaleString("en-US")} ${limit.unit}). Send it as two.`,
    };
  }
  const asked = String(formData.get("then") ?? "");
  const then = THENS.find((one) => one === asked) ?? "pending";
  const snooze = String(formData.get("snooze_until") ?? "");
  if (then === "snoozed" && !(Date.parse(snooze) > Date.now())) {
    return { error: "Pick when it should come back." };
  }
  if (!process.env.META_APP_SECRET || !process.env.SUPABASE_SECRET_KEY) {
    return { error: `${name} messages aren't switched on for this environment yet.` };
  }

  const admin = getAdminClient();
  // Say why before anything is queued: the channel, the connection, Meta's reply window.
  const facts = await loadChannelFacts(admin, ctx.tenant.id);
  const state = channelState(channel, facts.settings, facts.connection);
  if (state.state !== "on") {
    return {
      error: `${state.why ?? `${name} messages are switched off.`} See Settings → Help desk → Channels.`,
    };
  }
  const { data: contextRows } = await admin.rpc("social_reply_context", {
    p_tenant_id: ctx.tenant.id,
    p_ticket_id: ticketId,
  });
  const info = (contextRows as Record<string, string | null>[] | null)?.[0];
  const window = replyWindow(info?.last_inbound_at ?? null, Date.now(), {
    humanAgent: facts.settings.human_agent,
  });
  if (!window.open) {
    const when = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZone: ctx.tenant.timezone,
    });
    return { error: windowWords(channel, window, (at) => when.format(new Date(at))) };
  }

  let extras: { tags: string[]; assignTo: string | null } = { tags: [], assignTo: null };
  try {
    const parsed = templateActionsSchema.safeParse(
      JSON.parse(String(formData.get("macro_actions") ?? "{}")),
    );
    if (parsed.success) {
      extras = {
        tags: parsed.data.add_tags ?? [],
        assignTo:
          parsed.data.assign_to === "sender" ? ctx.user.id : (parsed.data.assign_to ?? null),
      };
    }
  } catch {
    // No extras.
  }
  const payload = socialPayloadSchema.safeParse({
    kind: "social",
    channel,
    doc: textToRich(text),
    then,
    snooze_until: then === "snoozed" ? new Date(snooze).toISOString() : null,
    files: await Promise.all(
      picked.map(async (file) => ({
        name: file.name,
        type: file.type,
        size: file.size,
        base64: Buffer.from(await file.arrayBuffer()).toString("base64"),
      })),
    ),
    add_tags: extras.tags,
    assign_to: extras.assignTo,
  });
  if (!payload.success) return { error: "That message couldn't be read. Try typing it again." };

  const { data: deskConfig } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", HELPDESK_MODULE)
    .eq("key", DESK_SETTINGS_KEY)
    .maybeSingle();
  const undoSeconds = parseDeskSettings(deskConfig?.body).undo_seconds;
  const done = () => {
    revalidatePath(`/w/${ctx.tenant.slug}/helpdesk`, "layout");
  };

  if (undoSeconds > 0) {
    const { data: queuedId, error: queueError } = await ctx.supabase.rpc("queue_outbound", {
      p_ticket_id: ticketId,
      p_payload: payload.data,
      p_summary: socialSummary(payload.data, info?.label ?? "the customer"),
      p_delay_seconds: undoSeconds,
    });
    if (queueError || !queuedId) {
      return {
        error: queueError?.message.includes("already waiting")
          ? "A few messages are already waiting to go on this conversation. Give them a moment."
          : "We couldn't send that. Nothing was sent; try again in a moment.",
      };
    }
    await ctx.supabase.rpc("mark_ticket_read", { p_ticket_id: ticketId });
    done();
    return {
      sent: true,
      number: ticket.number as number,
      queued: { id: String(queuedId), seconds: undoSeconds },
    };
  }

  let went: Awaited<ReturnType<typeof sendSocialReply>>;
  try {
    went = await sendSocialReply({ tenantId: ctx.tenant.id, ticketId }, payload.data, { admin });
  } catch (err) {
    if (err instanceof SocialNotSent) return { error: refusalWords(err.code) };
    if (err instanceof MetaRefused) return { error: refusalWithDetails(refusalText(err)) };
    console.error("A message got no clear answer from Meta");
    return {
      error: `We never heard back from ${name}, so we can't say whether that went. Look at the conversation in the ${name} app before sending it again.`,
    };
  }
  const sentFiles = went.problem ? [] : payload.data.files;
  const { data: messageId, error: recordError } = await ctx.supabase.rpc("record_social_outbound", {
    p_ticket_id: ticketId,
    p_body: text,
    p_mids: went.mids,
    p_attachments: sentFiles.map((file) => ({ name: file.name.slice(0, 120), size: file.size })),
    p_then: then,
    p_snooze_until: payload.data.snooze_until,
  });
  if (recordError) {
    console.error("A sent message wasn't filed", recordError.message);
    return {
      error: "That was sent, but couldn't be filed in this conversation. Don't send it again.",
    };
  }
  if (extras.tags.length > 0 || extras.assignTo) {
    await ctx.supabase.rpc("apply_send_actions", {
      p_ticket_id: ticketId,
      p_add_tags: extras.tags,
      p_assign_to: extras.assignTo,
    });
  }
  if (messageId && sentFiles.length > 0) {
    try {
      await keepMessageFiles(
        admin,
        { tenantId: ctx.tenant.id, ticketId, messageId: String(messageId) },
        sentFiles.map((file): IncomingFile => ({
          name: file.name,
          claimed: file.type,
          bytes: fromBase64(file.base64),
          contentId: null,
        })),
      );
    } catch (err) {
      console.error("Sent pictures weren't kept", err instanceof Error ? err.message : err);
    }
  }
  await ctx.supabase.rpc("mark_ticket_read", { p_ticket_id: ticketId });
  done();
  return went.problem
    ? { sent: true, number: ticket.number as number, message: refusalWords(went.problem) }
    : { sent: true, number: ticket.number as number };
}

type Ctx = Exclude<Awaited<ReturnType<typeof context>>, { error: string }>;

/**
 * An answer to a comment, from the same reply box: a public reply under it
 * (everyone can read it) or the one private message Meta allows about it.
 * It takes the same road out as a message: queued with the undo wait and sent
 * by the worker, or sent here when there is none. The server re-reads the
 * comment, the permissions and the one-private-message rule each time.
 */
async function sendCommentAnswer(
  ctx: Ctx,
  ticket: { id: string; number: number },
  channel: SocialChannel,
  formData: FormData,
): Promise<SendState> {
  const name = CHANNEL_LABELS[channel];
  const via =
    formData.get("via") === "private"
      ? "private"
      : formData.get("via") === "public"
        ? "public"
        : null;
  if (!via) return { error: "Choose whether to reply publicly or message privately." };
  let text = "";
  try {
    const doc = parseRichDoc(JSON.parse(String(formData.get("doc") ?? "[]")));
    text = doc ? richToText(doc).trim() : "";
  } catch {
    return { error: "That reply couldn't be read. Try typing it again." };
  }
  if (!text) return { error: "Write a reply first." };
  if (via === "public" && [...text].length > COMMENT_LIMITS[channel].max) {
    return {
      error: `That is longer than one ${name} reply can hold (${COMMENT_LIMITS[channel].max.toLocaleString("en-US")} characters).`,
    };
  }
  if (via === "private" && !textFits(channel, text)) {
    const limit = TEXT_LIMITS[channel];
    return {
      error: `That is longer than one ${name} message can hold (${limit.max.toLocaleString("en-US")} ${limit.unit}).`,
    };
  }
  const asked = String(formData.get("then") ?? "");
  const then = THENS.find((one) => one === asked) ?? "pending";
  const snooze = String(formData.get("snooze_until") ?? "");
  if (then === "snoozed" && !(Date.parse(snooze) > Date.now())) {
    return { error: "Pick when it should come back." };
  }
  if (!process.env.META_APP_SECRET || !process.env.SUPABASE_SECRET_KEY) {
    return { error: `${name} comments aren't switched on for this environment yet.` };
  }

  const admin = getAdminClient();
  // Say why before anything is queued: the switch, the connection, the comment, Meta's rules.
  const facts = await loadChannelFacts(admin, ctx.tenant.id);
  const state = commentState(channel, facts.settings, facts.connection);
  if (state.state !== "on") {
    return {
      error: `${state.why ?? `${name} comments are switched off.`} See Settings → Help desk → Channels.`,
    };
  }
  const comment = await loadCommentContext(admin, { tenantId: ctx.tenant.id, ticketId: ticket.id });
  if (!comment?.commentId) return { error: refusalWords("no_comment") };
  // The reply box showed one comment; if they have written again since, look first.
  if (String(formData.get("comment_id") ?? "") !== comment.commentId) {
    return { error: refusalWords("comment_changed") };
  }
  const can = commentAbilities(channel, facts.connection?.scopes ?? null);
  if (via === "public") {
    if (!can.reply) return { error: refusalWords("not_allowed") };
    if (channel === "instagram" && comment.commentHidden) {
      return { error: refusalWords("comment_hidden") };
    }
  } else {
    const allowed = privateReplyState(
      { at: comment.commentAt, privateReply: comment.privateReply },
      Date.now(),
      can.privately,
    );
    if (allowed.state !== "available") {
      const when = new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone: ctx.tenant.timezone,
      });
      return {
        error: privateReplyWords(channel, allowed.state, allowed.until, (at) =>
          when.format(new Date(at)),
        ),
      };
    }
  }

  let extras: { tags: string[]; assignTo: string | null } = { tags: [], assignTo: null };
  try {
    const parsed = templateActionsSchema.safeParse(
      JSON.parse(String(formData.get("macro_actions") ?? "{}")),
    );
    if (parsed.success) {
      extras = {
        tags: parsed.data.add_tags ?? [],
        assignTo:
          parsed.data.assign_to === "sender" ? ctx.user.id : (parsed.data.assign_to ?? null),
      };
    }
  } catch {
    // No extras.
  }
  const payload = socialPayloadSchema.safeParse({
    kind: "social",
    channel,
    doc: textToRich(text),
    then,
    snooze_until: then === "snoozed" ? new Date(snooze).toISOString() : null,
    files: [],
    add_tags: extras.tags,
    assign_to: extras.assignTo,
    via,
    comment_id: comment.commentId,
  });
  if (!payload.success) return { error: "That reply couldn't be read. Try typing it again." };

  const { data: deskConfig } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", HELPDESK_MODULE)
    .eq("key", DESK_SETTINGS_KEY)
    .maybeSingle();
  const undoSeconds = parseDeskSettings(deskConfig?.body).undo_seconds;
  const done = () => revalidatePath(`/w/${ctx.tenant.slug}/helpdesk`, "layout");

  if (undoSeconds > 0) {
    const { data: queuedId, error: queueError } = await ctx.supabase.rpc("queue_outbound", {
      p_ticket_id: ticket.id,
      p_payload: payload.data,
      p_summary: socialSummary(payload.data, comment.label ?? "the customer"),
      p_delay_seconds: undoSeconds,
    });
    if (queueError || !queuedId) {
      return {
        error: queueError?.message.includes("already waiting")
          ? "A few replies are already waiting to go on this conversation. Give them a moment."
          : "We couldn't send that. Nothing was sent; try again in a moment.",
      };
    }
    await ctx.supabase.rpc("mark_ticket_read", { p_ticket_id: ticket.id });
    done();
    return {
      sent: true,
      number: ticket.number,
      queued: { id: String(queuedId), seconds: undoSeconds },
    };
  }

  let went: Awaited<ReturnType<typeof sendCommentReply>>;
  try {
    went = await sendCommentReply({ tenantId: ctx.tenant.id, ticketId: ticket.id }, payload.data, {
      admin,
    });
  } catch (err) {
    if (err instanceof SocialNotSent) return { error: refusalWords(err.code) };
    if (err instanceof MetaRefused) return { error: refusalWords(refusalText(err)) };
    console.error("A reply to a comment got no clear answer from Meta");
    return {
      error: `We never heard back from ${name}, so we can't say whether that went. Look at the ${via === "public" ? "post" : "conversation"} in the ${name} app before sending it again.`,
    };
  }
  const { error: recordError } = await ctx.supabase.rpc("record_comment_outbound", {
    p_ticket_id: ticket.id,
    p_body: text,
    p_external_id: went.externalId,
    p_via: via,
    p_comment_id: comment.commentId,
    p_then: then,
    p_snooze_until: payload.data.snooze_until,
  });
  if (recordError) {
    console.error("A sent reply wasn't filed", recordError.message);
    return {
      error: "That was sent, but couldn't be filed in this conversation. Don't send it again.",
    };
  }
  if (extras.tags.length > 0 || extras.assignTo) {
    await ctx.supabase.rpc("apply_send_actions", {
      p_ticket_id: ticket.id,
      p_add_tags: extras.tags,
      p_assign_to: extras.assignTo,
    });
  }
  await ctx.supabase.rpc("mark_ticket_read", { p_ticket_id: ticket.id });
  done();
  return { sent: true, number: ticket.number };
}

/** A comment on one of the member's own conversations, with what is needed to act on it at Meta. */
async function ownComment(ctx: Ctx, messageId: string) {
  if (!ID.test(messageId)) return null;
  // Read as the member: row-level security decides whether they may see it at all.
  const { data: message } = await ctx.supabase
    .from("messages")
    .select(
      "id, ticket_id, provider_message_id, kind, direction, removed_at, tickets(channel, kind)",
    )
    .eq("id", messageId)
    .eq("tenant_id", ctx.tenant.id)
    .maybeSingle();
  const ticket = Array.isArray(message?.tickets) ? message?.tickets[0] : message?.tickets;
  if (
    !message ||
    message.kind !== "comment" ||
    message.removed_at ||
    !message.provider_message_id ||
    !ticket ||
    ticket.kind !== "comment" ||
    !isSocialChannel(ticket.channel)
  ) {
    return null;
  }
  return {
    channel: ticket.channel as SocialChannel,
    commentId: String(message.provider_message_id),
    inbound: message.direction === "inbound",
  };
}

/** Meta's token and whether this workspace may moderate comments on a channel, or the reason it can't. */
async function moderation(ctx: Ctx, channel: SocialChannel) {
  if (!process.env.META_APP_SECRET || !process.env.SUPABASE_SECRET_KEY) {
    return {
      error: `${CHANNEL_LABELS[channel]} comments aren't switched on for this environment yet.`,
    };
  }
  const facts = await loadChannelFacts(getAdminClient(), ctx.tenant.id);
  const state = commentState(channel, facts.settings, facts.connection);
  if (state.state !== "on") {
    return {
      error: `${state.why ?? `${CHANNEL_LABELS[channel]} comments are switched off.`} See Settings → Help desk → Channels.`,
    };
  }
  if (!commentAbilities(channel, facts.connection?.scopes ?? null).moderate) {
    return { error: refusalWords("not_allowed") };
  }
  const stored = await getProviderToken(ctx.tenant.id, "meta");
  return { token: stored.token.access_token };
}

const metaTrouble = (err: unknown, name: string): string =>
  err instanceof MetaRefused
    ? refusalWords(refusalText(err))
    : `We never heard back from ${name}, so we can't say whether that was done. Have a look at the post before trying again.`;

/**
 * Hides a customer's comment from everyone else on the platform, or shows it
 * again. Meta is asked first; only when it says yes is the comment marked here.
 */
export async function hideComment(
  slug: string,
  messageId: string,
  hidden: boolean,
): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const comment = await ownComment(ctx, messageId);
  if (!comment || !comment.inbound) return { error: "That comment couldn't be found." };
  const access = await moderation(ctx, comment.channel);
  if ("error" in access) return { error: access.error };
  try {
    await setCommentHidden(comment.channel, access.token, comment.commentId, hidden);
  } catch (err) {
    return { error: metaTrouble(err, CHANNEL_LABELS[comment.channel]) };
  }
  const { error } = await ctx.supabase.rpc("mark_comment_hidden", {
    p_message_id: messageId,
    p_hidden: hidden,
  });
  revalidatePath(`/w/${slug}/helpdesk`, "layout");
  if (error) {
    return {
      error: `That was ${hidden ? "hidden" : "shown again"} on ${CHANNEL_LABELS[comment.channel]}, but couldn't be noted here.`,
    };
  }
  return { message: hidden ? "Hidden." : "Shown again." };
}

/**
 * Deletes a comment on the platform, for good. Owners and admins only (the
 * database checks again). Meta is asked first; only when it says yes are the
 * comment's words cleared here.
 */
export async function removeComment(slug: string, messageId: string): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!canManage(ctx.role)) return { error: "Only owners and admins can delete a comment." };
  const comment = await ownComment(ctx, messageId);
  if (!comment) return { error: "That comment couldn't be found." };
  const access = await moderation(ctx, comment.channel);
  if ("error" in access) return { error: access.error };
  try {
    await deleteComment(access.token, comment.commentId);
  } catch (err) {
    return { error: metaTrouble(err, CHANNEL_LABELS[comment.channel]) };
  }
  const { error } = await ctx.supabase.rpc("mark_comment_deleted", { p_message_id: messageId });
  revalidatePath(`/w/${slug}/helpdesk`, "layout");
  if (error) {
    return {
      error: `That was deleted on ${CHANNEL_LABELS[comment.channel]}, but couldn't be noted here.`,
    };
  }
  return { message: "Deleted." };
}

/**
 * Settings → Help desk → Channels: switches a channel on or off. Switching on
 * needs the messaging permissions on the Meta connection; when they are there
 * the Page is asked to send its messages our way. With both off, it is asked
 * to stop. Owners and admins only.
 */
export async function saveChannelSwitches(
  slug: string,
  _prev: HelpdeskState,
  formData: FormData,
): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!canManage(ctx.role)) {
    return { error: "Only owners and admins can change help desk settings." };
  }
  const { data } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", HELPDESK_MODULE)
    .eq("key", CHANNELS_KEY)
    .maybeSingle();
  const now = parseChannelSettings(data?.body);
  const has = (key: string) => formData.get(`${key}_set`) !== null;
  const ticked = (key: "instagram_comments" | "facebook_comments") =>
    has(key) ? formData.get(key) === "1" : now[key];
  const filter = COMMENT_FILTERS.find((one) => one === formData.get("comment_filter"));
  // The workspace's own words, one to a line or separated by commas.
  const words = has("comment_words")
    ? [
        ...new Set(
          String(formData.get("comment_words") ?? "")
            .split(/[\n,]/)
            .map((word) => word.trim().toLowerCase())
            .filter(Boolean),
        ),
      ]
    : now.comment_words;
  const next = channelSettingsSchema.safeParse({
    ...now,
    instagram: has("instagram") ? formData.get("instagram") === "1" : now.instagram,
    facebook: has("facebook") ? formData.get("facebook") === "1" : now.facebook,
    human_agent: has("human_agent") ? formData.get("human_agent") === "1" : now.human_agent,
    take_control: has("take_control") ? formData.get("take_control") === "1" : now.take_control,
    instagram_comments: ticked("instagram_comments"),
    facebook_comments: ticked("facebook_comments"),
    comment_filter: filter ?? now.comment_filter,
    comment_words: words,
  });
  if (!next.success) {
    return {
      error: has("comment_words")
        ? "Your own words: up to 30, each 2 to 40 characters long."
        : "We couldn't save that. Try again in a moment.",
    };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: HELPDESK_MODULE,
    p_key: CHANNELS_KEY,
    p_body: next.data,
  });
  if (error) return { error: "We couldn't save that. Try again in a moment." };
  revalidatePath(`/w/${slug}/helpdesk`, "layout");
  revalidatePath(`/w/${slug}/settings`, "layout");

  // Keep Meta in step. Trouble here never undoes the switch: the page shows where things stand.
  let note = "";
  if (process.env.META_APP_SECRET && process.env.SUPABASE_SECRET_KEY) {
    try {
      const facts = await loadChannelFacts(getAdminClient(), ctx.tenant.id);
      const scopes = facts.connection?.scopes ?? [];
      // What the Page should send: messages and comments each only where they are
      // both switched on and granted. With nothing left, it is asked to stop.
      const fields = subscribedFieldsFor({
        messages:
          (next.data.facebook && scopesAllow("facebook", scopes)) ||
          (next.data.instagram && scopesAllow("instagram", scopes)),
        comments:
          (next.data.facebook_comments && commentScopesAllow("facebook", scopes)) ||
          (next.data.instagram_comments && commentScopesAllow("instagram", scopes)),
      });
      const able =
        facts.connection?.status === "active" && scopes.includes("pages_manage_metadata");
      if (able) {
        const stored = await getProviderToken(ctx.tenant.id, "meta");
        if (fields.length > 0) {
          await subscribePage(stored.externalAccountId, stored.token.access_token, fetch, fields);
        } else await unsubscribePage(stored.externalAccountId, stored.token.access_token);
      }
    } catch (err) {
      console.error(
        "Could not update the Page's webhook subscription",
        err instanceof MetaRefused ? `(${err.code ?? err.status})` : "",
      );
      note = " Meta didn't confirm the change just now; press Save again in a minute.";
    }
  }
  return { message: `Saved.${note}` };
}

/** Writes down an email for someone who messaged, so their orders can be found beside the conversation. */
export async function setKnownEmail(
  slug: string,
  contactId: string,
  _prev: HelpdeskState,
  formData: FormData,
): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!ID.test(contactId)) return { error: "That person couldn't be found." };
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const { error } = await ctx.supabase.rpc("set_contact_known_email", {
    p_contact_id: contactId,
    p_email: email,
  });
  if (error) {
    return {
      error: error.message.includes("isn't an email")
        ? "That isn't an email address."
        : "We couldn't save that. Try again in a moment.",
    };
  }
  revalidatePath(`/w/${slug}/helpdesk`, "layout");
  return { message: email ? "Saved." : "Removed." };
}

/** Forgets someone who messaged: the person, their conversations, messages and files. Owners and admins only. */
export async function forgetSocialPerson(slug: string, contactId: string): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!canManage(ctx.role)) return { error: "Only owners and admins can forget a customer." };
  if (!ID.test(contactId)) return { error: "That person couldn't be found." };
  const { error } = await ctx.supabase.rpc("forget_social_person", { p_contact_id: contactId });
  if (error) return { error: "We couldn't do that. Try again in a moment." };
  revalidatePath(`/w/${slug}/helpdesk`, "layout");
  return { message: "Forgotten." };
}
