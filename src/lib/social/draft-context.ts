import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBrandKit, type Brand } from "../brand/brands";
import { brandBrief, toDesignKit } from "../brand/kit";
import type { BrandKit } from "../design/brands";
import { getAdminClient } from "../supabase/admin";
import { loadLearning } from "./learning";
import { writeMonthPost, type MonthPostInput } from "./month-writer";
import { picturedOnSlides, usedPhotos, type PhotoRole, type ProjectPhoto } from "./month";
import { pickLogoAsset } from "./photo-match";
import { PLAN_KEY, SOCIAL_MODULE, parsePlan, type SocialPlan } from "./plan";
import { writeSlides } from "./slide-writer";
import { publicAssetUrl } from "./worker";
import type { WriteDraftDeps } from "./write-draft";

/**
 * What a person's press needs to have Claude write a draft (server only):
 * the AI allowance left, the brand's voice and kit, the plan, the
 * workspace's photos and which of them posts already use. Read as the
 * member, under RLS; only the stored photos' bytes and the meter go through
 * the service role, as every other draft does.
 */

type Member = Pick<SupabaseClient, "from">;

export const NO_DRAFTING = "Drafting isn't switched on for this environment yet.";
export const ALLOWANCE_USED =
  "You've used this month's AI allowance. It resets next month, or you can upgrade your plan for more.";

/** Drafting needs Claude's key and the service role (to read photos and meter the use). */
export const draftingOn = () =>
  Boolean(process.env.ANTHROPIC_API_KEY && process.env.SUPABASE_SECRET_KEY);

/** This month's AI allowance not yet used. */
export async function allowanceLeft(supabase: Member, tenantId: string, limit: number) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data } = await supabase
    .from("usage_events")
    .select("quantity")
    .eq("tenant_id", tenantId)
    .eq("type", "ai_tokens")
    .gte("occurred_at", monthStart.toISOString());
  const used = (data ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
  return limit - used;
}

/** Records tokens spent, whether or not a draft came back. Never throws. */
export async function meter(tenantId: string, tokens: number) {
  if (!(tokens > 0)) return;
  const { error } = await getAdminClient().rpc("record_usage", {
    p_tenant_id: tenantId,
    p_type: "ai_tokens",
    p_quantity: tokens,
  });
  if (error) console.error(`Could not record AI usage: ${error.message}`);
}

export type LibraryAsset = {
  id: string;
  storage_path: string;
  mime_type: string;
  title: string | null;
  tags: string[] | null;
  project_id: string | null;
  created_at: string;
  taken_at: string | null;
  role: PhotoRole | null;
};

const ASSET_COLUMNS =
  "id, storage_path, mime_type, title, tags, project_id, created_at, taken_at, role";

/** The workspace's photos (not hidden), newest first. */
export async function libraryPhotos(supabase: Member, tenantId: string): Promise<LibraryAsset[]> {
  const { data } = await supabase
    .from("social_assets")
    .select(ASSET_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("hidden", false)
    .like("mime_type", "image/%")
    .order("created_at", { ascending: false })
    .limit(3000);
  return (data ?? []) as LibraryAsset[];
}

export const asProjectPhoto = (asset: LibraryAsset): ProjectPhoto => ({
  id: asset.id,
  projectId: asset.project_id,
  createdAt: asset.created_at,
  takenAt: asset.taken_at,
  role: asset.role,
  mimeType: asset.mime_type,
  tags: asset.tags ?? [],
  hidden: false,
});

/** Every photo a post of the workspace already shows, on it or on its slides. */
export async function photosInUse(
  supabase: Member,
  tenantId: string,
  library: { id: string; storage_path: string }[],
): Promise<Set<string>> {
  const [{ data: posts }, { data: slides }] = await Promise.all([
    supabase
      .from("social_posts")
      .select("asset_id, asset_ids")
      .eq("tenant_id", tenantId)
      .limit(5000),
    supabase
      .from("social_posts")
      .select("slides")
      .eq("tenant_id", tenantId)
      .not("slides", "is", null)
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);
  return usedPhotos(
    (posts ?? []) as { asset_id: string | null; asset_ids: string[] | null }[],
    ((slides ?? []) as { slides: unknown }[]).flatMap((row) =>
      picturedOnSlides(row.slides, library),
    ),
  );
}

export type WritingContext = {
  brand: Brand | null;
  kit: BrandKit | null;
  plan: SocialPlan;
  /** Who the business is and how it sounds, for `MonthPostInput`. */
  voice: Omit<MonthPostInput, "photos" | "topic" | "project">;
};

/** The brand's voice, kit and learning, and the plan. */
export async function writingContext(
  supabase: Member,
  tenant: { id: string; name: string },
  brandId: string | null,
): Promise<WritingContext> {
  const picked = await loadBrandKit(supabase, tenant.id, brandId);
  const [{ data: planRow }, { data: recent }, learning] = await Promise.all([
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", SOCIAL_MODULE)
      .eq("key", PLAN_KEY)
      .maybeSingle(),
    (() => {
      const query = supabase
        .from("social_posts")
        .select("caption")
        .eq("tenant_id", tenant.id)
        .eq("status", "published");
      return (picked.brand ? query.eq("brand_id", picked.brand.id) : query)
        .order("published_at", { ascending: false })
        .limit(5);
    })(),
    loadLearning(supabase, tenant.id, picked.brand),
  ]);
  const plan = parsePlan(planRow?.body);
  return {
    brand: picked.brand,
    kit: picked.kit ? toDesignKit(picked.kit) : null,
    plan,
    voice: {
      business:
        picked.brand && !picked.brand.is_default && picked.brand.name
          ? picked.brand.name
          : tenant.name,
      brand: brandBrief(picked.kit),
      houseStyle: plan.style_notes,
      learned: learning.learned,
      lessons: learning.lessons,
      recent: (recent ?? [])
        .map((row) => String((row as { caption: string }).caption ?? "").slice(0, 600))
        .filter(Boolean),
    },
  };
}

/** A stored photo's bytes, read with the service role from the workspace's own bucket. */
async function loadPhoto(path: string): Promise<Uint8Array | null> {
  const { data, error } = await getAdminClient().storage.from("social").download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/** The writers and file access every press uses. */
export function draftDeps(
  tenantId: string,
  library: {
    id: string;
    storage_path: string;
    mime_type: string;
    title: string | null;
    tags: string[] | null;
  }[],
): WriteDraftDeps {
  const tagged = library.map((asset) => ({
    ...asset,
    title: asset.title ?? "",
    tags: asset.tags ?? [],
    mimeType: asset.mime_type,
  }));
  const logo = (onDark: boolean) => {
    const found = pickLogoAsset(tagged, onDark);
    return found ? publicAssetUrl(found.storage_path) : null;
  };
  return {
    write: (input) => writeMonthPost(input),
    writeSlides: (input) => writeSlides(input),
    loadPhoto,
    assetUrl: publicAssetUrl,
    home: publicAssetUrl(`${tenantId}/`),
    logos: { dark: logo(false), light: logo(true) },
  };
}
