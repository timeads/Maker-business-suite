import { localDay } from "@/lib/bookings/slots";
import { PLAN_KEY, SOCIAL_MODULE, parsePlan } from "@/lib/social/plan";
import { publicAssetUrl } from "@/lib/social/worker";
import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** What the composer needs to know about the workspace's Facebook connection. */
export async function socialChannels(supabase: Supabase, tenantId: string) {
  const { data } = await supabase
    .from("connections")
    .select("status, display_name, metadata")
    .eq("tenant_id", tenantId)
    .eq("provider", "meta")
    .maybeSingle();
  const active = data?.status === "active";
  const metadata = (data?.metadata ?? {}) as { instagram_username?: string | null };
  return {
    facebook: active ? String(data?.display_name ?? "your Page").split(" · ")[0] : null,
    instagram: active ? (metadata.instagram_username ?? null) : null,
    needsReconnect: data?.status === "needs_reconnect",
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

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  publishing: "Going out",
  published: "Posted",
  failed: "Didn't post",
};

/** What the composer offers to pick from: recent photos, open projects and the plan's topics. */
export async function composerChoices(supabase: Supabase, tenantId: string, alsoPhotos: string[]) {
  const [{ data: recent }, { data: mine }, { data: projects }, { data: planRow }] =
    await Promise.all([
      supabase
        .from("social_assets")
        .select("id, storage_path, title")
        .eq("tenant_id", tenantId)
        .eq("hidden", false)
        .order("created_at", { ascending: false })
        .limit(64),
      alsoPhotos.length
        ? supabase
            .from("social_assets")
            .select("id, storage_path, title")
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
  const library = [...(mine ?? []), ...(recent ?? [])]
    .filter((photo) => !seen.has(photo.id as string) && seen.add(photo.id as string))
    .map((photo) => ({
      id: photo.id as string,
      url: publicAssetUrl(photo.storage_path as string),
      title: (photo.title as string) ?? "",
    }));
  const plan = parsePlan(planRow?.body);
  return {
    library,
    projects: (projects ?? []) as { id: string; name: string }[],
    topics: plan.topics.map((topic) => ({ id: topic.id, name: topic.name })),
    plan,
  };
}
