import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShippingAnchorForward } from "@/components/settings/anchor-forward";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { BoxesForm } from "../../shipping/box-forms";
import { loadBoxes, loadShippingSetup } from "../../shipping/data";
import { ShippingSettingsForm } from "../../shipping/forms";
import { shippingAccess } from "../../shipping/gate";

export const metadata: Metadata = { title: "Shipping settings" };

/**
 * Settings → Shipping → Ship-from & boxes. Also where the old
 * `shipping/settings` address lands, so it forwards that page's anchors.
 */
export default async function ShippingSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/settings/shipping`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role) && entitlements.canWrite;
  // The rest of the team has one Shipping setting: how their own computer prints.
  if (!manager) redirect(`/w/${tenant.slug}/settings/shipping/printing`);
  const supabase = await createClient();
  const [setup, boxes] = await Promise.all([
    loadShippingSetup(supabase, tenant.id),
    loadBoxes(supabase, tenant.id),
  ]);

  return (
    <>
      <ShippingAnchorForward slug={tenant.slug} />
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/shipping`, label: "Shipping" }}
        title="Ship-from & boxes"
        description="Where parcels leave from, what happens when you record one, and the boxes you pack in."
      />
      <Card>
        <CardHeader>
          <CardTitle>Shipping from, and recording parcels</CardTitle>
        </CardHeader>
        <CardContent>
          <ShippingSettingsForm
            slug={tenant.slug}
            settings={setup.settings}
            canSend={setup.canSend}
          />
        </CardContent>
      </Card>
      <Card id="boxes" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Boxes</CardTitle>
          <CardDescription>
            The boxes and envelopes you pack in, so buying a label starts with the right size and
            weight. Connect EasyPost, your own UPS account or Redo under Connections to buy labels.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BoxesForm slug={tenant.slug} boxes={boxes} />
        </CardContent>
      </Card>
    </>
  );
}
