import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotNow } from "./items";

/**
 * A tool's "Not now"s, read as the member: owners and admins get them, and
 * row-level security hands anyone else none. A read that fails counts as
 * none, so a checklist never stops a page drawing.
 */
export async function loadNotNow(
  supabase: SupabaseClient,
  tenantId: string,
  tool: string,
): Promise<NotNow[]> {
  const { data, error } = await supabase
    .from("setup_not_now")
    .select("item, fingerprint")
    .eq("tenant_id", tenantId)
    .eq("tool", tool)
    .limit(200);
  if (error) return [];
  return ((data ?? []) as { item: string; fingerprint: string }[]).map((row) => ({
    item: String(row.item),
    fingerprint: String(row.fingerprint),
  }));
}
