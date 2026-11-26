import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeading } from "@/components/settings/section-heading";
import { loadBrands, pickBrand } from "@/lib/brand/brands";
import { SOCIAL_MODULE } from "@/lib/social/plan";
import { parseStyleNotes, styleNotesKey } from "@/lib/social/style-notes";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { socialAccess } from "../../../social/gate";
import { StyleNotesForm } from "../../../social/month-forms";

export const metadata: Metadata = { title: "Style notes" };

type Edit = { id: string; before: string; after: string; edited_at: string };

/**
 * Settings → Social & emails → Style notes: what Claude has learned from how
 * a brand's drafts were changed, as plain notes a person reads and edits.
 * Owners and admins change them; everyone can read them.
 */
export default async function StyleNotesSettings({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ brand?: string }>;
}) {
  const { slug } = await params;
  const { brand: wanted } = await searchParams;
  const access = await socialAccess(slug, `/w/${slug}/settings/social/style`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const supabase = await createClient();
  const brands = (await loadBrands(supabase, tenant.id)).filter((b) => !b.archived_at);
  const brand = pickBrand(brands, wanted ?? null);
  let edits = supabase
    .from("social_post_edits")
    .select("id, before, after, edited_at")
    .eq("tenant_id", tenant.id)
    .order("edited_at", { ascending: false })
    .limit(5);
  if (brand) edits = edits.eq("brand_id", brand.id);
  const [{ data: config }, { data: editRows }, { count }] = await Promise.all([
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", SOCIAL_MODULE)
      .eq("key", styleNotesKey(brand))
      .maybeSingle(),
    edits,
    supabase
      .from("social_post_edits")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id),
  ]);
  const notes = parseStyleNotes(config?.body).notes;
  const canEdit = canManage(role) && entitlements.canWrite;
  const canSuggest = Boolean(process.env.ANTHROPIC_API_KEY && process.env.SUPABASE_SECRET_KEY);
  const recent = (editRows ?? []) as Edit[];

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/social/plan`, label: "Social" }}
        title="Style notes"
        description="What Claude has learned from how you change its drafts. It reads these before every draft."
      />
      {brands.length > 1 && (
        <nav aria-label="Brand" className="flex flex-wrap gap-2 text-sm">
          {brands.map((b) => (
            <Link
              key={b.id}
              href={`/w/${tenant.slug}/settings/social/style?brand=${b.id}`}
              aria-current={b.id === brand?.id ? "page" : undefined}
              className={
                b.id === brand?.id
                  ? "bg-teal-soft text-teal-soft-ink rounded-full px-3 py-1 font-semibold"
                  : "text-muted-foreground hover:text-foreground rounded-full px-3 py-1"
              }
            >
              {b.name}
            </Link>
          ))}
        </nav>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            {brands.length > 1 && brand ? `${brand.name}'s notes` : "Your notes"}
          </CardTitle>
          <CardDescription>
            When you change a caption Claude drafted, we keep what it wrote beside what you posted.
            Ask for suggestions from those edits, keep what rings true, and save.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <StyleNotesForm
              key={brand?.id ?? "main"}
              slug={tenant.slug}
              brandId={brand?.id ?? ""}
              notes={notes}
              canSuggest={canSuggest}
            />
          ) : notes ? (
            <p className="font-read text-sm whitespace-pre-line">{notes}</p>
          ) : (
            <p className="text-muted-foreground text-sm">
              Nothing noted yet. An owner or admin can add notes here.
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent edits</CardTitle>
          <CardDescription>
            {count
              ? `${count} edited ${count === 1 ? "draft" : "drafts"} kept so far. The latest:`
              : "None yet. Change a caption Claude drafted and it shows up here."}
          </CardDescription>
        </CardHeader>
        {recent.length > 0 && (
          <CardContent>
            <ul className="divide-border flex flex-col divide-y">
              {recent.map((edit) => (
                <li key={edit.id} className="grid gap-2 py-3 sm:grid-cols-2">
                  <div>
                    <p className="text-muted-foreground text-xs font-semibold">Claude wrote</p>
                    <p className="font-read text-sm whitespace-pre-line">
                      {edit.before.slice(0, 400)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs font-semibold">You changed it to</p>
                    <p className="font-read text-sm whitespace-pre-line">
                      {edit.after.slice(0, 400)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>
    </>
  );
}
