import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { BoxesForm } from "../box-forms";
import { loadBoxes, loadRememberedPackings, loadShippingSetup, loadSlipLogoUrl } from "../data";
import { ShippingSettingsForm } from "../forms";
import { shippingAccess } from "../gate";
import { PrintingOnThisComputer } from "../print-ui";
import { RememberPackingForm, RememberedPackings, ShippingRulesForm } from "../rules-form";
import { SlipDesigner } from "../slip-designer";
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
  const supabase = await createClient();
  const manager = canManage(role) && entitlements.canWrite;
  const [setup, boxes, remembered, logoUrl] = await Promise.all([
    loadShippingSetup(supabase, tenant.id),
    loadBoxes(supabase, tenant.id),
    manager ? loadRememberedPackings(supabase, tenant.id) : [],
    manager ? loadSlipLogoUrl(supabase, tenant.id) : null,
  ]);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
  });

  return (
    <>
      <PageHeader
        title="Shipping"
        description="What your packing slips say, the boxes you pack in, your shipping rules, and what happens when you record a parcel."
      />
      <ShippingTabs slug={tenant.slug} />
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
      {manager ? (
        <>
          <Card id="slip" className="scroll-mt-6">
            <CardHeader>
              <CardTitle>Packing slip</CardTitle>
              <CardDescription>
                Design the slip that goes in each box. The preview is the slip itself: what you see
                is what prints, on paper and on a Zebra.
              </CardDescription>
            </CardHeader>
            <CardContent>
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
          <Card id="rules">
            <CardHeader>
              <CardTitle>Rules</CardTitle>
              <CardDescription>
                Let the app decide the box, the signature, the service or a hold for orders that
                look a certain way. Rules show on the To ship list and on each order, and they are
                what makes buying labels for several orders at once safe.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ShippingRulesForm
                slug={tenant.slug}
                rules={setup.rules}
                boxes={boxes.map((box) => box.name)}
                signatureOver={setup.settings.signature_over}
                currency={tenant.currency}
              />
            </CardContent>
          </Card>
          <Card id="memory">
            <CardHeader>
              <CardTitle>Remember how I pack</CardTitle>
              <CardDescription>
                Each time you buy a label for a whole order, the boxes it went in are remembered for
                those items. A rule&apos;s box comes first; what you set on an order&apos;s own page
                always wins.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <RememberPackingForm slug={tenant.slug} remember={setup.settings.remember_packing} />
              <div className="flex flex-col gap-2">
                <p className="text-sm font-semibold">What&apos;s been remembered</p>
                <RememberedPackings
                  slug={tenant.slug}
                  rows={remembered.map((row) => ({
                    id: row.id,
                    label: row.label,
                    boxes: row.boxes,
                    uses: row.uses,
                    when: day.format(new Date(row.updated_at)),
                  }))}
                  boxNames={Object.fromEntries(boxes.map((box) => [box.id, box.name]))}
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Boxes</CardTitle>
              <CardDescription>
                The boxes and envelopes you pack in, so buying a label starts with the right size
                and weight. Connect EasyPost, your own UPS account or Redo under Connections to buy
                labels.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BoxesForm slug={tenant.slug} boxes={boxes} />
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="pt-5">
            <p className="text-muted-foreground text-sm">
              An owner or admin can change these settings.
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
