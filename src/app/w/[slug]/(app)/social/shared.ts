import { localDay } from "@/lib/bookings/slots";
import { canPost } from "@/lib/connections/meta-access";
import { loadBrandKit } from "@/lib/brand/brands";
import { toDesignKit } from "@/lib/brand/kit";
import type { BrandKit } from "@/lib/design/brands";
import { matchPhotos } from "@/lib/social/photo-match";
import { PLAN_KEY, SOCIAL_MODULE, parsePlan } from "@/lib/social/plan";
import { REVIEW_KEY, canApprove, canSchedule, parseReview } from "@/lib/social/review";
import type { Role } from "@/lib/tenants";
import { publicAssetUrl } from "@/lib/social/worker";
import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * What the composer needs to know about the workspace's Facebook connection.
 * A place can be posted to only when the connection was granted its posting
 * permission: a workspace that connected for the help desk alone can draft,
 * and is offered "Allow posting" rather than sent to connect again.
 */
export async function socialChannels(supabase: Supabase, tenantId: string) {
  // Named columns only: members can't read the whole row.
  const { data } = await supabase
    .from("connections")
    .select("status, display_name, metadata, scopes")
    .eq("tenant_id", tenantId)
    .eq("provider", "meta")
    .maybeSingle();
  const active = data?.status === "active";
  const scopes = Array.isArray(data?.scopes) ? (data.scopes as string[]) : [];
  const metadata = (data?.metadata ?? {}) as { instagram_username?: string | null };
  const facebook = active && canPost("facebook", scopes);
  return {
    facebook: facebook ? String(data?.display_name ?? "your Page").split(" · ")[0] : null,
    instagram:
      active && canPost("instagram", scopes) ? (metadata.instagram_username ?? null) : null,
    needsReconnect: data?.status === "needs_reconnect",
    /** Connected and live, but without permission to post (connected for the help desk only). */
    needsPosting: active && !facebook,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The date and clock time of an instant in a timezone, for form fields. */
export function localFields(instant: Date, timeZone: string) {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
  return { day: localDay(instant, timeZone), time };
}

/** Tomorrow at 10:00, a sensible first suggestion. */
export function defaultSlot(now: Date, timeZone: string) {
  const [y, m, d] = localDay(now, timeZone).split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    day: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`,
    time: "10:00",
  };
}

/** The workspace's review setting and what this person may do under it. */
export async function reviewFor(supabase: Supabase, tenantId: string, role: Role) {
  const { data } = await supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", tenantId)
    .eq("module", SOCIAL_MODULE)
    .eq("key", REVIEW_KEY)
    .maybeSingle();
  const settings = parseReview(data?.body);
  return {
    settings,
    canApprove: canApprove(role, settings),
    canSchedule: canSchedule(role, settings),
    required: settings.require_approval,
  };
}

/** Words for where a draft is in review. */
export const REVIEW_LABELS: Record<string, string> = {
  waiting: "Waiting for review",
  sent_back: "Sent back",
};

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  publishing: "Going out",
  published: "Posted",
  failed: "Didn't post",
};

/** The workspace's kit as the designer draws with it, or null until a brand kit is set up. */
export async function loadDesignKit(
  supabase: Supabase,
  tenantId: string,
  brandId?: string | null,
): Promise<BrandKit | null> {
  const { kit } = await loadBrandKit(supabase, tenantId, brandId);
  return kit ? toDesignKit(kit) : null;
}

// `designed` is the design's version number when the asset has a design, so the design itself
// (which can be large) is only fetched when someone opens it.
const LIBRARY_COLUMNS = "id, storage_path, title, mime_type, tags, designed:design->v";
type LibraryRow = {
  id: string;
  storage_path: string;
  title: string | null;
  mime_type: string | null;
  tags: string[] | null;
  designed: unknown;
};

/** What the composer offers to pick from: recent photos, open projects and the plan's topics. */
export async function composerChoices(supabase: Supabase, tenantId: string, alsoPhotos: string[]) {
  const [{ data: recent }, { data: mine }, { data: projects }, { data: planRow }] =
    await Promise.all([
      supabase
        .from("social_assets")
        .select(LIBRARY_COLUMNS)
        .eq("tenant_id", tenantId)
        .eq("hidden", false)
        .order("created_at", { ascending: false })
        .limit(64),
      alsoPhotos.length
        ? supabase
            .from("social_assets")
            .select(LIBRARY_COLUMNS)
            .eq("tenant_id", tenantId)
            .in("id", alsoPhotos)
        : Promise.resolve({ data: [] }),
      supabase
        .from("social_projects")
        .select("id, name")
        .eq("tenant_id", tenantId)
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("configs")
        .select("body")
        .eq("tenant_id", tenantId)
        .eq("module", SOCIAL_MODULE)
        .eq("key", PLAN_KEY)
        .maybeSingle(),
    ]);
  const seen = new Set<string>();
  const rows = [...(mine ?? []), ...(recent ?? [])] as unknown as LibraryRow[];
  const library = rows
    .filter((photo) => !seen.has(photo.id) && seen.add(photo.id))
    .map((photo) => ({
      id: photo.id,
      url: publicAssetUrl(photo.storage_path),
      title: photo.title ?? "",
      video: String(photo.mime_type ?? "").startsWith("video/"),
      tags: photo.tags ?? [],
      designed: photo.designed != null,
    }));
  const plan = parsePlan(planRow?.body);
  return {
    library,
    projects: (projects ?? []) as { id: string; name: string }[],
    topics: plan.topics.map((topic) => ({ id: topic.id, name: topic.name })),
    plan,
  };
}

/**
 * Why each photo on a drafted post fits its topic, worked out again from the tags each time
 * the post is opened: the same simple match that picked it, so the note is always true.
 */
export function photoReasons(
  library: { id: string; title: string; tags: string[]; video: boolean }[],
  photoIds: string[],
  about: string,
): Record<string, string> {
  const onPost = library
    .filter((photo) => photoIds.includes(photo.id))
    .map((photo) => ({ ...photo, mimeType: photo.video ? "video/mp4" : "image/jpeg" }));
  return Object.fromEntries(
    matchPhotos(onPost, about, { limit: 10 }).map((match) => [match.asset.id, match.reason]),
  );
}
