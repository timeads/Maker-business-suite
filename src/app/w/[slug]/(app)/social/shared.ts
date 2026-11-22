import { localDay } from "@/lib/bookings/slots";
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
