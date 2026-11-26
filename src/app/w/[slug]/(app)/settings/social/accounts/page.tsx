import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { loadBrands } from "@/lib/brand/brands";
import { getEntitlements } from "@/lib/entitlements";
import { ACCOUNT_COLUMNS, accountsByPage, type AccountRow } from "@/lib/social/accounts";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { AllowMetaAccess } from "../../helpdesk/channels/form";
import { AccountsForm } from "../../../social/accounts-form";

export const metadata: Metadata = { title: "Social accounts" };

/**
 * Settings → Social & emails → Social accounts: which of the Pages and
 * Instagram accounts Facebook shared the workspace uses, and the brand each
 * belongs to. Social posts to them and the help desk answers as them.
 * Everyone can see the list; owners and admins change it.
 */
export default async function SocialAccountsSettings({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings/social/accounts`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.social") && !entitlements.can("module.helpdesk")) notFound();
  const supabase = await createClient();
  const [{ data: rows }, brands, { data: connection }] = await Promise.all([
    supabase
      .from("social_accounts")
      .select(ACCOUNT_COLUMNS)
      .eq("tenant_id", ctx.tenant.id)
      .order("created_at"),
    loadBrands(supabase, ctx.tenant.id),
    supabase
      .from("connections")
      .select("status")
      .eq("tenant_id", ctx.tenant.id)
      .eq("provider", "meta")
      .maybeSingle(),
  ]);
  const accounts = (rows ?? []) as AccountRow[];
  const canEdit = canManage(ctx.role) && entitlements.canWrite;
  const limit = entitlements.limit("social_accounts");
  const connected = connection?.status === "active";

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${ctx.tenant.slug}/social`, label: "Social" }}
        title="Social accounts"
        description="The Facebook Pages and Instagram accounts this workspace posts to and answers messages as, and which brand each one belongs to."
      />
      {accounts.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing connected yet</CardTitle>
            <CardDescription>
              Connect Facebook & Instagram first. Every Page you share with us shows up here, with
              the Instagram account linked to it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href={`/w/${ctx.tenant.slug}/connections`}
              className="text-ochre-text text-sm font-semibold hover:underline"
            >
              Go to Connections
            </Link>
          </CardContent>
        </Card>
      ) : (
        <AccountsForm
          slug={ctx.tenant.slug}
          pages={accountsByPage(accounts)}
          brands={brands.map((brand) => ({
            id: brand.id,
            name: brand.name,
            archived: Boolean(brand.archived_at),
          }))}
          canEdit={canEdit}
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>Another Page or Instagram account?</CardTitle>
          <CardDescription>
            Connect again and tick every Page you want us to see when Facebook asks (an Instagram
            account comes with the Page it is linked to). New ones arrive here unticked; the ones
            you use now carry on as they are. Your plan uses up to {limit} of each kind at a time.
          </CardDescription>
        </CardHeader>
        {canEdit && connected && (
          <CardContent>
            <AllowMetaAccess
              slug={ctx.tenant.slug}
              label="Share more Pages with us"
              access=""
              returnTo="social_accounts"
              variant="outline"
            />
          </CardContent>
        )}
      </Card>
    </>
  );
}
