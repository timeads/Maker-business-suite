"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { parseClock, zonedTimeToUtc } from "@/lib/bookings/slots";
import { getEntitlements } from "@/lib/entitlements";
import { draftCaption } from "@/lib/social/caption";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";

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
};

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/social`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.social")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  return { user, tenant: ctx.tenant, entitlements, supabase: await createClient() } as const;
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

  // The photo: a new upload, the one already on the post, or none.
  let assetId: string | null = String(formData.get("asset_id") ?? "") || null;
  let mime = String(formData.get("asset_mime") ?? "");
  if (formData.get("remove_photo") === "on") assetId = null;
  const photo = formData.get("photo");
  if (photo instanceof File && photo.size > 0) {
    if (photo.type !== "image/jpeg" && photo.type !== "image/png") {
      return { error: "Photos need to be JPEG or PNG files." };
    }
    if (photo.size > MAX_PHOTO_BYTES) return { error: "Photos can be up to 5 MB." };
    if (!process.env.SUPABASE_SECRET_KEY) {
      return { error: "Photo uploads aren't switched on for this environment yet." };
    }
    const admin = getAdminClient();
    const path = `${ctx.tenant.id}/${randomUUID()}.${photo.type === "image/png" ? "png" : "jpg"}`;
    const { error: uploadError } = await admin.storage
      .from("social")
      .upload(path, photo, { contentType: photo.type });
    if (uploadError) {
      console.error(`Photo upload failed: ${uploadError.message}`);
      return { error: "The photo didn't upload. Please try again." };
    }
    const { data: registered, error: registerError } = await admin.rpc("register_social_asset", {
      p_tenant_id: ctx.tenant.id,
      p_storage_path: path,
      p_mime_type: photo.type,
      p_bytes: photo.size,
      p_created_by: ctx.user.id,
    });
    if (registerError) return { error: "The photo didn't upload. Please try again." };
    assetId = registered as string;
    mime = photo.type;
  }
  if (scheduledFor && assetId && channels.includes("instagram") && mime === "image/png") {
    return { error: "Instagram only takes JPEG photos. Swap the photo or untick Instagram." };
  }

  const { error } = await ctx.supabase.rpc("save_social_post", {
    p_tenant_id: ctx.tenant.id,
    p_post_id: postId,
    p_caption: caption,
    p_asset_id: assetId,
    p_channels: channels,
    p_scheduled_for: scheduledFor,
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
  const [{ data: usage }, { data: recent }] = await Promise.all([
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
