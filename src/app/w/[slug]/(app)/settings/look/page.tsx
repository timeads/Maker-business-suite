import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/settings/section-heading";
import { requireUser } from "@/lib/auth";
import { APPEARANCE_KEY, parseAppearance } from "@/lib/brand/appearance";
import { loadBrands, pickBrand } from "@/lib/brand/brands";
import { BRAND_MODULE, KIT_KEY, parseBrandKit } from "@/lib/brand/kit";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { AppearanceForm } from "../brand/brand-form";

export const metadata: Metadata = { title: "Look" };

/** Light or dark, and whether the menu and buttons wear the brand kit's colours. */
export default async function LookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings/look`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("configs")
    .select("key, body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", BRAND_MODULE);
  const body = (key: string) => (rows ?? []).find((row) => row.key === key)?.body;
  // The menu and buttons wear the default brand's colours.
  const brand = pickBrand(await loadBrands(supabase, ctx.tenant.id));
  const kit = parseBrandKit(body(brand?.kit_key ?? KIT_KEY));
  const look = parseAppearance(body(APPEARANCE_KEY));

  return (
    <>
      <SectionHeading
        title="Look"
        description="How this workspace looks for everyone in it: light or dark, and your own colours on the menu and buttons."
      />
      <AppearanceForm slug={slug} look={look} hasKit={Boolean(kit)} canEdit={canManage(ctx.role)} />
    </>
  );
}
