"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { parseClock, zonedTimeToUtc } from "@/lib/bookings/slots";
import { getEntitlements } from "@/lib/entitlements";
import { BRAND_MODULE, KIT_KEY, brandBrief, parseBrandKit } from "@/lib/brand/kit";
import { BANNER_TAG, MAX_DESIGN_SLIDES, ownDesign } from "@/lib/brand/slides";
import type { SlideDesign } from "@/lib/design/slide-design";
import { draftCaption } from "@/lib/social/caption";
import { productPhotoTags, productSourceRef, shopPhotoAddress } from "@/lib/social/product-photos";
import { LOGO_LIGHT_TAG, LOGO_TAG, pickPhoto, type TaggedAsset } from "@/lib/social/photo-match";
import {
  LINKS_KEY,
  PLAN_KEY,
  SOCIAL_MODULE,
  linkPageSchema,
  linksFromText,
  openSlots,
  parsePlan,
  socialPlanSchema,
} from "@/lib/social/plan";
import { REVIEW_KEY, reviewError, reviewSettingsSchema } from "@/lib/social/review";
import { publicAssetUrl } from "@/lib/social/worker";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

/** A photo from the workspace's assets that fits what a draft is about, and why it was picked. */
export type SuggestedPhoto = { id: string; url: string; title: string; reason: string };
export type SocialState = {
  error?: string;
  message?: string;
  draft?: string;
  photo?: SuggestedPhoto;
};

const NO_ACCESS = "Social isn't part of this workspace's plan right now.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const CHANNELS = ["facebook", "instagram"] as const;

const SAVE_ERRORS: Record<string, string> = {
  no_channel: "Pick where this should be posted.",
  empty: "Add a caption or a photo first.",
  instagram_needs_photo: "Instagram posts need a photo.",
  past: "Pick a time in the future.",
  locked: "This post has already gone out, so it can't be changed.",
  too_many_photos: "A post can have up to 10 photos.",
  caption_too_long: "Captions can be up to 2,200 characters.",
  video_alone: "A video goes out on its own. Take the photos off, or post them separately.",
  needs_approval:
    "This workspace approves posts before they go out. Press “Send for review” and an approver will look at it.",
};

type Ctx = Exclude<Awaited<ReturnType<typeof context>>, { error: string }>;

/** Stores uploaded photos in the workspace's folder and returns their ids, in order. */
async function storePhotos(
  ctx: Ctx,
  files: File[],
): Promise<{ ids: string[] } | { error: string }> {
  const photos = files.filter((file) => file.size > 0);
  if (photos.length === 0) return { ids: [] };
  if (photos.length > 20) return { error: "Add up to 20 photos at a time." };
  for (const photo of photos) {
    if (photo.type !== "image/jpeg" && photo.type !== "image/png") {
      return { error: "Photos need to be JPEG or PNG files." };
    }
    if (photo.size > MAX_PHOTO_BYTES) return { error: "Photos can be up to 5 MB each." };
  }
  if (!process.env.SUPABASE_SECRET_KEY) {
    return { error: "Photo uploads aren't switched on for this environment yet." };
  }
  const admin = getAdminClient();
  const ids: string[] = [];
  for (const photo of photos) {
    const path = `${ctx.tenant.id}/${randomUUID()}.${photo.type === "image/png" ? "png" : "jpg"}`;
    const { error: uploadError } = await admin.storage
      .from("social")
      .upload(path, photo, { contentType: photo.type });
    if (uploadError) {
      console.error(`Photo upload failed: ${uploadError.message}`);
      return { error: "A photo didn't upload. Please try again." };
    }
    const { data, error } = await admin.rpc("register_social_asset", {
      p_tenant_id: ctx.tenant.id,
      p_storage_path: path,
      p_mime_type: photo.type,
      p_bytes: photo.size,
      p_created_by: ctx.user.id,
    });
    if (error) return { error: "A photo didn't upload. Please try again." };
    ids.push(data as string);
  }
  return { ids };
}

const UUID = /^[0-9a-f-]{36}$/i;
const tagsFrom = (value: string) =>
  value
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12);

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/social`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.social")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  return {
    user,
    tenant: ctx.tenant,
    role: ctx.role,
    entitlements,
    supabase: await createClient(),
  } as const;
}

/** Saves a post as a draft, schedules it, or sends it now, depending on the button pressed. */
export async function savePost(
  slug: string,
  postId: string | null,
  _prev: SocialState,
  formData: FormData,
): Promise<SocialState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };

  const intent = String(formData.get("intent") ?? "draft");
  const caption = String(formData.get("caption") ?? "").trim();
  if (caption.length > 2200) return { error: "Captions can be up to 2,200 characters." };
  const channels = CHANNELS.filter((channel) => formData.get(`channel_${channel}`) === "on");

  let scheduledFor: string | null = null;
  if (intent === "now") {
    scheduledFor = new Date().toISOString();
  } else if (intent === "schedule") {
    const day = String(formData.get("day") ?? "");
    const minutes = parseClock(String(formData.get("time") ?? ""));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || minutes === null) {
      return { error: "Pick a date and time to schedule it for." };
    }
    const at = zonedTimeToUtc(day, minutes, ctx.tenant.timezone);
    if (!at) return { error: "That time doesn't exist on that day (the clocks change)." };
    scheduledFor = at.toISOString();
  }

  // The photos: the ones picked from the library, in order, then any new uploads.
  const picked = formData
    .getAll("asset")
    .map(String)
    .filter((id) => UUID.test(id));
  const uploaded = await storePhotos(
    ctx,
    formData.getAll("photos").filter((file): file is File => file instanceof File),
  );
  if ("error" in uploaded) return { error: uploaded.error };
  const assetIds = [...new Set([...picked, ...uploaded.ids])];
  if (assetIds.length > 10) return { error: SAVE_ERRORS.too_many_photos };
  if (scheduledFor && assetIds.length > 0 && channels.includes("instagram")) {
    const { data: kinds } = await ctx.supabase
      .from("social_assets")
      .select("mime_type")
      .eq("tenant_id", ctx.tenant.id)
      .in("id", assetIds);
    if ((kinds ?? []).some((asset) => asset.mime_type === "image/png")) {
      return { error: "Instagram only takes JPEG photos. Swap the PNG or untick Instagram." };
    }
  }

  // A draft keeps the date it's meant for, so it shows in the plan. One sent for review always
  // does: that is the time it is approved for.
  let plannedFor: string | null = null;
  if (intent === "draft" || intent === "review") {
    const day = String(formData.get("day") ?? "");
    const minutes = parseClock(String(formData.get("time") ?? ""));
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(day) &&
      minutes !== null &&
      (intent === "review" || formData.get("keep_date") === "on")
    ) {
      plannedFor = zonedTimeToUtc(day, minutes, ctx.tenant.timezone)?.toISOString() ?? null;
    }
  }
  const project = String(formData.get("project") ?? "");
  const { data: savedId, error } = await ctx.supabase.rpc("save_social_post_full", {
    p_tenant_id: ctx.tenant.id,
    p_post_id: postId,
    p_caption: caption,
    p_asset_ids: assetIds,
    p_channels: channels,
    p_scheduled_for: scheduledFor,
    p_captions: Object.fromEntries(
      CHANNELS.map((channel) => [
        channel,
        formData.get(`own_${channel}`) === "on"
          ? String(formData.get(`caption_${channel}`) ?? "").trim()
          : "",
      ]),
    ),
    p_project_id: UUID.test(project) ? project : null,
    p_topic: String(formData.get("topic") ?? "").slice(0, 40) || null,
    p_ai_draft: String(formData.get("ai_draft") ?? "").slice(0, 2200) || null,
    p_planned_for: plannedFor,
  });
  if (error) {
    const known = Object.keys(SAVE_ERRORS).find((key) => error.message.includes(key));
    return { error: known ? SAVE_ERRORS[known] : "That didn't save. Please try again." };
  }
  if (intent === "review") {
    const { error: submitError } = await ctx.supabase.rpc("submit_social_post", {
      p_tenant_id: ctx.tenant.id,
      p_post_id: savedId as string,
    });
    if (submitError) {
      return { error: "It saved as a draft, but didn't go for review. Please try again." };
    }
  }
  revalidatePath(`/w/${slug}/social`, "layout");
  if (formData.get("after") === "review" && intent !== "draft") {
    redirect(`/w/${slug}/social/review?saved=${intent === "review" ? "review" : "approved"}`);
  }
  redirect(`/w/${slug}/social?saved=${intent}`);
}

// ---------------------------------------------------------------------------
// Review: send back with a note, approve several, the setting
// ---------------------------------------------------------------------------

/** An approver sends a post back with a note saying what to change. */
export async function sendBackPost(
  slug: string,
  postId: string,
  _prev: SocialState,
  formData: FormData,
): Promise<SocialState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const note = String(formData.get("note") ?? "")
    .trim()
    .slice(0, 1000);
  const { error } = await ctx.supabase.rpc("send_back_social_post", {
    p_tenant_id: ctx.tenant.id,
    p_post_id: postId,
    p_note: note,
  });
  if (error) return { error: reviewError(error.message) ?? OOPS };
  done(slug);
  redirect(`/w/${slug}/social/review?saved=sent_back`);
}

export type ApproveResult = {
  error?: string;
  approved?: number;
  skipped?: { id: string; reason: string }[];
};

/**
 * "Approve all": the ticked posts and/or every post waiting for review in a month, in one
 * checked database function. Each is approved for the time it was pencilled in for; one that
 * can't go out is skipped with the reason, and the rest still go.
 */
export async function approvePosts(
  slug: string,
  ids: string[],
  month: string | null,
): Promise<ApproveResult> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const posts = (Array.isArray(ids) ? ids : []).filter((id) => UUID.test(id)).slice(0, 200);
  const wantedMonth = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
  if (posts.length === 0 && !wantedMonth) return { error: "Tick some posts first." };
  const { data, error } = await ctx.supabase.rpc("approve_social_posts", {
    p_tenant_id: ctx.tenant.id,
    p_post_ids: posts,
    p_month: wantedMonth,
  });
  if (error) return { error: reviewError(error.message) ?? OOPS };
  const result = (data ?? {}) as {
    approved?: string[];
    skipped?: { id: string; reason: string }[];
  };
  done(slug);
  return {
    approved: (result.approved ?? []).length,
    skipped: (result.skipped ?? []).map((skip) => ({
      id: skip.id,
      reason: reviewError(skip.reason) ?? "It couldn't be approved. Open it to see why.",
    })),
  };
}

/** Settings → Social & emails → Post review. Owners and admins only, like every setting. */
export async function saveReviewSettings(
  slug: string,
  _prev: SocialState,
  formData: FormData,
): Promise<SocialState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!canManage(ctx.role)) return { error: "Only owners and admins can change this." };
  const parsed = reviewSettingsSchema.safeParse({
    version: 1,
    require_approval: formData.get("require_approval") === "on",
    approvers: [
      ...new Set(
        ["owner", ...formData.getAll("approvers").map(String)].filter(
          (role) => role === "owner" || role === "admin" || role === "member",
        ),
      ),
    ],
  });
  if (!parsed.success) return { error: OOPS };
  if (!(await saveSocialConfig(ctx, REVIEW_KEY, parsed.data))) return { error: OOPS };
  done(slug);
  revalidatePath(`/w/${slug}/settings`, "layout");
  return { message: "Saved." };
}

export async function deletePost(
  slug: string,
  postId: string,
  _prev: SocialState,
  _formData: FormData,
): Promise<SocialState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("delete_social_post", { p_post_id: postId });
  if (error) return { error: SAVE_ERRORS.locked };
  revalidatePath(`/w/${slug}/social`, "layout");
  redirect(`/w/${slug}/social?saved=deleted`);
}

type PhotoRow = TaggedAsset & { storagePath: string };

/** The workspace's photos with their names and tags, newest first, for matching to a draft. */
async function taggedPhotos(ctx: Ctx): Promise<PhotoRow[]> {
  const { data } = await ctx.supabase
    .from("social_assets")
    .select("id, storage_path, title, tags, mime_type")
    .eq("tenant_id", ctx.tenant.id)
    .eq("hidden", false)
    .like("mime_type", "image/%")
    .order("created_at", { ascending: false })
    .limit(500);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    storagePath: row.storage_path as string,
    title: (row.title as string) ?? "",
    tags: (row.tags as string[] | null) ?? [],
    mimeType: row.mime_type as string,
  }));
}

/** Asks Claude for a caption. It lands in the caption box; a person decides what gets posted. */
export async function draftPostCaption(
  slug: string,
  _prev: SocialState,
  formData: FormData,
): Promise<SocialState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "Drafting isn't switched on for this environment yet." };
  }
  const brief = String(formData.get("brief") ?? "")
    .trim()
    .slice(0, 1000);
  if (brief.length < 3) return { error: "Say in a few words what the post is about." };

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [{ data: usage }, { data: recent }, { data: planRow }, photos] = await Promise.all([
    ctx.supabase
      .from("usage_events")
      .select("quantity")
      .eq("tenant_id", ctx.tenant.id)
      .eq("type", "ai_tokens")
      .gte("occurred_at", monthStart.toISOString()),
    ctx.supabase
      .from("social_posts")
      .select("caption")
      .eq("tenant_id", ctx.tenant.id)
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(5),
    ctx.supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", ctx.tenant.id)
      .eq("module", SOCIAL_MODULE)
      .eq("key", PLAN_KEY)
      .maybeSingle(),
    taggedPhotos(ctx),
  ]);
  const used = (usage ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
  if (used >= ctx.entitlements.limit("ai_credits")) {
    return {
      error:
        "You've used this month's AI allowance. It resets next month, or you can upgrade your plan for more.",
    };
  }
  // A photo is suggested from the tags alone: the brief and the post's topic against the
  // workspace's own tags and names. Claude isn't asked, and nothing is looked up anywhere.
  const plan = parsePlan(planRow?.body);
  const topic = plan.topics.find((t) => t.id === String(formData.get("topic") ?? ""));
  const match = pickPhoto(photos, `${brief} ${topic ? `${topic.name} ${topic.about}` : ""}`);
  const photo: SuggestedPhoto | undefined = match
    ? {
        id: match.asset.id,
        url: publicAssetUrl(match.asset.storagePath),
        title: match.asset.title,
        reason: match.reason,
      }
    : undefined;

  try {
    const draft = await draftCaption({
      workspaceName: ctx.tenant.name,
      brief,
      channels: CHANNELS.filter((c) => formData.get(`channel_${c}`) === "on").map((c) =>
        c === "facebook" ? "Facebook" : "Instagram",
      ),
      recent: (recent ?? []).map((row) => String(row.caption).slice(0, 600)).filter(Boolean),
      styleNotes: plan.style_notes,
      brand: await loadBrandBrief(ctx),
    });
    // Metered whether or not a draft came back: the tokens were spent.
    const { error: usageError } = await getAdminClient().rpc("record_usage", {
      p_tenant_id: ctx.tenant.id,
      p_type: "ai_tokens",
      p_quantity: draft.tokens,
    });
    if (usageError) console.error(`Could not record AI usage: ${usageError.message}`);
    if (!draft.ok) return { error: "Claude couldn't draft this one. You can write it yourself." };
    return { draft: draft.text, photo };
  } catch (err) {
    console.error("Caption draft failed", err instanceof Error ? err.message : err);
    return { error: "Drafting didn't work just now. Please try again." };
  }
}

const done = (slug: string) => revalidatePath(`/w/${slug}/social`, "layout");
const OOPS = "That didn't save. Please try again.";

/** Adds photos to the library, optionally straight into a project with tags. */
export async function uploadPhotos(
  slug: string,
  _prev: SocialState,
  formData: FormData,
): Promise<SocialState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const stored = await storePhotos(
    ctx,
    formData.getAll("photos").filter((file): file is File => file instanceof File),
  );
  if ("error" in stored) return { error: stored.error };
  if (stored.ids.length === 0) return { error: "Choose some photos first." };
  const project = String(formData.get("project") ?? "");
  const tags = tagsFrom(String(formData.get("tags") ?? ""));
  if (UUID.test(project) || tags.length > 0) {
    await ctx.supabase.rpc("file_social_assets", {
      p_tenant_id: ctx.tenant.id,
      p_asset_ids: stored.ids,
      p_project_id: UUID.test(project) ? project : null,
      p_add_tags: tags,
    });
  }
  done(slug);
  return { message: `${stored.ids.length} photo${stored.ids.length === 1 ? "" : "s"} added.` };
}

export async function updatePhoto(
  slug: string,
  assetId: string,
  _prev: SocialState,
  formData: FormData,
): Promise<SocialState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const project = String(formData.get("project") ?? "");
  const { error } = await ctx.supabase.rpc("update_social_asset", {
    p_asset_id: assetId,
    p_title: String(formData.get("title") ?? "").slice(0, 120),
    p_tags: tagsFrom(String(formData.get("tags") ?? "")),
    p_project_id: UUID.test(project) ? project : null,
    p_hidden: formData.get("hidden") === "on",
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Saved." };
}

export async function saveProject(
  slug: string,
  projectId: string | null,
  _prev: SocialState,
  formData: FormData,
): Promise<SocialState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 80) return { error: "Give the project a name (up to 80 characters)." };
  const { data, error } = await ctx.supabase.rpc("save_social_project", {
    p_tenant_id: ctx.tenant.id,
    p_project_id: projectId,
    p_name: name,
    p_note: String(formData.get("note") ?? "").slice(0, 2000),
    p_topic: String(formData.get("topic") ?? "").slice(0, 40),
    p_archived: formData.get("archived") === "on",
  });
  if (error) return { error: OOPS };
  done(slug);
  if (!projectId) redirect(`/w/${slug}/social/projects/${data as string}`);
  return { message: "Saved." };
}

/** The workspace's brand kit, in words, for a draft to follow. */
async function loadBrandBrief(ctx: Ctx): Promise<string> {
  const { data } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", BRAND_MODULE)
    .eq("key", KIT_KEY)
    .maybeSingle();
  return brandBrief(parseBrandKit(data?.body));
}

async function saveSocialConfig(ctx: Ctx, key: string, body: object): Promise<boolean> {
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: SOCIAL_MODULE,
    p_key: key,
    p_body: body,
  });
  return !error;
}

const slugify = (value: string, index: number) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || `topic-${index + 1}`;

/**
 * Saves the content plan. Topics are typed one per line as "Name: what it's
 * about"; posting times are rows of day, time and topic.
 */
export async function savePlan(
  slug: string,
  _prev: SocialState,
  formData: FormData,
): Promise<SocialState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const topics = String(formData.get("topics") ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const cut = line.indexOf(":");
      const name = (cut === -1 ? line : line.slice(0, cut)).trim().slice(0, 40);
      return {
        id: slugify(name, index),
        name,
        about: cut === -1 ? "" : line.slice(cut + 1).trim(),
      };
    });
  const slots: { weekday: number; time: string; topic: string | null }[] = [];
  for (let row = 0; row < 21; row++) {
    const time = String(formData.get(`slot_time_${row}`) ?? "");
    if (!time) continue;
    const topic = String(formData.get(`slot_topic_${row}`) ?? "");
    slots.push({
      weekday: Number.parseInt(String(formData.get(`slot_day_${row}`) ?? "1"), 10),
      time,
      topic: topics.some((t) => t.id === topic) ? topic : null,
    });
  }
  const parsed = socialPlanSchema.safeParse({
    version: 1,
    topics,
    slots,
    style_notes: String(formData.get("style_notes") ?? ""),
  });
  if (!parsed.success) {
    return {
      error:
        "Check the plan: up to 12 topics (names under 40 characters) and voice notes under 3,000 characters.",
    };
  }
  if (new Set(parsed.data.topics.map((t) => t.id)).size !== parsed.data.topics.length) {
    return { error: "Two topics have the same name. Give each its own." };
  }
  if (!(await saveSocialConfig(ctx, PLAN_KEY, parsed.data))) return { error: OOPS };
  done(slug);
  return { message: "Plan saved." };
}

export async function saveLinkPage(
  slug: string,
  _prev: SocialState,
  formData: FormData,
): Promise<SocialState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!canManage(ctx.role)) return { error: "Only owners and admins can change the link page." };
  const links = linksFromText(String(formData.get("links") ?? ""));
  if ("error" in links) return { error: links.error };
  const parsed = linkPageSchema.safeParse({
    version: 1,
    published: formData.get("published") === "on",
    heading: String(formData.get("heading") ?? ""),
    intro: String(formData.get("intro") ?? ""),
    links: links.links,
    show_posts: formData.get("show_posts") === "on",
  });
  if (!parsed.success) {
    return { error: "Keep the heading under 80 characters and the intro under 300." };
  }
  if (!(await saveSocialConfig(ctx, LINKS_KEY, parsed.data))) return { error: OOPS };
  done(slug);
  return { message: parsed.data.published ? "Saved and live." : "Saved. It isn't published yet." };
}

/**
 * Drafts a post for each open time in the coming four weeks (ten at most).
 * Every one is saved as a draft for a person to read, change and schedule;
 * nothing here is ever posted (CLAUDE.md rule 6).
 */
export async function draftTheMonth(
  slug: string,
  _prev: SocialState,
  _formData: FormData,
): Promise<SocialState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "Drafting isn't switched on for this environment yet." };
  }
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [{ data: planRow }, { data: posts }, { data: recent }, { data: usage }] = await Promise.all(
    [
      ctx.supabase
        .from("configs")
        .select("body")
        .eq("tenant_id", ctx.tenant.id)
        .eq("module", SOCIAL_MODULE)
        .eq("key", PLAN_KEY)
        .maybeSingle(),
      ctx.supabase
        .from("social_posts")
        .select("status, scheduled_for, planned_for, topic")
        .eq("tenant_id", ctx.tenant.id)
        .or(
          `scheduled_for.gte.${new Date().toISOString()},planned_for.gte.${new Date().toISOString()}`,
        )
        .limit(500),
      ctx.supabase
        .from("social_posts")
        .select("caption")
        .eq("tenant_id", ctx.tenant.id)
        .eq("status", "published")
        .order("published_at", { ascending: false })
        .limit(5),
      ctx.supabase
        .from("usage_events")
        .select("quantity")
        .eq("tenant_id", ctx.tenant.id)
        .eq("type", "ai_tokens")
        .gte("occurred_at", monthStart.toISOString()),
    ],
  );
  const plan = parsePlan(planRow?.body);
  if (plan.slots.length === 0) return { error: "Add your posting times to the plan first." };
  const open = openSlots(plan, posts ?? [], new Date(), 28, ctx.tenant.timezone).slice(0, 10);
  if (open.length === 0)
    return { message: "Every posting time in the next four weeks is covered." };

  let used = (usage ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
  const limit = ctx.entitlements.limit("ai_credits");
  const admin = getAdminClient();
  let made = 0;
  let withPhoto = 0;
  const brand = await loadBrandBrief(ctx);
  const photos = await taggedPhotos(ctx);
  // Each photo is offered to one draft only, so a month of posts doesn't show the same one.
  const taken = new Set<string>();
  for (const slot of open) {
    if (used >= limit) break;
    const topic = plan.topics.find((t) => t.id === slot.topic);
    // One photo at most, matched by its tags to the topic. The draft's page says why it is there.
    const match = topic ? pickPhoto(photos, `${topic.name} ${topic.about}`, taken) : null;
    try {
      const draft = await draftCaption({
        workspaceName: ctx.tenant.name,
        brief: topic
          ? `A "${topic.name}" post.${topic.about ? ` ${topic.about}` : ""} Leave a clear gap, marked [like this], for any detail only the owner knows.`
          : "A general update from the studio. Leave a clear gap, marked [like this], for any detail only the owner knows.",
        channels: ["Facebook", "Instagram"],
        recent: (recent ?? []).map((row) => String(row.caption).slice(0, 600)).filter(Boolean),
        styleNotes: plan.style_notes,
        brand,
      });
      used += draft.tokens;
      await admin.rpc("record_usage", {
        p_tenant_id: ctx.tenant.id,
        p_type: "ai_tokens",
        p_quantity: draft.tokens,
      });
      if (!draft.ok) continue;
      const { error } = await ctx.supabase.rpc("save_social_post_full", {
        p_tenant_id: ctx.tenant.id,
        p_post_id: null,
        p_caption: draft.text,
        p_asset_ids: match ? [match.asset.id] : [],
        p_channels: [],
        p_scheduled_for: null,
        p_captions: {},
        p_project_id: null,
        p_topic: slot.topic,
        p_ai_draft: draft.text,
        p_planned_for: slot.at,
      });
      if (!error) {
        made += 1;
        if (match) {
          withPhoto += 1;
          taken.add(match.asset.id);
        }
      }
    } catch (err) {
      console.error("Month draft failed", err instanceof Error ? err.message : err);
      break;
    }
  }
  done(slug);
  if (made === 0) {
    return {
      error:
        used >= limit
          ? "You've used this month's AI allowance, so no drafts were written."
          : "Drafting didn't work just now. Please try again.",
    };
  }
  const photoNote =
    withPhoto === 0
      ? ""
      : ` ${withPhoto === made ? (made === 1 ? "It has" : "Each has") : `${withPhoto} have`} a photo picked by its tags; open the draft to see why, or take it off.`;
  return {
    message: `${made} draft${made === 1 ? "" : "s"} written.${photoNote} Read each one, check the photo, then schedule it.`,
  };
}

// ---------------------------------------------------------------------------
// Assets: photos and videos, in folders
// ---------------------------------------------------------------------------

const ASSET_TYPES: Record<string, { ext: string; max: number }> = {
  "image/jpeg": { ext: "jpg", max: 8 * 1024 * 1024 },
  "image/png": { ext: "png", max: 8 * 1024 * 1024 },
  "video/mp4": { ext: "mp4", max: 50 * 1024 * 1024 },
  "video/quicktime": { ext: "mov", max: 50 * 1024 * 1024 },
};

export type UploadTicket = { path: string; token: string };

/**
 * Hands the browser a one-time link for each file, so it can send them
 * straight to storage. Nothing is in the library until `finishUpload` has
 * looked at what actually arrived.
 */
export async function startUpload(
  slug: string,
  files: { type: string; size: number }[],
): Promise<{ tickets: UploadTicket[] } | { error: string }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!process.env.SUPABASE_SECRET_KEY) {
    return { error: "Uploads aren't switched on for this environment yet." };
  }
  if (files.length === 0) return { error: "Choose some files first." };
  if (files.length > 30) return { error: "Add up to 30 files at a time." };
  for (const file of files) {
    const kind = ASSET_TYPES[file.type];
    if (!kind) return { error: "Photos need to be JPEG or PNG, and videos MP4 or MOV." };
    if (!(file.size > 0) || file.size > kind.max) {
      return {
        error: file.type.startsWith("video/")
          ? "Videos can be up to 50 MB each."
          : "Photos can be up to 8 MB each.",
      };
    }
  }
  const admin = getAdminClient();
  const tickets: UploadTicket[] = [];
  for (const file of files) {
    const path = `${ctx.tenant.id}/${randomUUID()}.${ASSET_TYPES[file.type].ext}`;
    const { data, error } = await admin.storage.from("social").createSignedUploadUrl(path);
    if (error || !data) {
      console.error(`Upload link failed: ${error?.message ?? "no data"}`);
      return { error: "We couldn't start the upload. Please try again." };
    }
    tickets.push({ path, token: data.token });
  }
  return { tickets };
}

/**
 * Checks each file the browser says it uploaded (it must be in this workspace's folder, and
 * really be the type and size allowed) and registers the ones that pass. Nothing from the
 * browser is trusted: the type and size are read back from storage.
 */
async function registerUploads(
  ctx: Ctx,
  items: { path: string; title: string }[],
  folderId: string | null,
  only: "any" | "pictures" = "any",
): Promise<{ id: string; path: string }[]> {
  const admin = getAdminClient();
  const bucket = admin.storage.from("social");
  const mine = new RegExp(`^${ctx.tenant.id}/[0-9a-f-]{36}\\.(jpg|png|mp4|mov)$`);
  const filed: { id: string; path: string }[] = [];
  for (const item of items.slice(0, 30)) {
    if (typeof item?.path !== "string" || !mine.test(item.path)) continue;
    const { data: info } = await bucket.info(item.path);
    const type = info?.contentType ?? "";
    const size = info?.size ?? 0;
    const kind = ASSET_TYPES[type];
    if (
      !kind ||
      !(size > 0) ||
      size > kind.max ||
      !item.path.endsWith(`.${kind.ext}`) ||
      (only === "pictures" && !type.startsWith("image/"))
    ) {
      if (info) await bucket.remove([item.path]);
      continue;
    }
    const { data, error } = await admin.rpc("register_social_asset", {
      p_tenant_id: ctx.tenant.id,
      p_storage_path: item.path,
      p_mime_type: type,
      p_bytes: size,
      p_created_by: ctx.user.id,
      p_folder_id: folderId && UUID.test(folderId) ? folderId : null,
      p_title: String(item.title ?? "").slice(0, 120),
    });
    if (!error && data) filed.push({ id: data as string, path: item.path });
  }
  return filed;
}

/** Files what the browser uploaded, after checking each file really is what it should be. */
export async function finishUpload(
  slug: string,
  items: { path: string; title: string }[],
  folderId: string | null,
  tagsText: string,
): Promise<{ added: number } | { error: string }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!process.env.SUPABASE_SECRET_KEY) {
    return { error: "Uploads aren't switched on for this environment yet." };
  }
  const ids = (await registerUploads(ctx, items, folderId)).map((file) => file.id);
  if (ids.length === 0) return { error: "Those files didn't arrive. Please try again." };
  const tags = tagsFrom(tagsText);
  if (tags.length > 0) {
    await ctx.supabase.rpc("sort_social_assets", {
      p_tenant_id: ctx.tenant.id,
      p_asset_ids: ids,
      p_move: false,
      p_folder_id: null,
      p_add_tags: tags,
      p_hidden: null,
    });
  }
  done(slug);
  return { added: ids.length };
}

// ---------------------------------------------------------------------------
// Designed pictures: made in the designer, kept as assets with their design
// ---------------------------------------------------------------------------

export type DesignPhoto = { id: string; url: string; title: string; tags: string[] };
export type DesignedPicture = { id: string; url: string; title: string };

/** The workspace's photos, for choosing one inside a design. Videos and put-away files are left out. */
export async function listDesignPhotos(slug: string): Promise<DesignPhoto[]> {
  const ctx = await context(slug);
  if ("error" in ctx) return [];
  return (await taggedPhotos(ctx)).map((photo) => ({
    id: photo.id,
    url: publicAssetUrl(photo.storagePath),
    title: photo.title,
    tags: photo.tags,
  }));
}

/** The design a picture was made from, to open it again. */
export async function loadAssetDesign(
  slug: string,
  assetId: string,
): Promise<{ design: SlideDesign; title: string } | { error: string }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  const missing = { error: "This picture's design couldn't be found." };
  if (!UUID.test(assetId)) return missing;
  const { data } = await ctx.supabase
    .from("social_assets")
    .select("title, design")
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", assetId)
    .maybeSingle();
  const design = ownDesign(data?.design, publicAssetUrl(`${ctx.tenant.id}/`), 1);
  return design ? { design, title: (data?.title as string) ?? "" } : missing;
}

/**
 * Keeps pictures drawn in the designer. The browser has already sent each one to storage with a
 * link from `startUpload`; here each is checked like any upload, registered as an asset, and
 * given its design (one picture each) so it can be opened and changed later. The design is
 * tidied first, and may only picture this workspace's own photos.
 *
 * With `replaces`, the one picture is a new version of that asset: it takes the old one's name,
 * tags, folder and project, and the old one is put away unless a post that has gone out used it.
 */
export async function saveDesignedPictures(
  slug: string,
  items: { path: string; title: string; design: unknown }[],
  options: { banner?: boolean; replaces?: string | null } = {},
): Promise<{ pictures: DesignedPicture[] } | { error: string }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!process.env.SUPABASE_SECRET_KEY) {
    return { error: "Uploads aren't switched on for this environment yet." };
  }
  const wanted = Array.isArray(items) ? items.slice(0, MAX_DESIGN_SLIDES) : [];
  const home = publicAssetUrl(`${ctx.tenant.id}/`);
  const designs = wanted.map((item) => ownDesign(item?.design, home, 1));
  if (wanted.length === 0 || designs.some((design) => !design)) {
    return { error: "That design couldn't be read. Please try again." };
  }

  // The picture being replaced must be one of this workspace's own.
  type Old = {
    id: string;
    title: string;
    tags: string[] | null;
    folder_id: string | null;
    project_id: string | null;
  };
  let old: Old | null = null;
  if (options.replaces) {
    if (wanted.length !== 1 || !UUID.test(options.replaces)) {
      return { error: "That picture couldn't be found." };
    }
    const { data } = await ctx.supabase
      .from("social_assets")
      .select("id, title, tags, folder_id, project_id")
      .eq("tenant_id", ctx.tenant.id)
      .eq("id", options.replaces)
      .like("mime_type", "image/%")
      .maybeSingle();
    if (!data) return { error: "That picture couldn't be found." };
    old = data as Old;
  }

  const named = wanted.map((item) => ({
    path: item.path,
    title: old?.title || String(item.title ?? "").slice(0, 120) || "Designed picture",
  }));
  const filed = await registerUploads(ctx, named, old?.folder_id ?? null, "pictures");
  // All or nothing: a post's pictures stay in the order they were designed in.
  const ids = filed.map((file) => file.id);
  const putAway = (assetIds: string[]) =>
    ctx.supabase.rpc("sort_social_assets", {
      p_tenant_id: ctx.tenant.id,
      p_asset_ids: assetIds,
      p_move: false,
      p_folder_id: null,
      p_add_tags: [],
      p_hidden: true,
    });
  const failed = async (error: string) => {
    if (ids.length > 0) await putAway(ids);
    return { error };
  };
  if (filed.length !== wanted.length) {
    return failed("The picture didn't arrive. Check your connection and try again.");
  }
  for (const [index, file] of filed.entries()) {
    const { error } = await ctx.supabase.rpc("set_social_asset_design", {
      p_tenant_id: ctx.tenant.id,
      p_asset_id: file.id,
      p_design: designs[index],
    });
    if (error) {
      console.error(`Design not kept: ${error.message}`);
      return failed("The picture couldn't be saved. Please try again.");
    }
  }
  const carried = (old?.tags ?? []).filter((tag) => tag !== LOGO_TAG && tag !== LOGO_LIGHT_TAG);
  const tags = [...(options.banner ? [BANNER_TAG] : []), ...carried];
  if (old?.project_id) {
    await ctx.supabase.rpc("file_social_assets", {
      p_tenant_id: ctx.tenant.id,
      p_asset_ids: ids,
      p_project_id: old.project_id,
      p_add_tags: tags,
    });
  } else if (tags.length > 0) {
    await ctx.supabase.rpc("sort_social_assets", {
      p_tenant_id: ctx.tenant.id,
      p_asset_ids: ids,
      p_move: false,
      p_folder_id: null,
      p_add_tags: tags,
      p_hidden: null,
    });
  }

  if (old) {
    // A post that has gone out, or is on its way, keeps the picture it was sent with in view.
    const { data: sent } = await ctx.supabase
      .from("social_posts")
      .select("id")
      .eq("tenant_id", ctx.tenant.id)
      .in("status", ["published", "publishing"])
      .or(`asset_id.eq.${old.id},asset_ids.cs.{${old.id}}`)
      .limit(1);
    if ((sent ?? []).length === 0) await putAway([old.id]);
  }
  done(slug);
  return {
    pictures: filed.map((file) => ({
      id: file.id,
      url: publicAssetUrl(file.path),
      title: named.find((item) => item.path === file.path)?.title ?? "",
    })),
  };
}

export async function saveFolder(
  slug: string,
  folderId: string | null,
  _prev: SocialState,
  formData: FormData,
): Promise<SocialState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 60) return { error: "Give the folder a name (up to 60 characters)." };
  const { error } = await ctx.supabase.rpc("save_social_folder", {
    p_tenant_id: ctx.tenant.id,
    p_folder_id: folderId,
    p_name: name,
  });
  if (error) {
    return {
      error: error.message.includes("too_many_folders")
        ? "That's the most folders a workspace can have."
        : OOPS,
    };
  }
  done(slug);
  return { message: folderId ? "Renamed." : "Folder added." };
}

/** Removes a folder; what was in it stays in the library. */
export async function removeFolder(slug: string, folderId: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !UUID.test(folderId)) return;
  await ctx.supabase.rpc("remove_social_folder", {
    p_tenant_id: ctx.tenant.id,
    p_folder_id: folderId,
  });
  done(slug);
  redirect(`/w/${slug}/social/library`);
}

/** Moves, tags or puts away several files at once. */
export async function sortAssets(
  slug: string,
  ids: string[],
  change: { moveTo?: string | null; tags?: string; hidden?: boolean },
): Promise<{ error?: string; changed?: number }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const assets = ids.filter((id) => UUID.test(id)).slice(0, 400);
  if (assets.length === 0) return { error: "Pick some files first." };
  const moving = change.moveTo !== undefined;
  const { data, error } = await ctx.supabase.rpc("sort_social_assets", {
    p_tenant_id: ctx.tenant.id,
    p_asset_ids: assets,
    p_move: moving,
    p_folder_id: moving && change.moveTo && UUID.test(change.moveTo) ? change.moveTo : null,
    p_add_tags: tagsFrom(change.tags ?? ""),
    p_hidden: change.hidden ?? null,
  });
  if (error) return { error: OOPS };
  done(slug);
  return { changed: Number(data ?? 0) };
}

// ---------------------------------------------------------------------------
// Product photos from the shop
// ---------------------------------------------------------------------------

const PHOTOS_PER_RUN = 30;

/**
 * Copies each product's main photo from the shop into Assets, tagged with
 * "product" and the words of its name, so posts and emails can pick it up.
 * A product already brought in is skipped; a few at a time, so it can be
 * pressed again for the rest.
 */
export async function importProductPhotos(
  slug: string,
): Promise<{ added: number; left: number } | { error: string }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!process.env.SUPABASE_SECRET_KEY) {
    return { error: "Uploads aren't switched on for this environment yet." };
  }
  const { data: items, error } = await ctx.supabase
    .from("stock_items")
    .select("provider, product_external_id, title, image_url")
    .eq("tenant_id", ctx.tenant.id)
    .not("image_url", "is", null)
    .not("product_external_id", "is", null)
    .order("title")
    .limit(1000);
  if (error) return { error: OOPS };
  // One photo per product, however many sizes or colours it comes in.
  const products = new Map<string, { title: string; address: string }>();
  for (const item of items ?? []) {
    const ref = productSourceRef(String(item.provider), String(item.product_external_id));
    const address = shopPhotoAddress(item.image_url as string);
    if (address && !products.has(ref)) products.set(ref, { title: String(item.title), address });
  }
  if (products.size === 0) {
    return {
      error: "Your shop hasn't shared any product photos yet. They arrive with the next sync.",
    };
  }
  const { data: have } = await ctx.supabase
    .from("social_assets")
    .select("source_ref")
    .eq("tenant_id", ctx.tenant.id)
    .not("source_ref", "is", null)
    .limit(1000);
  const already = new Set((have ?? []).map((row) => row.source_ref as string));
  const todo = [...products].filter(([ref]) => !already.has(ref));

  const admin = getAdminClient();
  let added = 0;
  for (const [ref, product] of todo.slice(0, PHOTOS_PER_RUN)) {
    try {
      // `redirect: "error"`: the address was checked, and it must be the one fetched.
      const response = await fetch(product.address, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { Accept: "image/jpeg,image/png" },
      });
      const type = (response.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!response.ok || (type !== "image/jpeg" && type !== "image/png")) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) continue;
      const path = `${ctx.tenant.id}/${randomUUID()}.${type === "image/png" ? "png" : "jpg"}`;
      const { error: uploadError } = await admin.storage
        .from("social")
        .upload(path, bytes, { contentType: type });
      if (uploadError) continue;
      const { data: id, error: registerError } = await admin.rpc("register_product_photo", {
        p_tenant_id: ctx.tenant.id,
        p_storage_path: path,
        p_mime_type: type,
        p_bytes: bytes.length,
        p_created_by: ctx.user.id,
        p_title: product.title.slice(0, 120),
        p_tags: productPhotoTags(product.title),
        p_source_ref: ref,
      });
      // Already there (someone pressed at the same moment), or it failed: don't keep the copy.
      if (registerError || !id) await admin.storage.from("social").remove([path]);
      else added += 1;
    } catch (err) {
      console.error(`Product photo skipped: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }
  done(slug);
  return { added, left: Math.max(0, todo.length - PHOTOS_PER_RUN) };
}
