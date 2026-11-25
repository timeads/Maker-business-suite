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
  channelSettingsSchema,
  channelState,
  isSocialChannel,
  parseChannelSettings,
  scopesAllow,
  socialFilesProblem,
  textFits,
  TEXT_LIMITS,
} from "@/lib/helpdesk/social/channels";
import { socialPayloadSchema, socialSummary } from "@/lib/helpdesk/social/deliver";
import {
  MetaRefused,
  refusalText,
  refusalWords,
  subscribePage,
  unsubscribePage,
} from "@/lib/helpdesk/social/graph";
import { SocialNotSent, loadChannelFacts, sendSocialReply } from "@/lib/helpdesk/social/server";
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
    .select("id, number, merged_into, channel")
    .eq("id", ticketId)
    .eq("tenant_id", ctx.tenant.id)
    .maybeSingle();
  if (!ticket || !isSocialChannel(ticket.channel)) {
    return { error: "That conversation couldn't be found." };
  }
  if (ticket.merged_into) return { error: "This conversation was joined into another one." };
  const channel = ticket.channel;
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
    if (err instanceof MetaRefused) return { error: refusalWords(refusalText(err)) };
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
  const next = channelSettingsSchema.safeParse({
    ...now,
    instagram: has("instagram") ? formData.get("instagram") === "1" : now.instagram,
    facebook: has("facebook") ? formData.get("facebook") === "1" : now.facebook,
    human_agent: has("human_agent") ? formData.get("human_agent") === "1" : now.human_agent,
  });
  if (!next.success) return { error: "We couldn't save that. Try again in a moment." };
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
      const wanted = next.data.instagram || next.data.facebook;
      const able =
        facts.connection?.status === "active" &&
        (scopesAllow("facebook", scopes) || scopesAllow("instagram", scopes));
      if (able) {
        const stored = await getProviderToken(ctx.tenant.id, "meta");
        if (wanted) await subscribePage(stored.externalAccountId, stored.token.access_token);
        else await unsubscribePage(stored.externalAccountId, stored.token.access_token);
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
