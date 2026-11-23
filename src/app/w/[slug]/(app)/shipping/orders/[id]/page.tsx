import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { daysFromNow } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/dashboard/format";
import { addressLines, hasAddress } from "@/lib/shipping/carriers";
import {
  formatHoldDate,
  formatWeight,
  holdChoices,
  holdState,
  isInternational,
  isPriority,
  todayIn,
} from "@/lib/shipping/queue";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { ORDER_FIELDS, loadShippingSetup, type ShippingOrder } from "../../data";
import { HoldForm, ParcelForm, PickupForm, SeenBackFromHold } from "../../forms";
import { shippingAccess } from "../../gate";

export const metadata: Metadata = { title: "Send an order" };

export default async function ShippingOrderPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/shipping/orders/${id}`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createClient();
  const [{ data }, setup, { data: parcels }] = await Promise.all([
    supabase
      .from("shipping_orders")
      .select(ORDER_FIELDS)
      .eq("tenant_id", tenant.id)
      .eq("id", id)
      .maybeSingle(),
    loadShippingSetup(supabase, tenant.id),
    supabase
      .from("shipments")
      .select(
        "id, number, carrier, service, tracking_number, tracking_url, shipped_at, items, voided_at",
      )
      .eq("tenant_id", tenant.id)
      .eq("shipping_order_id", id)
      .order("number"),
  ]);
  const order = data as unknown as ShippingOrder | null;
  if (!order) notFound();
  const today = todayIn(tenant.timezone, new Date(daysFromNow(0)));
  const left = order.items.filter((item) => item.left > 0);
  const pickedUp = Boolean(order.picked_up_at);
  const todo = left.length > 0 && !order.cancelled && !pickedUp;
  const hold = todo ? holdState(order, today) : "none";
  const home = setup.settings.ship_from_country;
  const parcelForm = (quiet: boolean) => (
    <ParcelForm
      slug={tenant.slug}
      orderId={order.id}
      lines={left}
      defaultCarrier={setup.settings.default_carrier}
      shopOffered={setup.canSend}
      shopDefault={setup.settings.mark_sent_in_shop}
      notifyDefault={setup.settings.notify_customer}
      currency={tenant.currency}
      quiet={quiet}
    />
  );
  const chose = [
    order.shipping_method ? `chose ${order.shipping_method}` : null,
    order.shipping_paid === null
      ? null
      : Number(order.shipping_paid) === 0
        ? "free shipping"
        : `paid ${formatMoney(Number(order.shipping_paid), tenant.currency)} for shipping`,
    formatWeight(order.weight_grams, home === "US") || null,
  ].filter(Boolean);
  const base = `/w/${tenant.slug}/shipping`;
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  const sent = (parcels ?? []).filter((parcel) => !parcel.voided_at);

  return (
    <>
      <PageHeader
        back={{ href: base, label: "To ship" }}
        title={`${order.name ?? "Order"} · ${order.recipient ?? "no name"}`}
        description={[`Ordered ${when.format(new Date(order.placed_at))}`, ...chose].join(" · ")}
      >
        {order.cancelled && <Badge tone="bad">Cancelled</Badge>}
        {pickedUp && !order.cancelled && <Badge tone="good">Picked up</Badge>}
        {left.length === 0 && !order.cancelled && !pickedUp && <Badge tone="good">All sent</Badge>}
        {hold === "held" && (
          <Badge tone="bad">
            {order.hold_until ? `Hold · until ${formatHoldDate(order.hold_until)}` : "On hold"}
          </Badge>
        )}
        {hold === "back" && <Badge tone="good">Back from hold</Badge>}
        {todo && !order.paid && <Badge tone="waiting">Payment pending</Badge>}
        {todo && order.pickup && (
          <Badge tone={order.pickup_ready_at ? "good" : "open"}>
            {order.pickup_ready_at ? "Ready for pickup" : "Pickup"}
          </Badge>
        )}
        {todo && !order.pickup && isPriority(order.shipping_method) && (
          <Badge tone="waiting">Priority</Badge>
        )}
        {todo && !order.pickup && isInternational(order.country_code, home) && (
          <Badge>International</Badge>
        )}
        {todo && (
          <Button asChild variant="outline" size="sm">
            <Link href={`${base}/slips?order=${order.id}`}>
              Packing slip{order.slip_printed_at ? " (printed)" : ""}
            </Link>
          </Button>
        )}
        {todo && (
          <Button asChild variant="outline" size="sm">
            <Link
              href={`${base}/scan?code=${encodeURIComponent((order.name ?? "").replace(/^#/, ""))}`}
            >
              Scan &amp; pack
            </Link>
          </Button>
        )}
      </PageHeader>
      {hold === "back" && entitlements.canWrite && (
        <SeenBackFromHold slug={tenant.slug} orderId={order.id} />
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {order.pickup && !order.cancelled && (left.length > 0 || pickedUp) ? (
            <Card>
              <CardHeader>
                <CardTitle>In-store pickup</CardTitle>
                <CardDescription>
                  {pickedUp
                    ? `Collected ${when.format(new Date(order.picked_up_at!))}. If your shop still shows it as unfulfilled, mark it there too.`
                    : order.pickup_ready_at
                      ? `Packed and waiting since ${when.format(new Date(order.pickup_ready_at))}. When they come by, mark it picked up.`
                      : "Nothing to post. Pack it, then mark it ready so the team knows it's waiting at the counter."}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <ul className="font-read flex flex-col gap-1 text-sm">
                  {left.map((item) => (
                    <li key={item.line_id}>
                      <span className="font-semibold tabular-nums">{item.left} ×</span> {item.title}
                      {item.variant ? ` (${item.variant})` : ""}
                    </li>
                  ))}
                </ul>
                {entitlements.canWrite && (
                  <PickupForm
                    slug={tenant.slug}
                    orderId={order.id}
                    ready={Boolean(order.pickup_ready_at)}
                    pickedUp={pickedUp}
                    canUndo={canManage(role)}
                  />
                )}
                {todo && entitlements.canWrite && (
                  <details className="border-border border-t pt-3 text-sm">
                    <summary className="text-muted-foreground cursor-pointer">
                      Posting it after all? Record a parcel instead
                    </summary>
                    <div className="pt-4">{parcelForm(true)}</div>
                  </details>
                )}
              </CardContent>
            </Card>
          ) : todo && entitlements.canWrite ? (
            <Card>
              <CardHeader>
                <CardTitle>Record the parcel</CardTitle>
                <CardDescription>
                  Buy the postage wherever you usually do, then put the tracking number here.
                </CardDescription>
              </CardHeader>
              <CardContent>{parcelForm(false)}</CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="pt-5">
                <p className="text-sm">
                  {order.cancelled
                    ? "This order was cancelled, so there's nothing to send."
                    : left.length === 0
                      ? "Everything on this order has been sent."
                      : "This workspace is read-only right now, so parcels can't be recorded."}
                </p>
              </CardContent>
            </Card>
          )}

          {sent.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Already sent</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-3 text-sm">
                  {sent.map((parcel) => (
                    <li key={parcel.id}>
                      <span className="font-semibold">Parcel {parcel.number}</span> ·{" "}
                      {parcel.carrier}
                      {parcel.service ? ` ${parcel.service}` : ""} ·{" "}
                      {parcel.tracking_url ? (
                        <a
                          href={parcel.tracking_url as string}
                          className="text-ochre-text font-medium hover:underline"
                          rel="noreferrer"
                          target="_blank"
                        >
                          {parcel.tracking_number}
                        </a>
                      ) : (
                        parcel.tracking_number || "no tracking"
                      )}
                      <span className="text-muted-foreground block text-xs">
                        {when.format(new Date(parcel.shipped_at as string))} ·{" "}
                        <span className="font-read">
                          {(parcel.items as { title: string; qty: number }[])
                            .map((item) => `${item.qty} × ${item.title}`)
                            .join(", ")}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>

        <aside className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{order.pickup ? "Collecting" : "Send to"}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              {order.pickup && !hasAddress(order) ? (
                <p className="font-read">{order.recipient ?? "No name on this order"}</p>
              ) : hasAddress(order) ? (
                <address className="font-read not-italic">
                  {addressLines(order, home).map((line, index) => (
                    <span key={index} className="block">
                      {line}
                    </span>
                  ))}
                </address>
              ) : (
                <p className="text-brick">
                  There&apos;s no full address on this order. Check it in your shop before you pack.
                </p>
              )}
              {order.phone && <p className="text-muted-foreground">{order.phone}</p>}
              {order.email && (
                <a href={`mailto:${order.email}`} className="text-muted-foreground hover:underline">
                  {order.email}
                </a>
              )}
              {order.note && (
                <p className="bg-note font-read mt-1 rounded-md px-3 py-2 whitespace-pre-wrap">
                  {order.note}
                </p>
              )}
            </CardContent>
          </Card>

          {todo && entitlements.canWrite && (
            <Card>
              <CardHeader>
                <CardTitle>{hold === "held" ? "On hold" : "Not ready to send?"}</CardTitle>
              </CardHeader>
              <CardContent>
                <HoldForm
                  slug={tenant.slug}
                  orderId={order.id}
                  hold={hold}
                  reason={order.hold_reason}
                  until={order.hold_until}
                  today={today}
                  choices={holdChoices(today)}
                />
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
