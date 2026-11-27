import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotNow } from "./items";

/**
 * A tool's "Not now"s, read as the member: owners and admins get them all;
 * the rest of the team gets Stock's and Shipping's for the tools they have,
 * and never Money's (row-level security decides). A read that fails counts
 * as none, so a checklist never stops a page drawing.
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
