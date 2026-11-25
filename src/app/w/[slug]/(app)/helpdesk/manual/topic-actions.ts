"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { loadManualConfig, loadTopic, loadTopicMedia } from "@/lib/helpdesk/manual/data";
import { copyFacets, copyTitle, joinTopics } from "@/lib/helpdesk/manual/join";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import type { ManualState } from "./actions";

/**
 * A topic's media (the customer's pictures and videos a person chose to
 * show), joining two topics, and copying one under another label. Every
 * write is a database function that checks who is asking; nothing here sends
 * a file anywhere or makes anything public.
 */

const NO_ACCESS = "The help desk isn't part of this workspace's plan right now.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const TRY_AGAIN = "That didn't save. Try again in a moment.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/helpdesk/manual`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.helpdesk")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  return { tenant: ctx.tenant, role: ctx.role, supabase: await createClient() } as const;
}

const base = (slug: string) => `/w/${slug}/helpdesk/manual`;
const refresh = (slug: string) => revalidatePath(base(slug), "layout");

/** Keeps a candidate on the topic, with the caption in the box (Claude's suggestion or a person's own). */
export async function keepTopicMedia(
  slug: string,
  mediaId: string,
  _prev: ManualState,
  formData: FormData,
): Promise<ManualState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!UUID.test(mediaId)) return { error: TRY_AGAIN };
  const { error } = await ctx.supabase.rpc("set_manual_topic_media", {
    p_tenant_id: ctx.tenant.id,
    p_media_id: mediaId,
    p_state: "kept",
    p_caption: String(formData.get("caption") ?? ""),
  });
  if (error) return { error: TRY_AGAIN };
  refresh(slug);
  return {};
}

/** Changes a kept picture's or video's caption. */
export async function captionTopicMedia(
  slug: string,
  mediaId: string,
  _prev: ManualState,
  formData: FormData,
): Promise<ManualState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!UUID.test(mediaId)) return { error: TRY_AGAIN };
  const { error } = await ctx.supabase.rpc("set_manual_topic_media", {
    p_tenant_id: ctx.tenant.id,
    p_media_id: mediaId,
    p_state: null,
    p_caption: String(formData.get("caption") ?? ""),
  });
  if (error) return { error: TRY_AGAIN };
  refresh(slug);
  return { message: "Saved." };
}

/** "Not this one" on a candidate, or "Remove" on a kept one. The file itself is untouched. */
export async function dismissTopicMedia(slug: string, mediaId: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !UUID.test(mediaId)) return;
  await ctx.supabase.rpc("set_manual_topic_media", {
    p_tenant_id: ctx.tenant.id,
    p_media_id: mediaId,
    p_state: "dismissed",
    p_caption: null,
  });
  refresh(slug);
}

/** Moves a kept one a place earlier or later. */
export async function moveTopicMedia(
  slug: string,
  topicId: string,
  mediaId: string,
  by: -1 | 1,
): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !UUID.test(topicId) || !UUID.test(mediaId)) return;
  const kept = (await loadTopicMedia(ctx.supabase, ctx.tenant.id, topicId))
    .filter((media) => media.state === "kept")
    .map((media) => media.id);
  const at = kept.indexOf(mediaId);
  const to = at + (by === -1 ? -1 : 1);
  if (at === -1 || to < 0 || to >= kept.length) return;
  [kept[at], kept[to]] = [kept[to], kept[at]];
  await ctx.supabase.rpc("order_manual_topic_media", {
    p_tenant_id: ctx.tenant.id,
    p_topic_id: topicId,
    p_media_ids: kept,
  });
  refresh(slug);
}

/**
 * Joins this topic into another and removes it. The words are put together
 * here by rule (what this one says that the other doesn't is added under the
 * same headings; nothing already written there changes); the database moves
 * the histories, conversations, case lines and media. Owners and admins.
 */
export async function joinTopic(
  slug: string,
  fromId: string,
  _prev: ManualState,
  formData: FormData,
): Promise<ManualState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!canManage(ctx.role)) return { error: "Only owners and admins can join topics." };
  const intoId = String(formData.get("into") ?? "");
  if (!UUID.test(fromId) || !UUID.test(intoId) || fromId === intoId) {
    return { error: "Pick a different topic to join it into." };
  }
  const [from, into, config] = await Promise.all([
    loadTopic(ctx.supabase, ctx.tenant.id, fromId),
    loadTopic(ctx.supabase, ctx.tenant.id, intoId),
    loadManualConfig(ctx.supabase, ctx.tenant.id),
  ]);
  if (!from || !into) return { error: "One of those topics couldn't be found." };
  const joined = joinTopics(into, from, config.sections);
  const { error } = await ctx.supabase.rpc("merge_manual_topics", {
    p_tenant_id: ctx.tenant.id,
    p_from: from.id,
    p_into: into.id,
    p_body: joined.body,
    p_facets: joined.facets,
  });
  if (error) return { error: "They couldn't be joined. Try again in a moment." };
  refresh(slug);
  redirect(`${base(slug)}/${into.id}`);
}

/**
 * "Copy for another <label>": the same words as a new draft under a
 * different value of one label, opened for editing. No conversations, case
 * lines, photos or history are copied.
 */
export async function copyTopicFor(
  slug: string,
  topicId: string,
  _prev: ManualState,
  formData: FormData,
): Promise<ManualState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  const [topic, config] = await Promise.all([
    loadTopic(ctx.supabase, ctx.tenant.id, topicId),
    loadManualConfig(ctx.supabase, ctx.tenant.id),
  ]);
  if (!topic) return { error: "That topic couldn't be found." };
  const facet = config.facets.find((f) => f.id === String(formData.get("facet") ?? ""));
  if (!facet) return { error: "Choose what the copy is for." };
  const facets = copyFacets(topic.facets, facet.id, String(formData.get("value") ?? ""));
  if (!facets) {
    return {
      error: `Type a different ${facet.label.toLowerCase()} from the one this topic already has.`,
    };
  }
  const { data, error } = await ctx.supabase.rpc("copy_manual_topic", {
    p_tenant_id: ctx.tenant.id,
    p_topic_id: topic.id,
    p_title: copyTitle(
      topic.title,
      facets.filter((f) => f.facet === facet.id),
    ),
    p_facets: facets,
  });
  if (error || !data) return { error: TRY_AGAIN };
  refresh(slug);
  redirect(`${base(slug)}/${data}?edit=1`);
}
