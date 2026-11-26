import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { workspaceTemplates } from "@/lib/brand/email";
import { loadBrandKit, loadBrands, pickBrand } from "@/lib/brand/brands";
import { toDesignKit } from "@/lib/brand/kit";
import { normalizeDoc } from "@/lib/design";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { loadLogos } from "../actions";
import { BuilderMount } from "./mount";

export const metadata: Metadata = { title: "Email builder" };

/** One email, open in the drag-and-drop builder. It takes the whole window. */
export default async function EmailBuilderPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const back = `/w/${slug}/social/emails`;
  const user = await requireUser(`/w/${slug}/emails/${id}`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.social") || !entitlements.canWrite) redirect(back);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createClient();
  const [{ data: row }, brands, logos] = await Promise.all([
    supabase
      .from("emails")
      .select("id, doc, brand_id")
      .eq("tenant_id", ctx.tenant.id)
      .eq("id", id)
      .maybeSingle(),
    loadBrands(supabase, ctx.tenant.id),
    loadLogos(slug),
  ]);
  if (!row) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p>This email was not found. It may have been deleted.</p>
        <Link href={back} className="text-ochre-text hover:underline">
          Back to emails
        </Link>
      </div>
    );
  }
  // Drawn in the email's own brand (the main brand's, for one from before brands).
  const { kit } = await loadBrandKit(
    supabase,
    ctx.tenant.id,
    pickBrand(brands, (row.brand_id as string | null) ?? null)?.id,
  );
  return (
    <BuilderMount
      key={row.id as string}
      slug={slug}
      id={row.id as string}
      initial={normalizeDoc(row.doc)}
      brandName={kit?.name ?? ctx.tenant.name}
      swatches={kit?.colors ?? []}
      starters={kit ? workspaceTemplates(kit) : []}
      kit={kit ? toDesignKit(kit) : null}
      logos={logos}
      canKeepShared={canManage(ctx.role)}
    />
  );
}
