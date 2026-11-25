import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getSiteUrl } from "@/lib/site-url";
import { LINKS_KEY, SOCIAL_MODULE, linksToText, parseLinkPage } from "@/lib/social/plan";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { LinkPageForm } from "../forms";
import { socialAccess } from "../gate";

export const metadata: Metadata = { title: "Link page" };

export default async function SocialLinksPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await socialAccess(slug, `/w/${slug}/social/links`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const supabase = await createClient();
  const [{ data }, site] = await Promise.all([
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", SOCIAL_MODULE)
      .eq("key", LINKS_KEY)
      .maybeSingle(),
    getSiteUrl(),
  ]);
  const page = parseLinkPage(data?.body);
  const address = `${site}/links/${tenant.slug}`;

  return (
    <>
      <PageHeader
        title="Link page"
        description="One page with all your links, for the single link a profile lets you have."
      >
        <Badge tone={page.published ? "good" : "closed"}>
          {page.published ? "Live" : "Not published"}
        </Badge>
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle>Your link page</CardTitle>
          <CardDescription>
            {page.published ? (
              <>
                Put this in your Instagram bio:{" "}
                <a href={address} className="text-ochre-text font-medium hover:underline">
                  {address}
                </a>
              </>
            ) : (
              <>Once published it will live at {address}</>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LinkPageForm
            slug={tenant.slug}
            page={page}
            linksText={linksToText(page)}
            canEdit={canManage(role) && entitlements.canWrite}
          />
        </CardContent>
      </Card>
    </>
  );
}
