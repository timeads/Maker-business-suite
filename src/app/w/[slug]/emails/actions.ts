"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { newWorkspaceEmail, workspaceTemplates } from "@/lib/brand/email";
import { emailFromWriting, logoForHeader, writeEmail } from "@/lib/brand/write-email";
import { loadBrandKit } from "@/lib/brand/brands";
import type { BrandKitConfig } from "@/lib/brand/kit";
import {
  normalizeDoc,
  normalizeSavedSections,
  normalizeTemplates,
  type EmailDoc,
  type EmailTemplate,
  type SavedSection,
} from "@/lib/design";
import { getEntitlements } from "@/lib/entitlements";
import { pickLogoAsset, pickPhoto, type TaggedAsset } from "@/lib/social/photo-match";
import { publicAssetUrl } from "@/lib/social/worker";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type EmailState = { error?: string };

const SOCIAL_MODULE = "social";
const SHARED_KEYS = { sections: "email_sections", templates: "email_templates" } as const;
const UUID = /^[0-9a-f-]{36}$/i;
const NO_ACCESS = "Social isn't part of this workspace's plan right now.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/social/emails`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.social")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  return {
    tenant: ctx.tenant,
    role: ctx.role,
    entitlements,
    supabase: await createClient(),
  } as const;
}
type Ctx = Exclude<Awaited<ReturnType<typeof context>>, { error: string }>;

/** One brand's kit (the default's unless a brand is named). */
async function loadKit(ctx: Ctx, brandId?: string | null): Promise<BrandKitConfig | null> {
  return (await loadBrandKit(ctx.supabase, ctx.tenant.id, brandId)).kit;
}

type Picture = TaggedAsset & { url: string };

/** The workspace's pictures with their names and tags, newest first. Videos and put-away files are left out. */
async function loadPictures(ctx: Ctx): Promise<Picture[]> {
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
    url: publicAssetUrl(row.storage_path as string),
    title: (row.title as string) ?? "",
    tags: (row.tags as string[] | null) ?? [],
    mimeType: row.mime_type as string,
  }));
}

/** The workspace's logos: the assets tagged `logo` and `logo-light`. */
const logosFrom = (pictures: Picture[]) => {
  const onLight = pickLogoAsset(pictures)?.url ?? null;
  const light = pickLogoAsset(pictures, true)?.url ?? null;
  return { onLight, onDark: light === onLight ? null : light };
};

/** Starts a new email from one of the workspace's starters and opens it in the builder. */
export async function createEmail(
  slug: string,
  _prev: EmailState,
  formData: FormData,
): Promise<EmailState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const kit = await loadKit(ctx);
  if (!kit)
    return { error: "Set up your brand kit first, so the email comes out in your colours." };
  const templateId = String(formData.get("template") ?? "") || null;
  const template = workspaceTemplates(kit).find((t) => t.id === templateId);
  const logos = logosFrom(await loadPictures(ctx));
  const plain = newWorkspaceEmail(kit, template?.id ?? null);
  // The workspace's own logo, when one is tagged in its assets, in the copy that reads on the header.
  const logo = logoForHeader(plain, logos);
  const doc = logo ? newWorkspaceEmail(kit, template?.id ?? null, logo) : plain;
  const { data, error } = await ctx.supabase.rpc("save_email", {
    p_tenant_id: ctx.tenant.id,
    p_email_id: null,
    p_doc: doc,
  });
  if (error || !data) {
    return {
      error: error?.message.includes("too_many_emails")
        ? "That's the most emails a workspace can keep. Delete some you no longer need."
        : "We couldn't start that email. Please try again.",
    };
  }
  revalidatePath(`/w/${slug}/social/emails`);
  redirect(`/w/${slug}/emails/${data as string}`);
}

/**
 * Asks Claude to write an email from a sentence, lays it out in the
 * workspace's starter and opens it in the builder as a draft. Nothing is sent.
 */
export async function writeEmailWithClaude(
  slug: string,
  _prev: EmailState,
  formData: FormData,
): Promise<EmailState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "Writing with Claude isn't switched on for this environment yet." };
  }
  const ask = String(formData.get("ask") ?? "")
    .trim()
    .slice(0, 2000);
  if (ask.length < 8) return { error: "Say what the email is about, in a sentence or two." };
  const kit = await loadKit(ctx);
  if (!kit)
    return { error: "Set up your brand kit first, so the email sounds and looks like you." };

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data: usage } = await ctx.supabase
    .from("usage_events")
    .select("quantity")
    .eq("tenant_id", ctx.tenant.id)
    .eq("type", "ai_tokens")
    .gte("occurred_at", monthStart.toISOString());
  const used = (usage ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
  if (used >= ctx.entitlements.limit("ai_credits")) {
    return {
      error:
        "You've used this month's AI allowance. It resets next month, or you can start from a template.",
    };
  }

  let id: string;
  try {
    const draft = await writeEmail({
      kit,
      ask,
      today: new Intl.DateTimeFormat("en-US", {
        timeZone: ctx.tenant.timezone,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(new Date()),
    });
    // Metered whether or not a draft came back: the tokens were spent.
    const { error: usageError } = await getAdminClient().rpc("record_usage", {
      p_tenant_id: ctx.tenant.id,
      p_type: "ai_tokens",
      p_quantity: draft.tokens,
    });
    if (usageError) console.error(`Could not record AI usage: ${usageError.message}`);
    if (!draft.ok) {
      return {
        error:
          "Claude couldn't write this one. Try saying it another way, or start from a template.",
      };
    }
    // A photo to go with the words is chosen from the workspace's own assets by their tags and
    // names: what was asked for, and what the email turned out to be about. Nothing is fetched.
    const pictures = await loadPictures(ctx);
    const about = [
      ask,
      draft.written.subject,
      draft.written.banner.headline,
      ...draft.written.sections.map((section) => section.heading),
    ].join(" ");
    const match = pickPhoto(pictures, about);
    const { data, error } = await ctx.supabase.rpc("save_email", {
      p_tenant_id: ctx.tenant.id,
      p_email_id: null,
      p_doc: emailFromWriting(kit, draft.written, {
        photo: match ? { url: match.asset.url, alt: match.asset.title } : null,
        logos: logosFrom(pictures),
      }),
      p_prompt: ask,
    });
    if (error || !data)
      return { error: "The email was written but couldn't be saved. Please try again." };
    id = data as string;
  } catch (err) {
    console.error(`Email draft failed: ${err instanceof Error ? err.message : "unknown"}`);
    return { error: "Claude isn't answering right now. Try again in a minute." };
  }
  revalidatePath(`/w/${slug}/social/emails`);
  redirect(`/w/${slug}/emails/${id}`);
}

/** Saves the email being edited. The document is tidied and bounded first. */
export async function saveEmailDoc(slug: string, id: string, doc: EmailDoc): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) throw new Error(String(ctx.error));
  if (!UUID.test(id)) throw new Error("Email not found");
  const { error } = await ctx.supabase.rpc("save_email", {
    p_tenant_id: ctx.tenant.id,
    p_email_id: id,
    p_doc: normalizeDoc(doc),
  });
  if (error) throw new Error("The email could not be saved.");
}

export async function copyEmail(slug: string, id: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !UUID.test(id)) return;
  const { data: row } = await ctx.supabase
    .from("emails")
    .select("doc, title")
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", id)
    .maybeSingle();
  if (!row) return;
  const doc = normalizeDoc(row.doc);
  await ctx.supabase.rpc("save_email", {
    p_tenant_id: ctx.tenant.id,
    p_email_id: null,
    p_doc: { ...doc, title: `Copy of ${row.title as string}`.slice(0, 120) },
  });
  revalidatePath(`/w/${slug}/social/emails`);
}

export async function deleteEmail(slug: string, id: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !UUID.test(id)) return;
  await ctx.supabase.rpc("remove_email", { p_tenant_id: ctx.tenant.id, p_email_id: id });
  revalidatePath(`/w/${slug}/social/emails`);
}

async function loadShared(ctx: Ctx, kind: keyof typeof SHARED_KEYS): Promise<unknown> {
  const { data } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", SOCIAL_MODULE)
    .eq("key", SHARED_KEYS[kind])
    .maybeSingle();
  return (data?.body as { items?: unknown } | null)?.items ?? [];
}

async function storeShared(ctx: Ctx, kind: keyof typeof SHARED_KEYS, items: unknown[]) {
  if (!canManage(ctx.role)) throw new Error("Only owners and admins can change these.");
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: SOCIAL_MODULE,
    p_key: SHARED_KEYS[kind],
    p_body: { version: 1, items },
  });
  if (error) throw new Error("That could not be saved.");
}

/** Sections the workspace has kept to use again. */
export async function loadSavedSections(slug: string): Promise<SavedSection[]> {
  const ctx = await context(slug);
  if ("error" in ctx) return [];
  return normalizeSavedSections(await loadShared(ctx, "sections"));
}

export async function storeSavedSections(slug: string, list: SavedSection[]): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) throw new Error(String(ctx.error));
  await storeShared(ctx, "sections", normalizeSavedSections(list));
}

/** Templates the workspace has saved. */
export async function loadTemplates(slug: string): Promise<EmailTemplate[]> {
  const ctx = await context(slug);
  if ("error" in ctx) return [];
  return normalizeTemplates(await loadShared(ctx, "templates"));
}

export async function storeTemplates(slug: string, list: EmailTemplate[]): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) throw new Error(String(ctx.error));
  await storeShared(ctx, "templates", normalizeTemplates(list));
}

/** The workspace's library photos, for the builder's photo picker and the banner designer. */
export async function listPhotos(
  slug: string,
): Promise<{ id: string; url: string; title: string; tags: string[] }[]> {
  const ctx = await context(slug);
  if ("error" in ctx) return [];
  return (await loadPictures(ctx)).map(({ id, url, title, tags }) => ({ id, url, title, tags }));
}

/** The workspace's logos, for the builder's logo block: for light backgrounds and for dark ones. */
export async function loadLogos(
  slug: string,
): Promise<{ onLight: string | null; onDark: string | null }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { onLight: null, onDark: null };
  return logosFrom(await loadPictures(ctx));
}
