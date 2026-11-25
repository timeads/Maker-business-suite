import type { Metadata } from "next";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { canManage } from "@/lib/tenants";
import { shippingAccess } from "../../../shipping/gate";
import { PrintingOnThisComputer } from "../../../shipping/print-ui";
import { ShippingManagersOnly } from "../managers-only";

export const metadata: Metadata = { title: "Printing on this computer" };

/**
 * Settings → Shipping → Printing on this computer. The one Shipping setting
 * the whole team can change: it is kept in this browser, never in the
 * database.
 */
export default async function ShippingPrintingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/settings/shipping/printing`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role) && entitlements.canWrite;

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/shipping`, label: "Shipping" }}
        title="Printing on this computer"
        description="How labels and slips print from the computer you're at right now."
      />
      <Card id="printing" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Printing on this computer</CardTitle>
          <CardDescription>
            Saved in this browser only, so the packing bench and the office desk can each print
            their own way. Everyone on the team can set up the computer they pack at.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PrintingOnThisComputer workspaceName={tenant.name} />
        </CardContent>
      </Card>
      {/* As before the move: the rest of Shipping's settings are an owner's or admin's. */}
      {!manager && <ShippingManagersOnly />}
    </>
  );
}
