import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadShippingSetup } from "../data";
import { ShippingSettingsForm } from "../forms";
import { shippingAccess } from "../gate";
import { ShippingTabs } from "../tabs";

export const metadata: Metadata = { title: "Shipping settings" };

export default async function ShippingSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/shipping/settings`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const setup = await loadShippingSetup(await createClient(), tenant.id);

  return (
    <>
      <PageHeader
        title="Shipping"
        description="What your packing slips say, and what happens when you record a parcel."
      />
      <ShippingTabs slug={tenant.slug} />
      <Card>
        <CardContent className="pt-5">
          {canManage(role) && entitlements.canWrite ? (
            <ShippingSettingsForm
              slug={tenant.slug}
              settings={setup.settings}
              canSend={setup.canSend}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              An owner or admin can change these settings.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
