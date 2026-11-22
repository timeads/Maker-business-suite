import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { BRAND_MODULE, KIT_KEY, brandKitSchema, parseBrandKit } from "@/lib/brand/kit";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { BrandKit } from "./brand-form";

export const metadata: Metadata = { title: "Brand kit" };

export default async function BrandKitPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ welcome?: string }>;
}) {
  const { slug } = await params;
  const { welcome } = await searchParams;
  const user = await requireUser(`/w/${slug}/settings/brand`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const supabase = await createClient();
  const { data } = await supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", BRAND_MODULE)
    .eq("key", KIT_KEY)
    .maybeSingle();
  const kit = parseBrandKit(data?.body);
  const starter = brandKitSchema.parse({
    version: 1,
    name: ctx.tenant.name,
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
          {welcome && !kit ? `Welcome! Let's set up ${ctx.tenant.name}'s brand` : "Brand kit"}
        </h2>
        <p className="text-muted-foreground max-w-prose text-sm">
          Your colours and the way you sound, kept in one place. Claude reads this before it drafts
          a post, a caption or an email for you, and your designs are drawn from it.
          {!kit && " It takes about two minutes, and you can change it any time."}
        </p>
      </div>
      <BrandKit
        slug={slug}
        kit={kit}
        starter={starter}
        canEdit={canManage(ctx.role)}
        welcome={Boolean(welcome)}
      />
    </div>
  );
}
