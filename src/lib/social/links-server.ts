import type { SupabaseClient } from "@supabase/supabase-js";
import { moduleOpen } from "../module-access";
import { getAdminClient, withTenant } from "../supabase/admin";
import { LINKS_KEY, SOCIAL_MODULE, parseLinkPage, type LinkPage } from "./plan";
import { publicAssetUrl } from "./worker";

export type PublicLinkPage = {
  name: string;
  page: LinkPage;
  /** The first photo of each recent post, newest first. */
  photos: string[];
};

/**
 * A workspace's public link page, or null when there's no such workspace,
 * Social isn't on its plan, or the page isn't published. The page has no
 * database access of its own: it reads through here, naming the workspace.
 */
export async function getPublicLinkPage(
  slug: string,
  admin: SupabaseClient = getAdminClient(),
): Promise<PublicLinkPage | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const { data: tenant } = await admin
    .from("tenants")
    .select("id, name")
    .eq("slug", slug)
    .maybeSingle();
  if (!tenant || !(await moduleOpen(tenant.id as string, "social", admin))) return null;
  return withTenant(
    tenant.id as string,
    async (scope) => {
      const { data: config } = await scope
        .select("configs", "body")
        .eq("module", SOCIAL_MODULE)
        .eq("key", LINKS_KEY)
        .maybeSingle();
      const page = parseLinkPage((config as { body?: unknown } | null)?.body);
      if (!page.published) return null;
      let photos: string[] = [];
      if (page.show_posts) {
        const { data: posts } = await scope
          .select("social_posts", "asset_id")
          .eq("status", "published")
          .not("asset_id", "is", null)
          .order("published_at", { ascending: false })
          .limit(9);
        const ids = ((posts ?? []) as unknown as { asset_id: string }[]).map((p) => p.asset_id);
        if (ids.length > 0) {
          const { data: assets } = await scope
            .select("social_assets", "id, storage_path")
            .in("id", ids);
          const paths = new Map(
            ((assets ?? []) as unknown as { id: string; storage_path: string }[]).map((a) => [
              a.id,
              a.storage_path,
            ]),
          );
          photos = ids.flatMap((id) => (paths.has(id) ? [publicAssetUrl(paths.get(id)!)] : []));
        }
      }
      return { name: tenant.name as string, page, photos };
    },
    admin,
  );
}
