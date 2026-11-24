import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { daysFromNow } from "@/lib/bookings/slots";
import { countryName } from "@/lib/shipping/carriers";
import { formatHoldDate, holdState, todayIn } from "@/lib/shipping/queue";
import { orderCode } from "@/lib/shipping/scan";
import { pickupTells } from "@/lib/shipping/shop-steps";
import { createClient } from "@/lib/supabase/server";
import { groupHref } from "@/lib/shipping/merge";
import {
  ORDER_FIELDS,
  loadKnownGroup,
  loadLabelConnections,
  loadShippingSetup,
  placeOf,
  type ShippingOrder,
} from "../data";
import { shippingAccess } from "../gate";
import { ShippingTabs } from "../tabs";
import { PackStation, type PackOrder } from "./pack-station";

export const metadata: Metadata = { title: "Scan & pack" };

export default async function ScanPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ code?: string; sent?: string }>;
}) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/shipping/scan`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  const base = `/w/${tenant.slug}/shipping`;
  const query = await searchParams;
  const code = orderCode(query.code ?? "");
  const justSent = /^\d{1,9}$/.test(query.sent ?? "") ? query.sent : null;

  const supabase = await createClient();
  const [setup, postage, found] = await Promise.all([
    loadShippingSetup(supabase, tenant.id),
    loadLabelConnections(supabase, tenant.id),
    code
      ? supabase
          .from("shipping_orders")
          .select(ORDER_FIELDS)
          .eq("tenant_id", tenant.id)
          // The slip's barcode carries the number without its "#".
          .or(`name.ilike."${code}",name.ilike."#${code}"`)
          .order("cancelled")
          .order("units_left", { ascending: false })
          .limit(1)
      : null,
  ]);
  const row = ((found?.data ?? []) as unknown as ShippingOrder[])[0] ?? null;
  const today = todayIn(tenant.timezone, new Date(daysFromNow(0)));
  const home = setup.settings.ship_from_country;
  const held = row && !row.cancelled && !row.picked_up_at && holdState(row, today) === "held";
  // Saved (or approved) to go out with other orders: the label is bought for them all at once.
  const waitingWith =
    row && !row.cancelled && row.units_left > 0
      ? await loadKnownGroup(supabase, tenant.id, row.id, today)
      : null;
  const order: PackOrder | null = row
    ? {
        id: row.id,
        name: row.name ?? "Order",
        customer: row.recipient ?? "no name",
        place: row.pickup ? "Collecting" : placeOf(row, home, countryName),
        chose: row.shipping_method ?? "",
        note: row.note,
        lines:
          row.cancelled || row.picked_up_at
            ? []
            : row.items.map((item) => ({
                line_id: item.line_id,
                title: item.title,
                variant: item.variant,
                sku: item.sku,
                barcode: item.barcode ?? null,
                left: item.left,
              })),
        pickup: row.pickup,
        pickupReady: Boolean(row.pickup_ready_at),
        held: held
          ? `On hold${row.hold_until ? ` until ${formatHoldDate(row.hold_until)}` : ""}${row.hold_reason ? `: ${row.hold_reason}` : "."}`
          : null,
        closed: row.cancelled
          ? "This order was cancelled, so there's nothing to pack."
          : row.picked_up_at
            ? "This order has been picked up."
            : null,
        unpaid: !row.paid,
        together: Boolean(waitingWith),
        pickupTells: pickupTells({
          wanted: setup.settings.tell_shop_pickups,
          canSend: setup.canSend,
          connected: setup.connected,
        }),
      }
    : null;

  return (
    <>
      <PageHeader
        title="Shipping"
        description="Check each order against its slip as you pack it. Scan the slip, then every item going in the box."
      />
      <ShippingTabs slug={tenant.slug} />
      {justSent && !order && (
        <p role="status" className="bg-mint-soft text-mint-ink rounded-md px-4 py-2.5 text-sm">
          Parcel {justSent} recorded. Scan the next slip when you&apos;re ready.{" "}
          <Link href={`${base}/sent`} className="font-semibold underline underline-offset-2">
            See what&apos;s been sent
          </Link>
        </p>
      )}
      {row && waitingWith && (
        <p role="status" className="bg-note rounded-md px-4 py-2.5 text-sm">
          {row.name ?? "This order"} is going out together with{" "}
          <span className="font-semibold tabular-nums">
            {waitingWith.names.filter((_, index) => waitingWith.ids[index] !== row.id).join(" + ")}
          </span>
          , on one label.{" "}
          <Link
            href={groupHref(base, waitingWith.ids)}
            className="font-semibold underline underline-offset-2"
          >
            Open them together
          </Link>{" "}
          to buy it. Recording a parcel here would send this order on its own.
        </p>
      )}
      <PackStation
        key={order?.id ?? "none"}
        slug={tenant.slug}
        order={order}
        missing={code && !order ? code : null}
        canWrite={entitlements.canWrite}
        labels={postage.active.length > 0}
        parcel={{
          defaultCarrier: setup.settings.default_carrier,
          shopOffered: setup.canSend,
          shopDefault: setup.settings.mark_sent_in_shop,
          notifyDefault: setup.settings.notify_customer,
          currency: tenant.currency,
        }}
      />
    </>
  );
}
