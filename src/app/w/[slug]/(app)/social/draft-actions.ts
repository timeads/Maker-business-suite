"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import type { SlideDesign } from "@/lib/design/slide-design";
import { getEntitlements } from "@/lib/entitlements";
import {
  ALLOWANCE_USED,
  NO_DRAFTING,
  allowanceLeft,
  asProjectPhoto,
  draftDeps,
  draftingOn,
  libraryPhotos,
  meter,
  photosInUse,
  writingContext,
  type LibraryAsset,
} from "@/lib/social/draft-context";
import { chooseCarousel, picturedOnSlides, projectTopic } from "@/lib/social/month";
import { matchPhotos } from "@/lib/social/photo-match";
import { openSlots } from "@/lib/social/plan";
import { earlierReadings, writeDraft, type Drafted } from "@/lib/social/write-draft";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";

/**
 * A person's presses that have Claude write a draft: "Draft from this
 * project", "Write it again" (and "Bring this back"), slides from the
 * composer, and marking what a photo is. Every draft is written through
 * `writeDraft` (the monthly run's own path), counted against the AI
 * allowance, and filed only as a draft by a checked database function.
 * Nothing here schedules or posts (CLAUDE.md rule 6).
 */

export type DraftState = {
  error?: string;
  message?: string;
  /** Slides for the composer: the caption and design, not saved yet. */
  draft?: string;
  slides?: SlideDesign;
  missing?: string[];
};

const NO_ACCESS = "Social isn't part of this workspace's plan right now.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const UUID = /^[0-9a-f-]{36}$/i;
const COULDNT = "Claude couldn't draft this one. You can write it yourself.";
const OFFLINE = "Drafting didn't work just now. Please try again.";

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/social`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.social")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  return { user, tenant: ctx.tenant, entitlements, supabase: await createClient() } as const;
}

type Ctx = Exclude<Awaited<ReturnType<typeof context>>, { error: string }>;

/** The context, Claude's key and some allowance left; or why not. */
async function readyToDraft(slug: string): Promise<Ctx | { error: string }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!draftingOn()) return { error: NO_DRAFTING };
  const left = await allowanceLeft(
    ctx.supabase,
    ctx.tenant.id,
    ctx.entitlements.limit("ai_credits"),
  );
  if (left <= 0) return { error: ALLOWANCE_USED };
  return ctx;
}

const done = (slug: string) => revalidatePath(`/w/${slug}/social`, "layout");

// ---------------------------------------------------------------------------
// What a photo is
// ---------------------------------------------------------------------------

/** Marks photos as process shots, finished photos or artwork; "" clears the mark. */
export async function setPhotoRole(slug: string, formData: FormData): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  const ids = formData
    .getAll("asset")
    .map(String)
    .filter((id) => UUID.test(id))
    .slice(0, 100);
  const role = String(formData.get("role") ?? "");
  if (ids.length === 0) return;
  const { error } = await ctx.supabase.rpc("set_social_asset_role", {
    p_tenant_id: ctx.tenant.id,
    p_asset_ids: ids,
    p_role: ["process", "finished", "artwork"].includes(role) ? role : null,
  });
  if (error) console.error(`Photo role not saved: ${error.message}`);
  done(slug);
}

// ---------------------------------------------------------------------------
// "Draft from this project"
// ---------------------------------------------------------------------------

/**
 * Makes a draft from the project's photos no post has used, through the same
 * planning as the monthly run (`chooseCarousel`): a carousel and its caption,
 * or slides over those photos where the project's topic is made as slides.
 * Pencilled in for the next open time of its topic; a person schedules it.
 */
export async function draftFromProject(
  slug: string,
  projectId: string,
  _prev: DraftState,
  formData: FormData,
): Promise<DraftState> {
  if (!UUID.test(projectId)) return { error: "That project wasn't found." };
  const ctx = await readyToDraft(slug);
  if ("error" in ctx) return { error: ctx.error };
  const brandField = String(formData.get("brand_id") ?? "");
  const now = new Date();
  const [{ data: project }, library, writing, { data: upcoming }, { data: earlier }] =
    await Promise.all([
      ctx.supabase
        .from("social_projects")
        .select("id, name, note, topic, archived_at")
        .eq("tenant_id", ctx.tenant.id)
        .eq("id", projectId)
        .maybeSingle(),
      libraryPhotos(ctx.supabase, ctx.tenant.id),
      writingContext(ctx.supabase, ctx.tenant, UUID.test(brandField) ? brandField : null),
      ctx.supabase
        .from("social_posts")
        .select("status, scheduled_for, planned_for, topic")
        .eq("tenant_id", ctx.tenant.id)
        .or(`scheduled_for.gte.${now.toISOString()},planned_for.gte.${now.toISOString()}`)
        .limit(500),
      ctx.supabase
        .from("social_posts")
        .select("project_id, photos_show")
        .eq("tenant_id", ctx.tenant.id)
        .eq("project_id", projectId)
        .not("photos_show", "is", null)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
  if (!project || project.archived_at) {
    return { error: "This project is finished. Open it again to draft from it." };
  }
  const used = await photosInUse(ctx.supabase, ctx.tenant.id, library);
  const own = library.filter((asset) => asset.project_id === projectId);
  const picked = chooseCarousel(own.map(asProjectPhoto), used);
  if (picked.length === 0) {
    return {
      error:
        "This project has fewer than two photos that haven't been posted yet. Add photos, then try again.",
    };
  }
  const byId = new Map(own.map((asset) => [asset.id, asset]));
  const assets = picked.map((photo) => byId.get(photo.id)!).filter(Boolean);
  const { plan } = writing;
  const topicId =
    plan.topics.find((t) => t.id === project.topic)?.id ??
    projectTopic(
      { id: projectId, name: "", note: "", topic: (project.topic as string | null) ?? null },
      plan,
    );
  const topic = plan.topics.find((t) => t.id === topicId) ?? null;
  const open = openSlots(plan, upcoming ?? [], now, 60, ctx.tenant.timezone);
  const slot =
    open.find((s) => topic && s.topic === topic.id) ?? open.find((s) => s.topic === null) ?? null;

  let drafted: Drafted | null;
  try {
    const written = await writeDraft(
      {
        about: {
          ...writing.voice,
          topic: topic ? { name: topic.name, about: topic.about } : null,
          project: {
            name: project.name as string,
            note: (project.note as string | null) ?? "",
            photoCount: assets.length,
            seen:
              earlierReadings(
                (earlier ?? []) as { project_id: string | null; photos_show: string | null }[],
              ).get(projectId) ?? [],
          },
        },
        makes: topic?.makes ?? "caption",
        kit: writing.kit,
        assets,
      },
      draftDeps(ctx.tenant.id, library),
    );
    await meter(ctx.tenant.id, written.tokens);
    drafted = written.draft;
  } catch (err) {
    console.error("Project draft failed", err instanceof Error ? err.message : err);
    return { error: OFFLINE };
  }
  if (!drafted) return { error: COULDNT };

  const { data: id, error } = await ctx.supabase.rpc("file_social_project_draft", {
    p_tenant_id: ctx.tenant.id,
    p_project_id: projectId,
    p_draft: {
      brand_id: writing.brand?.id ?? null,
      caption: drafted.caption,
      asset_ids: drafted.asset_ids,
      pictured_ids: drafted.pictured_ids ?? [],
      slides: drafted.slides ?? null,
      photos_show: drafted.photos_show,
      topic: topic?.id ?? null,
      planned_for: slot?.at ?? null,
    },
  });
  if (error) {
    console.error(`Project draft not filed: ${error.message}`);
    return { error: "The draft didn't save. Please try again." };
  }
  if (!id) {
    return { error: "Those photos were just used for another draft. Open the project again." };
  }
  done(slug);
  redirect(`/w/${slug}/social/${id as string}?drafted=project`);
}

// ---------------------------------------------------------------------------
// "Write it again" and "Bring this back"
// ---------------------------------------------------------------------------

const REDRAFT_ERRORS: Record<string, string> = {
  changed_meanwhile:
    "This draft was changed after you opened it. Reload the page to see the latest, then try again.",
  locked: "This post has gone out (or is going out), so it can't be written again.",
  not_drafted: "Only a draft Claude wrote can be written again.",
};
const redraftWords = (message: string) =>
  Object.entries(REDRAFT_ERRORS).find(([key]) => message.includes(key))?.[1] ??
  "That didn't save. Please try again.";

/**
 * Has Claude write a draft again: words for its photos, or new slides when
 * it has slides. What it said before is kept and can be brought back.
 */
export async function redraftPost(
  slug: string,
  postId: string,
  _prev: DraftState,
  formData: FormData,
): Promise<DraftState> {
  if (!UUID.test(postId)) return { error: "That post wasn't found." };
  const seen = String(formData.get("seen") ?? "");
  const ctx = await readyToDraft(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { data: post } = await ctx.supabase
    .from("social_posts")
    .select(
      "id, status, ai_draft, topic, project_id, brand_id, asset_id, asset_ids, slide_asset_ids, slides, updated_at",
    )
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", postId)
    .maybeSingle();
  if (!post) return { error: "That post wasn't found." };
  if (!post.ai_draft) return { error: REDRAFT_ERRORS.not_drafted };
  if (seen && seen !== post.updated_at) return { error: REDRAFT_ERRORS.changed_meanwhile };

  const [library, writing, { data: project }, { data: earlier }] = await Promise.all([
    libraryPhotos(ctx.supabase, ctx.tenant.id),
    writingContext(ctx.supabase, ctx.tenant, (post.brand_id as string | null) ?? null),
    post.project_id
      ? ctx.supabase
          .from("social_projects")
          .select("id, name, note")
          .eq("tenant_id", ctx.tenant.id)
          .eq("id", post.project_id as string)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    post.project_id
      ? ctx.supabase
          .from("social_posts")
          .select("project_id, photos_show")
          .eq("tenant_id", ctx.tenant.id)
          .eq("project_id", post.project_id as string)
          .neq("id", postId)
          .not("photos_show", "is", null)
          .order("created_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: [] }),
  ]);
  const byId = new Map(library.map((asset) => [asset.id, asset]));
  const slidePictures = new Set((post.slide_asset_ids as string[] | null) ?? []);
  const ownPhotos = ((post.asset_ids as string[] | null) ?? [])
    .filter((id) => !slidePictures.has(id))
    .map((id) => byId.get(id))
    .filter((asset): asset is LibraryAsset => !!asset);
  const makes = post.slides ? "slides" : "caption";
  const topic = writing.plan.topics.find((t) => t.id === post.topic) ?? null;
  let assets = ownPhotos;
  if (makes === "slides") {
    // The photos its slides show now, then its own; else ones whose tags fit the topic.
    const pictured = picturedOnSlides(post.slides, library)
      .map((id) => byId.get(id))
      .filter((asset): asset is LibraryAsset => !!asset);
    assets = [...new Map([...pictured, ...ownPhotos].map((a) => [a.id, a])).values()];
    if (assets.length === 0 && topic) {
      assets = matchPhotos(
        library.map((a) => ({
          ...a,
          title: a.title ?? "",
          tags: a.tags ?? [],
          mimeType: a.mime_type,
        })),
        `${topic.name} ${topic.about}`,
        { limit: 6 },
      ).map((match) => match.asset);
    }
  }

  let drafted: Drafted | null;
  try {
    const written = await writeDraft(
      {
        about: {
          ...writing.voice,
          topic: topic ? { name: topic.name, about: topic.about } : null,
          project: project
            ? {
                name: project.name as string,
                note: (project.note as string | null) ?? "",
                photoCount: assets.length,
                seen:
                  earlierReadings(
                    (earlier ?? []) as { project_id: string | null; photos_show: string | null }[],
                  ).get(project.id as string) ?? [],
              }
            : null,
        },
        makes,
        kit: writing.kit,
        assets,
        slideCount: makes === "slides" ? (post.slides as SlideDesign).slides?.length : undefined,
      },
      draftDeps(ctx.tenant.id, library),
    );
    await meter(ctx.tenant.id, written.tokens);
    drafted = written.draft;
  } catch (err) {
    console.error("Redraft failed", err instanceof Error ? err.message : err);
    return { error: OFFLINE };
  }
  if (!drafted) return { error: COULDNT };

  const { error } = await ctx.supabase.rpc("redraft_social_post", {
    p_tenant_id: ctx.tenant.id,
    p_post_id: postId,
    p_seen: post.updated_at,
    p_draft: {
      caption: drafted.caption,
      photos_show: drafted.photos_show,
      ...(makes === "slides" && drafted.slides ? { slides: drafted.slides } : {}),
    },
  });
  if (error) return { error: redraftWords(error.message) };
  done(slug);
  redirect(`/w/${slug}/social/${postId}?rewritten=1`);
}

/** Brings an earlier version of a draft back; what it says now is kept in its place. */
export async function restoreVersion(
  slug: string,
  postId: string,
  versionId: string,
  _prev: DraftState,
  _formData: FormData,
): Promise<DraftState> {
  if (!UUID.test(postId) || !UUID.test(versionId)) return { error: "That wasn't found." };
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  const { error } = await ctx.supabase.rpc("restore_social_post_version", {
    p_tenant_id: ctx.tenant.id,
    p_version_id: versionId,
  });
  if (error) return { error: redraftWords(error.message) };
  done(slug);
  redirect(`/w/${slug}/social/${postId}?restored=1`);
}

// ---------------------------------------------------------------------------
// Slides from the composer
// ---------------------------------------------------------------------------

/**
 * Has Claude design slides (and their caption) from a few words. The slides
 * and caption land in the composer, unsaved, for the person to change; the
 * photos offered are the chosen project's unposted ones, else the
 * workspace's photos whose tags fit the words.
 */
export async function draftPostSlides(
  slug: string,
  _prev: DraftState,
  formData: FormData,
): Promise<DraftState> {
  const brief = String(formData.get("brief") ?? "")
    .trim()
    .slice(0, 1000);
  if (brief.length < 3) return { error: "Say in a few words what the post is about." };
  const ctx = await readyToDraft(slug);
  if ("error" in ctx) return { error: ctx.error };
  const brandField = String(formData.get("brand_id") ?? "");
  const projectField = String(formData.get("project") ?? "");
  const [library, writing] = await Promise.all([
    libraryPhotos(ctx.supabase, ctx.tenant.id),
    writingContext(ctx.supabase, ctx.tenant, UUID.test(brandField) ? brandField : null),
  ]);
  if (!writing.kit) {
    return {
      error:
        "Set up your brand kit first (Settings → Brand kit): it's what the slides are drawn in.",
    };
  }
  const topic =
    writing.plan.topics.find((t) => t.id === String(formData.get("topic") ?? "")) ?? null;
  let assets: LibraryAsset[] = [];
  let project: { name: string; note: string } | null = null;
  if (UUID.test(projectField)) {
    const { data } = await ctx.supabase
      .from("social_projects")
      .select("name, note")
      .eq("tenant_id", ctx.tenant.id)
      .eq("id", projectField)
      .maybeSingle();
    if (data) {
      project = { name: data.name as string, note: (data.note as string | null) ?? "" };
      const used = await photosInUse(ctx.supabase, ctx.tenant.id, library);
      const own = library.filter((asset) => asset.project_id === projectField);
      const byId = new Map(own.map((asset) => [asset.id, asset]));
      assets = chooseCarousel(own.map(asProjectPhoto), used)
        .map((photo) => byId.get(photo.id))
        .filter((asset): asset is LibraryAsset => !!asset);
    }
  }
  if (assets.length === 0) {
    assets = matchPhotos(
      library.map((a) => ({
        ...a,
        title: a.title ?? "",
        tags: a.tags ?? [],
        mimeType: a.mime_type,
      })),
      `${brief} ${topic ? `${topic.name} ${topic.about}` : ""}`,
      { limit: 6 },
    ).map((match) => match.asset);
  }
  try {
    const written = await writeDraft(
      {
        about: {
          ...writing.voice,
          topic: topic ? { name: topic.name, about: topic.about } : null,
          project: project ? { ...project, photoCount: assets.length } : null,
        },
        makes: "slides",
        kit: writing.kit,
        assets,
        brief,
      },
      draftDeps(ctx.tenant.id, library),
    );
    await meter(ctx.tenant.id, written.tokens);
    if (!written.draft?.slides) return { error: COULDNT };
    return {
      draft: written.draft.caption,
      slides: written.draft.slides,
      missing: written.draft.missing ?? [],
    };
  } catch (err) {
    console.error("Slides draft failed", err instanceof Error ? err.message : err);
    return { error: OFFLINE };
  }
}
