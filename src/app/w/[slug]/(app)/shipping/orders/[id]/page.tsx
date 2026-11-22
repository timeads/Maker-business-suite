import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { addressLines, hasAddress, queueOf } from "@/lib/shipping/carriers";
import { createClient } from "@/lib/supabase/server";
import { ORDER_FIELDS, loadShippingSetup, type ShippingOrder } from "../../data";
import { HoldForm, ParcelForm } from "../../forms";
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
  const { tenant, entitlements } = access;
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
  const pile = queueOf(order);
  const left = order.items.filter((item) => item.left > 0);
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
        back={{ href: base, label: "To send" }}
        title={`${order.name ?? "Order"} · ${order.recipient ?? "no name"}`}
        description={`Ordered ${when.format(new Date(order.placed_at))}${order.shipping_method ? ` · chose ${order.shipping_method}` : ""}`}
      >
        {order.cancelled && <Badge tone="bad">Cancelled</Badge>}
        {pile === "done" && !order.cancelled && <Badge tone="good">All sent</Badge>}
        {pile === "hold" && <Badge tone="waiting">On hold</Badge>}
        {pile === "unpaid" && <Badge tone="waiting">Waiting on payment</Badge>}
        {left.length > 0 && !order.cancelled && (
          <Button asChild variant="outline" size="sm">
            <Link href={`${base}/slips?order=${order.id}`}>Packing slip</Link>
          </Button>
        )}
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {left.length > 0 && !order.cancelled && entitlements.canWrite ? (
            <Card>
              <CardHeader>
                <CardTitle>Record the parcel</CardTitle>
                <CardDescription>
                  Buy the postage wherever you usually do, then put the tracking number here.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ParcelForm
                  slug={tenant.slug}
                  orderId={order.id}
                  lines={left}
                  defaultCarrier={setup.settings.default_carrier}
                  shopOffered={setup.canSend}
                  shopDefault={setup.settings.mark_sent_in_shop}
                  notifyDefault={setup.settings.notify_customer}
                  currency={tenant.currency}
                />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="pt-5">
                <p className="text-sm">
                  {order.cancelled
                    ? "This order was cancelled, so there's nothing to send."
                    : "Everything on this order has been sent."}
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
              <CardTitle>Send to</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              {hasAddress(order) ? (
                <address className="font-read not-italic">
                  {addressLines(order).map((line, index) => (
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

          {left.length > 0 && !order.cancelled && entitlements.canWrite && (
            <Card>
              <CardHeader>
                <CardTitle>{order.on_hold ? "On hold" : "Not ready to send?"}</CardTitle>
              </CardHeader>
              <CardContent>
                <HoldForm
                  slug={tenant.slug}
                  orderId={order.id}
                  onHold={order.on_hold}
                  reason={order.hold_reason}
                />
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
