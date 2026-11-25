"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { HELPDESK_MODULE } from "@/lib/helpdesk/config";
import { sniffType } from "@/lib/helpdesk/files";
import {
  HELP_CENTRE_KEY,
  SLUG_PATTERN,
  categoriesFrom,
  helpCentreConfigSchema,
  parseHelpCentre,
  tidySlug,
} from "@/lib/helpdesk/help-centre/config";
import { askForArticleDraft, tidyArticleDraft } from "@/lib/helpdesk/help-centre/draft";
import { HELP_BUCKET } from "@/lib/helpdesk/help-centre/public";
import { helpCentreTag } from "@/lib/helpdesk/help-centre-server";
import { loadArticle, loadTopic } from "@/lib/helpdesk/manual/data";
import { scrub, scrubDoc } from "@/lib/helpdesk/manual/scrub";
import { docText } from "@/lib/helpdesk/manual/sections";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import type { ManualState } from "./actions";

/**
 * The help centre's side of the manual: making an article public, its
 * address and pictures, the help centre's own settings, and a draft written
 * by Claude. Each action checks who is asking; the database checks again.
 * Anything that changes what a visitor sees clears the public pages' cache.
 */

const NO_ACCESS = "The help desk isn't part of this workspace's plan right now.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const TRY_AGAIN = "That didn't save. Try again in a moment.";
const MANAGERS = "Only owners and admins can do that.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/helpdesk/manual/kb`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.helpdesk")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  return {
    user,
    tenant: ctx.tenant,
    role: ctx.role,
    entitlements,
    supabase: await createClient(),
  } as const;
}

const kb = (slug: string) => `/w/${slug}/helpdesk/manual/kb`;
const refresh = (slug: string) => {
  revalidatePath(`/w/${slug}/helpdesk/manual`, "layout");
  revalidatePath(`/w/${slug}/helpdesk`);
  updateTag(helpCentreTag(slug));
};

// ---------------------------------------------------------------------------
// Public state, address, category, summary
// ---------------------------------------------------------------------------

/** internal → draft → published, and back. Owners and admins; the database checks again. */
export async function setArticlePublicState(
  slug: string,
  articleId: string,
  state: "internal" | "draft" | "published",
): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !canManage(ctx.role) || !UUID.test(articleId)) return;
  await ctx.supabase.rpc("set_help_article_state", {
    p_tenant_id: ctx.tenant.id,
    p_article_id: articleId,
    p_state: state,
  });
  refresh(slug);
}

const DETAIL_ERRORS: Record<string, string> = {
  slug_taken: "Another article has, or used to have, that address. Pick a different one.",
  bad_slug: "An address is lower-case letters and numbers with dashes between, like care-guide.",
  bad_category: "That category isn't one of yours any more. Pick another.",
  "Only owners and admins": "Only owners and admins can change a published article.",
  not_found: "That article couldn't be found.",
};

/** The article's address, category and the line shown in lists. */
export async function saveArticleDetails(
  slug: string,
  articleId: string,
  _prev: ManualState,
  formData: FormData,
): Promise<ManualState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!UUID.test(articleId)) return { error: DETAIL_ERRORS.not_found };
  const typed = String(formData.get("slug") ?? "").trim();
  const wanted = typed ? tidySlug(typed) : "";
  if (typed && !SLUG_PATTERN.test(wanted)) return { error: DETAIL_ERRORS.bad_slug };
  const { error } = await ctx.supabase.rpc("save_help_article_details", {
    p_tenant_id: ctx.tenant.id,
    p_article_id: articleId,
    p_slug: wanted || null,
    p_category: String(formData.get("category") ?? "").trim() || null,
    p_summary: String(formData.get("summary") ?? ""),
  });
  if (error) {
    const known = Object.keys(DETAIL_ERRORS).find((key) => error.message.includes(key));
    return { error: known ? DETAIL_ERRORS[known] : TRY_AGAIN };
  }
  refresh(slug);
  return { message: "Saved." };
}

/**
 * "Make a help article from this topic": copies the topic's words into a new
 * public DRAFT and opens it for editing. A copy, with no tie between the
 * two: later changes to the topic don't reach the article. Customers' photos
 * on the topic are not copied.
 */
export async function makeArticleFromTopic(slug: string, topicId: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !canManage(ctx.role)) return;
  const topic = await loadTopic(ctx.supabase, ctx.tenant.id, topicId);
  if (!topic) return;
  const { data, error } = await ctx.supabase.rpc("start_help_article", {
    p_tenant_id: ctx.tenant.id,
    p_title: topic.title,
    p_summary: scrub(topic.summary).slice(0, 300),
    // The topic was scrubbed when it was written; once more before it heads for a public page.
    p_body: scrubDoc(topic.body),
  });
  if (error || !data) return;
  refresh(slug);
  redirect(`${kb(slug)}/${data}?edit=1`);
}

/**
 * "Draft a help article with Claude": the topic rewritten for customers, as
 * a DRAFT. Counted against the month's AI allowance. Nothing is published.
 */
export async function draftArticleFromTopic(
  slug: string,
  topicId: string,
  _prev: ManualState,
): Promise<ManualState> {
  void _prev;
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!canManage(ctx.role)) return { error: MANAGERS };
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "Writing with Claude isn't switched on for this environment yet." };
  }
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [topic, { data: usage }] = await Promise.all([
    loadTopic(ctx.supabase, ctx.tenant.id, topicId),
    ctx.supabase
      .from("usage_events")
      .select("quantity")
      .eq("tenant_id", ctx.tenant.id)
      .eq("type", "ai_tokens")
      .gte("occurred_at", monthStart.toISOString()),
  ]);
  if (!topic) return { error: "That topic couldn't be found." };
  const text = scrub(docText(topic.body));
  if (text.trim().length < 40) return { error: "There isn't enough written in this topic yet." };
  const used = (usage ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
  if (used >= ctx.entitlements.limit("ai_credits")) {
    return {
      error:
        "You've used this month's AI allowance. It resets next month, or you can upgrade your plan for more.",
    };
  }
  let articleId: string | null = null;
  try {
    const result = await askForArticleDraft({
      business: ctx.tenant.name,
      title: scrub(topic.title),
      summary: scrub(topic.summary),
      text,
    });
    const { error: usageError } = await getAdminClient().rpc("record_usage", {
      p_tenant_id: ctx.tenant.id,
      p_type: "ai_tokens",
      p_quantity: result.tokens,
    });
    if (usageError) console.error(`Could not record AI usage: ${usageError.message}`);
    const draft = result.ok ? tidyArticleDraft(result.draft) : null;
    if (!draft) return { error: "Claude couldn't make an article out of this one." };
    const { data, error } = await ctx.supabase.rpc("start_help_article", {
      p_tenant_id: ctx.tenant.id,
      p_title: draft.title,
      p_summary: draft.summary,
      p_body: draft.body,
    });
    if (error || !data) return { error: TRY_AGAIN };
    articleId = data as string;
  } catch (err) {
    console.error("Article draft failed", err instanceof Error ? err.message : err);
    return { error: "We couldn't get a draft just now. Try again in a moment." };
  }
  refresh(slug);
  redirect(`${kb(slug)}/${articleId}`);
}

// ---------------------------------------------------------------------------
// An article's own pictures
// ---------------------------------------------------------------------------

const PICTURE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

/** Whether this person may change this article: anyone until it is published, then managers. */
type Ctx = Exclude<Awaited<ReturnType<typeof context>>, { error: string }>;
async function editableArticle(ctx: Ctx, id: string) {
  if (!UUID.test(id)) return null;
  const article = await loadArticle(ctx.supabase, ctx.tenant.id, id);
  if (!article) return null;
  if (article.publicState === "published" && !canManage(ctx.role)) return null;
  return article;
}

export type PictureTicket = { path: string; token: string };

/**
 * Hands the browser a one-time link to send one picture straight to the
 * public bucket, under this workspace and article. Nothing is on the article
 * until `finishArticlePicture` has looked at what actually arrived.
 */
export async function startArticlePicture(
  slug: string,
  articleId: string,
  file: { type: string; size: number },
): Promise<{ ticket: PictureTicket } | { error: string }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!process.env.SUPABASE_SECRET_KEY) {
    return { error: "Uploads aren't switched on for this environment yet." };
  }
  const article = await editableArticle(ctx, articleId);
  if (!article) return { error: "Only owners and admins can add pictures to a published article." };
  const ext = PICTURE_TYPES[String(file?.type)];
  if (!ext) return { error: "Pictures need to be JPEG, PNG, WebP or GIF." };
  if (!(file.size > 0) || file.size > MAX_PICTURE_BYTES) {
    return { error: "Pictures can be up to 8 MB each." };
  }
  const path = `${ctx.tenant.id}/${article.id}/${randomUUID()}.${ext}`;
  const { data, error } = await getAdminClient()
    .storage.from(HELP_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) {
    console.error(`Upload link failed: ${error?.message ?? "no data"}`);
    return { error: "We couldn't start the upload. Please try again." };
  }
  return { ticket: { path, token: data.token } };
}

/**
 * Looks at the file the browser says it sent: it must sit under this
 * workspace and article, and its own first bytes must say it is a picture of
 * the kind its name claims, within the size limit. Only then is it listed
 * on the article. Anything else is taken back out of storage.
 */
export async function finishArticlePicture(
  slug: string,
  articleId: string,
  path: string,
): Promise<{ ok: true } | { error: string }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!process.env.SUPABASE_SECRET_KEY) {
    return { error: "Uploads aren't switched on for this environment yet." };
  }
  const article = await editableArticle(ctx, articleId);
  if (!article) return { error: "Only owners and admins can add pictures to a published article." };
  const mine = new RegExp(`^${ctx.tenant.id}/${article.id}/[0-9a-f-]{36}\\.(jpg|png|webp|gif)$`);
  if (typeof path !== "string" || !mine.test(path)) return { error: "That file didn't arrive." };
  const admin = getAdminClient();
  const bucket = admin.storage.from(HELP_BUCKET);
  const refuse = async (error: string) => {
    await bucket.remove([path]);
    return { error };
  };
  const { data: blob } = await bucket.download(path);
  if (!blob) return { error: "That file didn't arrive. Please try again." };
  if (!(blob.size > 0) || blob.size > MAX_PICTURE_BYTES) {
    return refuse("Pictures can be up to 8 MB each.");
  }
  const type = sniffType(new Uint8Array(await blob.slice(0, 64).arrayBuffer()));
  if (!type || PICTURE_TYPES[type] === undefined || !path.endsWith(`.${PICTURE_TYPES[type]}`)) {
    return refuse("That file isn't a picture we can show. Use a JPEG, PNG, WebP or GIF.");
  }
  const { error } = await admin.rpc("register_help_article_picture", {
    p_tenant_id: ctx.tenant.id,
    p_article_id: article.id,
    p_user: ctx.user.id,
    p_storage_path: path,
    p_mime_type: type,
    p_bytes: blob.size,
  });
  if (error) {
    return refuse(
      error.message.includes("too_many_pictures")
        ? "An article can carry up to twelve pictures."
        : "That picture couldn't be added. Try again in a moment.",
    );
  }
  refresh(slug);
  return { ok: true };
}

/** What a picture shows, its caption, and the heading it sits under. */
export async function saveArticlePicture(
  slug: string,
  pictureId: string,
  _prev: ManualState,
  formData: FormData,
): Promise<ManualState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!UUID.test(pictureId)) return { error: TRY_AGAIN };
  const position = Number(formData.get("position"));
  const { error } = await ctx.supabase.rpc("save_help_article_picture", {
    p_tenant_id: ctx.tenant.id,
    p_picture_id: pictureId,
    p_alt: String(formData.get("alt") ?? ""),
    p_caption: String(formData.get("caption") ?? ""),
    p_section: String(formData.get("section") ?? ""),
    p_position: Number.isInteger(position) && position >= 0 && position < 1000 ? position : null,
  });
  if (error) {
    return {
      error: error.message.includes("Only owners and admins")
        ? "Only owners and admins can change a published article."
        : TRY_AGAIN,
    };
  }
  refresh(slug);
  return { message: "Saved." };
}

export async function removeArticlePicture(slug: string, pictureId: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !UUID.test(pictureId)) return;
  await ctx.supabase.rpc("remove_help_article_picture", {
    p_tenant_id: ctx.tenant.id,
    p_picture_id: pictureId,
  });
  refresh(slug);
}

// ---------------------------------------------------------------------------
// Settings → Help desk → Help centre
// ---------------------------------------------------------------------------

export async function saveHelpCentreSettings(
  slug: string,
  _prev: ManualState,
  formData: FormData,
): Promise<ManualState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!canManage(ctx.role)) {
    return { error: "Only owners and admins can change help desk settings." };
  }
  const { data: current } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", HELPDESK_MODULE)
    .eq("key", HELP_CENTRE_KEY)
    .maybeSingle();
  const now = parseHelpCentre(current?.body);
  const parsed = helpCentreConfigSchema.safeParse({
    version: 1,
    on: formData.get("on") === "1",
    title: String(formData.get("title") ?? ""),
    intro: String(formData.get("intro") ?? ""),
    categories: categoriesFrom(
      String(formData.get("categories") ?? "").split("\n"),
      now.categories,
    ),
    contact_line: String(formData.get("contact_line") ?? "").trim() || undefined,
    contact_email: String(formData.get("contact_email") ?? "").trim(),
    noindex: formData.get("noindex") === "1",
  });
  if (!parsed.success) {
    const where = String(parsed.error.issues[0]?.path[0] ?? "");
    const words: Record<string, string> = {
      title: "The title can be up to 60 characters, without < or >.",
      intro: "Keep the line under the title to 200 characters, without < or >.",
      categories: "Up to twelve categories, each different and up to 40 characters.",
      contact_line: "Keep the contact line under 160 characters, without < or >.",
      contact_email: "That contact address doesn't look like an email address.",
    };
    return { error: words[where] ?? "Something there isn't in a shape we can save." };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: HELPDESK_MODULE,
    p_key: HELP_CENTRE_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: "We couldn't save that. Try again in a moment." };
  revalidatePath(`/w/${slug}`, "layout");
  updateTag(helpCentreTag(slug));
  return { message: parsed.data.on ? "Saved. Your help centre is on." : "Saved." };
}
