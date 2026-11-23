import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadShippingSetup, type ShippingOrder } from "../data";
import { ShippingSettingsForm, SlipLayoutForm } from "../forms";
import { shippingAccess } from "../gate";
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
  const setup = await loadShippingSetup(await createClient(), tenant.id);

  return (
    <>
      <PageHeader
        title="Shipping"
        description="What your packing slips say, and what happens when you record a parcel."
      />
      <ShippingTabs slug={tenant.slug} />
      {canManage(role) && entitlements.canWrite ? (
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
