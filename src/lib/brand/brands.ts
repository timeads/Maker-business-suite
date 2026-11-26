import type { SupabaseClient } from "@supabase/supabase-js";
import { BRAND_MODULE, KIT_KEY, parseBrandKit, type BrandKitConfig } from "./kit";

/**
 * A workspace's brands. The identity (name, slug, which is the default,
 * archived or not) is the `brands` table, so posts and social accounts can
 * point at one; each brand's look and voice is still a kit in `configs`
 * (module "brand"): the first brand's under the key "kit", every other
 * brand's under "kit-<brand id>". A workspace with one brand reads and
 * writes exactly what it did before brands were a list.
 */
export type Brand = {
  id: string;
  name: string;
  slug: string;
  kit_key: string;
  is_default: boolean;
  archived_at: string | null;
};

export const BRAND_COLUMNS = "id, name, slug, kit_key, is_default, archived_at";

/** The kit key of a brand other than the first: "kit-<id>". */
export const brandKitKey = (brandId: string) => `kit-${brandId}`;

/** Whether a `configs` key (module "brand") is a brand's kit. */
export const isKitKey = (key: unknown): key is string =>
  typeof key === "string" && (key === KIT_KEY || /^kit-[0-9a-f-]{36}$/.test(key));

/** Live brands first (the default at the top), then the put-away ones. */
export function sortBrands<T extends Pick<Brand, "is_default" | "archived_at" | "name">>(
  brands: readonly T[],
): T[] {
  return [...brands].sort(
    (a, b) =>
      Number(Boolean(a.archived_at)) - Number(Boolean(b.archived_at)) ||
      Number(b.is_default) - Number(a.is_default) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Which brand a page or action means: the one named, if it is one of the
 * workspace's live brands, else the default (else the first live one).
 * Never an archived brand unless it was named.
 */
export function pickBrand<T extends Pick<Brand, "id" | "is_default" | "archived_at">>(
  brands: readonly T[],
  wanted?: string | null,
): T | null {
  const named = wanted ? brands.find((brand) => brand.id === wanted) : undefined;
  if (named) return named;
  return (
    brands.find((brand) => brand.is_default) ??
    brands.find((brand) => !brand.archived_at) ??
    brands[0] ??
    null
  );
}

/** The member's own client (or the admin client, for code that already named the workspace). */
type Reader = Pick<SupabaseClient, "from">;

/** The workspace's brands, as the member may read them. Empty when they can't be read. */
export async function loadBrands(supabase: Reader, tenantId: string): Promise<Brand[]> {
  const { data, error } = await supabase
    .from("brands")
    .select(BRAND_COLUMNS)
    .eq("tenant_id", tenantId);
  if (error || !Array.isArray(data)) return [];
  return sortBrands(data as Brand[]);
}

/**
 * One brand's kit: the brand named, else the default. A workspace whose
 * brands can't be read (or have no row yet) gets the first kit, "kit", as
 * before brands were a list.
 */
export async function loadBrandKit(
  supabase: Reader,
  tenantId: string,
  brandId?: string | null,
): Promise<{ brand: Brand | null; kit: BrandKitConfig | null }> {
  const brand = pickBrand(await loadBrands(supabase, tenantId), brandId);
  const key = brand?.kit_key ?? KIT_KEY;
  const { data } = await supabase
    .from("configs")
    .select("key, body")
    .eq("tenant_id", tenantId)
    .eq("module", BRAND_MODULE);
  const row = Array.isArray(data)
    ? (data as { key: string; body: unknown }[]).find((each) => each.key === key)
    : undefined;
  return { brand, kit: parseBrandKit(row?.body) };
}
