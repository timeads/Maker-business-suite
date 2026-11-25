import type { Metadata } from "next";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadShippingSetup, loadSlipLogoUrl } from "../../../shipping/data";
import { shippingAccess } from "../../../shipping/gate";
import { SlipDesigner } from "../../../shipping/slip-designer";
import { ShippingManagersOnly } from "../managers-only";

export const metadata: Metadata = { title: "Packing slip" };

/** Settings → Shipping → Packing slip: the designer and its live preview. */
export default async function PackingSlipPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/settings/shipping/slip`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role) && entitlements.canWrite;
  const heading = (
    <SectionHeading
      back={{ href: `/w/${tenant.slug}/shipping`, label: "Shipping" }}
      title="Packing slip"
      description="What the slip in each box says, and how it's laid out."
    />
  );
  if (!manager) {
    return (
      <>
        {heading}
        <ShippingManagersOnly />
      </>
    );
  }
  const supabase = await createClient();
  const [setup, logoUrl] = await Promise.all([
    loadShippingSetup(supabase, tenant.id),
    loadSlipLogoUrl(supabase, tenant.id),
  ]);

  return (
    <>
      {heading}
      <Card id="slip" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Packing slip</CardTitle>
          <CardDescription>
            Design the slip that goes in each box. The preview is the slip itself: what you see is
            what prints, on paper and on a Zebra.
          </CardDescription>
        </CardHeader>
        {/* The designer sits beside its preview only where this column is wide enough. */}
        <CardContent className="@container">
          <SlipDesigner
            slug={tenant.slug}
            layout={setup.slip}
            settings={setup.settings}
            workspaceName={tenant.name}
            timeZone={tenant.timezone}
            currency={tenant.currency}
            logoUrl={logoUrl}
          />
        </CardContent>
      </Card>
    </>
  );
}
