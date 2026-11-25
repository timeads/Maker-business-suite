import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeading } from "@/components/settings/section-heading";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadMichaels } from "../../../stock/michaels/data";
import { MichaelsSettingsForm } from "../../../stock/michaels/forms";
import { michaelsAccess } from "../../../stock/michaels/gate";
import { WatchingBanner } from "../../../stock/michaels/watching";

export const metadata: Metadata = { title: "Michaels settings" };

export default async function MichaelsSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await michaelsAccess(slug, `/w/${slug}/settings/stock/michaels`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const michaels = await loadMichaels(await createClient(), tenant);
  const { settings } = michaels;

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/stock/michaels`, label: "Michaels" }}
        title="Michaels Marketplace"
        description="Whether we look at Michaels, and what each look works out."
      />
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
