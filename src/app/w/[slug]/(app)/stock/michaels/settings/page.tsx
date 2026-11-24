import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadMichaels } from "../data";
import { MichaelsSettingsForm } from "../forms";
import { michaelsAccess } from "../gate";
import { MichaelsTabs, WatchingBanner } from "../tabs";

export const metadata: Metadata = { title: "Michaels settings" };

export default async function MichaelsSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await michaelsAccess(slug, `/w/${slug}/stock/michaels/settings`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const michaels = await loadMichaels(await createClient(), tenant);
  const { settings } = michaels;

  return (
    <>
      <PageHeader
        title="Michaels Marketplace"
        description="Whether we look at Michaels, and what each look works out."
        back={{ href: `/w/${tenant.slug}/stock`, label: "Stock" }}
      />
      <MichaelsTabs slug={tenant.slug} />
      <WatchingBanner />
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>
            {michaels.connected
              ? "Changes take effect at the next look."
              : "Connect your Michaels seller account under Connections first. You can set these up in the meantime."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canManage(role) && entitlements.canWrite ? (
            <MichaelsSettingsForm slug={tenant.slug} settings={settings} />
          ) : (
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">Looking at Michaels</dt>
              <dd>{settings.enabled ? "On, about once an hour" : "Off"}</dd>
              <dt className="text-muted-foreground">How it runs</dt>
              <dd>Watch only: nothing is sent</dd>
              <dt className="text-muted-foreground">Units held back</dt>
              <dd>{settings.units_held_back}</dd>
              <dt className="text-muted-foreground">Each look works out</dt>
              <dd>
                {[
                  settings.jobs.stock && "stock",
                  settings.jobs.prices && "prices",
                  settings.jobs.orders && "orders",
                ]
                  .filter(Boolean)
                  .join(", ") || "only the matching"}
              </dd>
              <dt className="text-muted-foreground" />
              <dd className="text-muted-foreground">An owner or admin can change these.</dd>
            </dl>
          )}
        </CardContent>
      </Card>
    </>
  );
}
