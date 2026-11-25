import type { Metadata } from "next";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadBoxes, loadRememberedPackings, loadShippingSetup } from "../../../shipping/data";
import { shippingAccess } from "../../../shipping/gate";
import {
  RememberPackingForm,
  RememberedPackings,
  ShippingRulesForm,
} from "../../../shipping/rules-form";
import { ShippingManagersOnly } from "../managers-only";

export const metadata: Metadata = { title: "Shipping rules" };

/** Settings → Shipping → Rules: the rules themselves, and what packing is remembered. */
export default async function ShippingRulesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/settings/shipping/rules`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role) && entitlements.canWrite;
  const heading = (
    <SectionHeading
      back={{ href: `/w/${tenant.slug}/shipping`, label: "Shipping" }}
      title="Rules"
      description="Let the app pick the box, the signature, the service or a hold, and remember how you pack."
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
  const [setup, boxes, remembered] = await Promise.all([
    loadShippingSetup(supabase, tenant.id),
    loadBoxes(supabase, tenant.id),
    loadRememberedPackings(supabase, tenant.id),
  ]);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
  });

  return (
    <>
      {heading}
      <Card id="rules" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Rules</CardTitle>
          <CardDescription>
            Let the app decide the box, the signature, the service or a hold for orders that look a
            certain way. Rules show on the To ship list and on each order, and they are what makes
            buying labels for several orders at once safe.
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
      <Card id="memory" className="scroll-mt-6">
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
    </>
  );
}
