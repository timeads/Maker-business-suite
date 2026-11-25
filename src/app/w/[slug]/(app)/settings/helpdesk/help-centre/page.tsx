import type { Metadata } from "next";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import { inboundDomain, supportAddress } from "@/lib/helpdesk/addresses";
import { HELPDESK_MODULE } from "@/lib/helpdesk/config";
import {
  HELP_CENTRE_KEY,
  helpCentrePath,
  parseHelpCentre,
} from "@/lib/helpdesk/help-centre/config";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { HelpCentreSettingsForm } from "./form";

export const metadata: Metadata = { title: "Help centre settings" };

/** Settings → Help desk → Help centre: whether customers can read it, and what it says about itself. */
export default async function HelpCentreSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await helpdeskAccess(slug, `/w/${slug}/settings/helpdesk/help-centre`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;
  const supabase = await createClient();
  const [{ data: row }, { count }, site] = await Promise.all([
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", HELPDESK_MODULE)
      .eq("key", HELP_CENTRE_KEY)
      .maybeSingle(),
    supabase
      .from("manual_articles")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .eq("public_state", "published"),
    getSiteUrl(),
  ]);
  const config = parseHelpCentre(row?.body);
  const address = `${site}${helpCentrePath(tenant.slug)}`;
  const domain = inboundDomain();
  const published = count ?? 0;

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/helpdesk/manual/kb`, label: "the knowledge base" }}
        title="Help centre"
        description="Pages your customers can read without signing in, made from the help articles you publish."
      />
      <Card>
        <CardHeader>
          <CardTitle>Your help centre</CardTitle>
          <CardDescription>
            {config.on ? (
              <>
                It is on, at{" "}
                <a href={address} className="text-ochre-text break-all underline">
                  {address}
                </a>
                , with {published} published {published === 1 ? "article" : "articles"}.
              </>
            ) : (
              <>
                It is off: nobody outside your team can see anything. When you switch it on it will
                be at <span className="break-all">{address}</span>
                {published === 0
                  ? ". Publish a help article first, from the knowledge base."
                  : `, with ${published} published ${published === 1 ? "article" : "articles"}.`}
              </>
            )}{" "}
            Only help articles you publish appear there. Topics, team articles, drafts and anything
            a customer sent you never do.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <HelpCentreSettingsForm
              slug={tenant.slug}
              config={config}
              workspaceName={tenant.name}
              ownAddress={domain ? supportAddress(tenant.slug, domain) : null}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              {canManage(role)
                ? "This workspace is read-only just now, so these can't be changed."
                : "Owners and admins switch the help centre on and choose what it says."}
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
