import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { loadBrandKit, loadBrands, pickBrand } from "@/lib/brand/brands";
import { brandKitSchema } from "@/lib/brand/kit";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { BrandKit } from "./brand-form";
import { BrandList } from "./brand-list";

export const metadata: Metadata = { title: "Brand kit" };

export default async function BrandKitPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ welcome?: string; brand?: string }>;
}) {
  const { slug } = await params;
  const { welcome, brand: wanted } = await searchParams;
  const user = await requireUser(`/w/${slug}/settings/brand`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const supabase = await createClient();
  const [brands, entitlements, { data: accountRows }] = await Promise.all([
    loadBrands(supabase, ctx.tenant.id),
    getEntitlements(ctx.tenant.id),
    supabase
      .from("social_accounts")
      .select("brand_id")
      .eq("tenant_id", ctx.tenant.id)
      .eq("active", true),
  ]);
  const brand = pickBrand(brands, wanted);
  const { kit } = await loadBrandKit(supabase, ctx.tenant.id, brand?.id);
  const accounts: Record<string, number> = {};
  for (const row of (accountRows ?? []) as { brand_id: string }[]) {
    accounts[row.brand_id] = (accounts[row.brand_id] ?? 0) + 1;
  }
  const many = brands.length > 1;
  const starter = brandKitSchema.parse({
    version: 1,
    name: brand?.name ?? ctx.tenant.name,
    colors: [
      { name: "ink", hex: "#1f2a2e" },
      { name: "paper", hex: "#f7f3ea" },
      { name: "accent", hex: "#c8742a" },
    ],
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">
          {welcome && !kit
            ? `Welcome! Let's set up ${ctx.tenant.name}'s brand`
            : many && brand
              ? `Brand kit: ${brand.name}`
              : "Brand kit"}
        </h2>
        <p className="text-muted-foreground max-w-prose text-sm">
          Your colours and the way you sound, kept in one place. Claude reads this before it drafts
          a post, a caption or an email for you, and your designs are drawn from it.
          {!kit && " It takes about two minutes, and you can change it any time."}
        </p>
      </div>
      <BrandKit
        key={brand?.id ?? "main"}
        slug={slug}
        brandId={brand?.id ?? null}
        kit={kit}
        starter={starter}
        canEdit={canManage(ctx.role)}
        welcome={Boolean(welcome)}
      />
      <BrandList
        slug={slug}
        brands={brands}
        current={brand?.id ?? null}
        canEdit={canManage(ctx.role)}
        limit={Math.max(1, entitlements.limit("brands"))}
        accounts={accounts}
      />
    </div>
  );
}
