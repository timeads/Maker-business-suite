import type { SupabaseClient } from "@supabase/supabase-js";
import type { Brand } from "../brand/brands";
import { SOCIAL_MODULE } from "./plan";
import { editLessons, parseStyleNotes, styleNotesKey, type Lesson } from "./style-notes";

/**
 * What drafting is told about a brand's earlier edits: its style notes and a
 * few recent before-and-after pairs. Read as the member (or by the worker
 * through its own scoped reads). Allowed to fail: drafting goes on without.
 */
export async function loadLearning(
  supabase: Pick<SupabaseClient, "from">,
  tenantId: string,
  brand: Pick<Brand, "id" | "kit_key"> | null,
): Promise<{ learned: string; lessons: Lesson[] }> {
  try {
    const edits = supabase
      .from("social_post_edits")
      .select("before, after")
      .eq("tenant_id", tenantId)
      .order("edited_at", { ascending: false })
      .limit(10);
    const [{ data: notes }, { data: rows }] = await Promise.all([
      supabase
        .from("configs")
        .select("body")
        .eq("tenant_id", tenantId)
        .eq("module", SOCIAL_MODULE)
        .eq("key", styleNotesKey(brand))
        .maybeSingle(),
      brand ? edits.eq("brand_id", brand.id) : edits,
    ]);
    return {
      learned: parseStyleNotes(notes?.body).notes,
      lessons: editLessons((rows ?? []) as { before: string; after: string }[]),
    };
  } catch {
    return { learned: "", lessons: [] };
  }
}
