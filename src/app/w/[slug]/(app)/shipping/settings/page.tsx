import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { BoxesForm } from "../box-forms";
import { loadBoxes, loadRememberedPackings, loadShippingSetup, type ShippingOrder } from "../data";
import { ShippingSettingsForm, SlipLayoutForm } from "../forms";
import { shippingAccess } from "../gate";
import { PrintingOnThisComputer } from "../print-ui";
import { RememberPackingForm, RememberedPackings, ShippingRulesForm } from "../rules-form";
import { PackingSlip } from "../slip";
import { ShippingTabs } from "../tabs";

export const metadata: Metadata = { title: "Shipping settings" };

/** A made-up order, so the preview shows every section. */
const SAMPLE: ShippingOrder = {
  id: "sample",
  name: "#1042",
  placed_at: "2026-11-18T15:00:00Z",
  recipient: "Sam Shopper",
  company: null,
  address1: "12 Mill Lane",
  address2: null,
  city: "Hudson",
  region: "NY",
  postal_code: "12534",
  country_code: "US",
  phone: null,
  email: null,
  shipping_method: "Standard shipping",
  shipping_paid: 8.5,
  weight_grams: 1361,
  pickup: false,
  note: "It's a gift, no receipt please.",
  items: [
    {
      line_id: "1",
      title: "Wool rug",
      variant: "Large",
      sku: "RUG-L",
      price: 120,
      qty: 1,
      left: 1,
    },
    {
      line_id: "2",
      title: "Yarn bundle",
      variant: "Mustard",
      sku: "YARN-M",
      price: 9,
      qty: 3,
      left: 3,
    },
  ],
  units_left: 4,
  cancelled: false,
  paid: true,
  on_hold: false,
  hold_reason: "",
  hold_until: null,
  pickup_ready_at: null,
  picked_up_at: null,
  slip_printed_at: null,
};

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
  const [setup, boxes, remembered] = await Promise.all([
    loadShippingSetup(supabase, tenant.id),
    loadBoxes(supabase, tenant.id),
    manager ? loadRememberedPackings(supabase, tenant.id) : [],
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
      <Card>
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
          <Card>
            <CardHeader>
              <CardTitle>Packing slip</CardTitle>
              <CardDescription>
                Choose what prints and in what order. The preview updates when you save.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-8 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
              <SlipLayoutForm slug={tenant.slug} layout={setup.slip} />
              <div aria-label="Packing slip preview" className="bg-panel rounded-lg p-4">
                <div className="mx-auto max-w-2xl">
                  <PackingSlip
                    order={{ ...SAMPLE, country_code: setup.settings.ship_from_country }}
                    settings={setup.settings}
                    layout={setup.slip}
                    workspaceName={tenant.name}
                    timeZone={tenant.timezone}
                    currency={tenant.currency}
                  />
                </div>
              </div>
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
