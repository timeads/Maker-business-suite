"use server";

import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import type { ChatMessage, Person } from "@/lib/messages/format";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";

export type Conversation = {
  channel_id: string;
  kind: "channel" | "dm";
  name: string | null;
  topic: string;
  other_user_id: string | null;
  unread: number;
  last_message_id: number | null;
};

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const PAGE = 50;
const COLUMNS = "id, channel_id, author_id, app, body, created_at, edited_at, deleted_at";
const NO_ACCESS = "Messages aren't part of this workspace's plan right now.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't go through. Please try again.";

async function context(slug: string, write: boolean) {
  const user = await requireUser(`/w/${slug}/messages`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.messages")) return { error: NO_ACCESS } as const;
  if (write && !entitlements.canWrite) return { error: READ_ONLY } as const;
  return { user, tenant: ctx.tenant, supabase: await createClient() } as const;
}

const fail = (error: string) => ({ ok: false as const, error });

type Supabase = Awaited<ReturnType<typeof createClient>>;

async function overview(supabase: Supabase, tenantId: string): Promise<Conversation[]> {
  const { data, error } = await supabase.rpc("chat_overview", { p_tenant_id: tenantId });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Conversation[]).map((row) => ({
    ...row,
    unread: Number(row.unread),
    last_message_id: row.last_message_id === null ? null : Number(row.last_message_id),
  }));
}

/** Conversations with unread counts, and everyone in the workspace. */
export async function loadChat(
  slug: string,
): Promise<Result<{ conversations: Conversation[]; people: Person[] }>> {
  const ctx = await context(slug, false);
  if ("error" in ctx) return fail(ctx.error ?? NO_ACCESS);
  try {
    const [conversations, { data: people }] = await Promise.all([
      overview(ctx.supabase, ctx.tenant.id),
      ctx.supabase.rpc("chat_people", { p_tenant_id: ctx.tenant.id }),
    ]);
    return { ok: true, conversations, people: (people ?? []) as Person[] };
  } catch {
    return fail("Messages couldn't be loaded. Please try again.");
  }
}

/**
 * One page of a conversation, oldest first. `before` loads earlier history;
 * `after` loads only what arrived since.
 */
export async function loadMessages(
  slug: string,
  channelId: string,
  cursor: { before?: number; after?: number } = {},
): Promise<Result<{ messages: ChatMessage[]; more: boolean }>> {
  const ctx = await context(slug, false);
  if ("error" in ctx) return fail(ctx.error ?? NO_ACCESS);
  let query = ctx.supabase
    .from("chat_messages")
    .select(COLUMNS)
    .eq("tenant_id", ctx.tenant.id)
    .eq("channel_id", channelId);
  if (cursor.after !== undefined) {
    query = query.gt("id", cursor.after).order("id", { ascending: true }).limit(200);
  } else {
    if (cursor.before !== undefined) query = query.lt("id", cursor.before);
    query = query.order("id", { ascending: false }).limit(PAGE + 1);
  }
  const { data, error } = await query;
  if (error) return fail("Messages couldn't be loaded. Please try again.");
  const rows = ((data ?? []) as ChatMessage[]).map((m) => ({ ...m, id: Number(m.id) }));
  if (cursor.after !== undefined) return { ok: true, messages: rows, more: false };
  const more = rows.length > PAGE;
  return { ok: true, messages: rows.slice(0, PAGE).reverse(), more };
}

/** Messages edited or deleted recently, so open windows can catch up. */
export async function loadChanges(
  slug: string,
  channelId: string,
  sinceIso: string,
): Promise<Result<{ messages: ChatMessage[] }>> {
  const ctx = await context(slug, false);
  if ("error" in ctx) return fail(ctx.error ?? NO_ACCESS);
  const { data, error } = await ctx.supabase
    .from("chat_messages")
    .select(COLUMNS)
    .eq("tenant_id", ctx.tenant.id)
    .eq("channel_id", channelId)
    .or(`edited_at.gt.${sinceIso},deleted_at.gt.${sinceIso}`)
    .limit(100);
  if (error) return fail(OOPS);
  return {
    ok: true,
    messages: ((data ?? []) as ChatMessage[]).map((m) => ({ ...m, id: Number(m.id) })),
  };
}

export async function sendMessage(
  slug: string,
  channelId: string,
  body: string,
): Promise<Result<{ message: ChatMessage }>> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return fail(ctx.error ?? NO_ACCESS);
  const text = body.trim();
  if (!text) return fail("Write a message first.");
  if (text.length > 4000) return fail("That's too long for one message. Try splitting it up.");
  const { data: id, error } = await ctx.supabase.rpc("post_chat_message", {
    p_channel_id: channelId,
    p_body: text,
  });
  if (error) return fail(OOPS);
  const { data } = await ctx.supabase
    .from("chat_messages")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (!data) return fail(OOPS);
  return { ok: true, message: { ...(data as ChatMessage), id: Number(data.id) } };
}

export async function editMessage(slug: string, id: number, body: string): Promise<Result<object>> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return fail(ctx.error ?? NO_ACCESS);
  const text = body.trim();
  if (!text) return fail("A message needs some words in it.");
  if (text.length > 4000) return fail("That's too long for one message.");
  const { error } = await ctx.supabase.rpc("edit_chat_message", { p_message_id: id, p_body: text });
  return error ? fail("Only the person who wrote a message can change it.") : { ok: true };
}

export async function deleteMessage(slug: string, id: number): Promise<Result<object>> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return fail(ctx.error ?? NO_ACCESS);
  const { error } = await ctx.supabase.rpc("delete_chat_message", { p_message_id: id });
  return error ? fail("Only the person who wrote a message can delete it.") : { ok: true };
}

export async function markRead(slug: string, channelId: string, lastId: number): Promise<void> {
  const ctx = await context(slug, false);
  if ("error" in ctx) return;
  await ctx.supabase.rpc("mark_chat_read", { p_channel_id: channelId, p_last_read_id: lastId });
}

export async function createChannel(
  slug: string,
  name: string,
  topic: string,
): Promise<Result<{ channelId: string }>> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return fail(ctx.error ?? NO_ACCESS);
  const tidy = name.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
  if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(tidy)) {
    return fail("Use 2 to 30 lowercase letters, numbers or dashes, like new-products.");
  }
  const { data, error } = await ctx.supabase.rpc("create_chat_channel", {
    p_tenant_id: ctx.tenant.id,
    p_name: tidy,
    p_topic: topic.slice(0, 120),
  });
  if (error) {
    return fail(error.code === "23505" ? `There's already a channel called #${tidy}.` : OOPS);
  }
  return { ok: true, channelId: data as string };
}

export async function openDm(slug: string, userId: string): Promise<Result<{ channelId: string }>> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return fail(ctx.error ?? NO_ACCESS);
  const { data, error } = await ctx.supabase.rpc("open_chat_dm", {
    p_tenant_id: ctx.tenant.id,
    p_other_user_id: userId,
  });
  return error ? fail(OOPS) : { ok: true, channelId: data as string };
}

export async function setDisplayName(slug: string, name: string): Promise<Result<object>> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return fail(ctx.error ?? NO_ACCESS);
  const tidy = name.trim();
  if (tidy.length > 40) return fail("Keep your name under 40 characters.");
  const { error } = await ctx.supabase.rpc("set_display_name", {
    p_tenant_id: ctx.tenant.id,
    p_name: tidy,
  });
  return error ? fail(OOPS) : { ok: true };
}
