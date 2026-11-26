import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { workspaceTemplates } from "@/lib/brand/email";
import { loadBrandKit, loadBrands, pickBrand } from "@/lib/brand/brands";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { socialAccess } from "../gate";
import { NewEmail, WriteWithClaude } from "./new-email";
import { RowActions } from "./row-actions";

export const metadata: Metadata = { title: "Emails" };

export default async function EmailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ brand?: string }>;
}) {
  const { slug } = await params;
  const { brand: wanted } = await searchParams;
  const access = await socialAccess(slug, `/w/${slug}/social/emails`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements, role } = access;
  const supabase = await createClient();
  const [{ data: rows }, brands] = await Promise.all([
    supabase
      .from("emails")
      .select("id, title, updated_at")
      .eq("tenant_id", tenant.id)
      .order("updated_at", { ascending: false })
      .limit(100),
    loadBrands(supabase, tenant.id),
  ]);
  // New emails are drawn in the brand picked here (the main brand unless another is chosen).
  const brand = pickBrand(
    brands.filter((each) => !each.archived_at),
    wanted,
  );
  const { kit } = await loadBrandKit(supabase, tenant.id, brand?.id);
  const many = brands.filter((each) => !each.archived_at).length > 1;
  const emails = (rows ?? []) as { id: string; title: string; updated_at: string }[];
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <>
      <PageHeader
        title="Emails"
        description="Design an email in your brand, then copy it into whatever you send email with."
      />

      {entitlements.canWrite && many && (
        <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">New emails are drawn in</span>
            <select
              name="brand"
              defaultValue={brand?.id}
              className="border-input bg-card h-8 rounded-sm border px-2 text-sm"
            >
              {brands
                .filter((each) => !each.archived_at)
                .map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.name}
                  </option>
                ))}
            </select>
          </label>
          <Button type="submit" variant="outline" size="sm">
            Use this brand
          </Button>
        </form>
      )}
      {entitlements.canWrite &&
        (kit ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Write it with Claude</CardTitle>
                <CardDescription>
                  A first draft in your voice and colours. It opens in the builder for you to edit;
                  nothing is sent.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <WriteWithClaude slug={tenant.slug} brandId={many ? (brand?.id ?? null) : null} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Or start from a template</CardTitle>
                <CardDescription>
                  Each starter comes in your colours. Drag blocks around once it opens.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <NewEmail
                  slug={tenant.slug}
                  brandId={many ? (brand?.id ?? null) : null}
                  starters={workspaceTemplates(kit).map(({ id, name, about }) => ({
                    id,
                    name,
                    about,
                  }))}
                />
              </CardContent>
            </Card>
          </>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Set up your brand kit first</CardTitle>
              <CardDescription>
                Emails are drawn in your colours, so we need to know them.
                {!canManage(role) && " Ask an owner or admin to set it up."}
              </CardDescription>
            </CardHeader>
            {canManage(role) && (
              <CardContent>
                <Button asChild>
                  <Link href={`/w/${tenant.slug}/settings/brand`}>Set up brand kit</Link>
                </Button>
              </CardContent>
            )}
          </Card>
        ))}

      {emails.length === 0 ? (
        <p className="text-muted-foreground text-sm">No emails yet.</p>
      ) : (
        <ul className="bg-card divide-border divide-y rounded-lg border">
          {emails.map((email) => (
            <li key={email.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Link
                href={`/w/${tenant.slug}/emails/${email.id}`}
                className="min-w-0 flex-1 truncate text-sm font-semibold hover:underline"
              >
                {email.title}
              </Link>
              <span className="text-muted-foreground text-xs">
                Edited {when.format(new Date(email.updated_at))}
              </span>
              {entitlements.canWrite && (
                <RowActions slug={tenant.slug} id={email.id} title={email.title} />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
