"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { parseClock, zonedTimeToUtc } from "@/lib/bookings/slots";
import { getEntitlements } from "@/lib/entitlements";
import { BRAND_MODULE, KIT_KEY, brandBrief, parseBrandKit } from "@/lib/brand/kit";
import { draftCaption } from "@/lib/social/caption";
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
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type SocialState = { error?: string; message?: string; draft?: string };

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

  // A draft keeps the date it's meant for, so it shows in the plan.
  let plannedFor: string | null = null;
  if (intent === "draft") {
    const day = String(formData.get("day") ?? "");
    const minutes = parseClock(String(formData.get("time") ?? ""));
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && minutes !== null && formData.get("keep_date") === "on") {
      plannedFor = zonedTimeToUtc(day, minutes, ctx.tenant.timezone)?.toISOString() ?? null;
    }
  }
  const project = String(formData.get("project") ?? "");
  const { error } = await ctx.supabase.rpc("save_social_post_full", {
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
  revalidatePath(`/w/${slug}/social`, "layout");
  redirect(`/w/${slug}/social?saved=${intent}`);
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
  const [{ data: usage }, { data: recent }, { data: planRow }] = await Promise.all([
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
  ]);
  const used = (usage ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
  if (used >= ctx.entitlements.limit("ai_credits")) {
    return {
      error:
        "You've used this month's AI allowance. It resets next month, or you can upgrade your plan for more.",
    };
  }

  try {
    const draft = await draftCaption({
      workspaceName: ctx.tenant.name,
      brief,
      channels: CHANNELS.filter((c) => formData.get(`channel_${c}`) === "on").map((c) =>
        c === "facebook" ? "Facebook" : "Instagram",
      ),
      recent: (recent ?? []).map((row) => String(row.caption).slice(0, 600)).filter(Boolean),
      styleNotes: parsePlan(planRow?.body).style_notes,
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
    return { draft: draft.text };
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
  const brand = await loadBrandBrief(ctx);
  for (const slot of open) {
    if (used >= limit) break;
    const topic = plan.topics.find((t) => t.id === slot.topic);
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
        p_asset_ids: [],
        p_channels: [],
        p_scheduled_for: null,
        p_captions: {},
        p_project_id: null,
        p_topic: slot.topic,
        p_ai_draft: draft.text,
        p_planned_for: slot.at,
      });
      if (!error) made += 1;
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
  return {
    message: `${made} draft${made === 1 ? "" : "s"} written. Read each one, add a photo, then schedule it.`,
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
  const admin = getAdminClient();
  const bucket = admin.storage.from("social");
  const mine = new RegExp(`^${ctx.tenant.id}/[0-9a-f-]{36}\\.(jpg|png|mp4|mov)$`);
  const ids: string[] = [];
  for (const item of items.slice(0, 30)) {
    if (!mine.test(item.path)) continue;
    const { data: info } = await bucket.info(item.path);
    const type = info?.contentType ?? "";
    const size = info?.size ?? 0;
    const kind = ASSET_TYPES[type];
    if (!kind || !(size > 0) || size > kind.max || !item.path.endsWith(`.${kind.ext}`)) {
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
    if (!error && data) ids.push(data as string);
  }
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
