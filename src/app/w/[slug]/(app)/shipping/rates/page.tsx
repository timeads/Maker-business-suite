import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/server";
import { loadBoxes, loadLabelConnections, loadShippingSetup } from "../data";
import { shippingAccess } from "../gate";
import { RateCalculator } from "./rate-calculator";

export const metadata: Metadata = { title: "Rate calculator" };

export default async function RateCalculatorPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/shipping/rates`);
  if (!access.ok) return access.upsell;
  const { tenant } = access;
  const supabase = await createClient();
  const [setup, boxes, postage] = await Promise.all([
    loadShippingSetup(supabase, tenant.id),
    loadBoxes(supabase, tenant.id),
    loadLabelConnections(supabase, tenant.id),
  ]);
  return (
    <>
      <PageHeader
        title="Rate calculator"
        description="What a parcel would cost with each of your accounts. Nothing is bought here."
      />
      <RateCalculator
        slug={tenant.slug}
        homeZip={setup.settings.ship_from.postal_code.slice(0, 5)}
        connected={postage.active.length > 0}
        boxes={boxes.map((box) => ({
          id: box.id,
          name: box.name,
          length: String(Number(box.length_in)),
          width: String(Number(box.width_in)),
          height: String(Number(box.height_in)),
        }))}
      />
    </>
  );
}
