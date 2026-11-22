import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { daysFromNow } from "@/lib/bookings/slots";
import { hasAddress, queueOf } from "@/lib/shipping/carriers";
import { createClient } from "@/lib/supabase/server";
import { ORDER_FIELDS, itemsSummary, loadShippingSetup, type ShippingOrder } from "./data";
import { shippingAccess } from "./gate";
import { ShippingTabs } from "./tabs";

export const metadata: Metadata = { title: "Shipping" };

export default async function ShippingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ sent?: string }>;
}) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/shipping`);
  if (!access.ok) return access.upsell;
  const { tenant } = access;
  const base = `/w/${tenant.slug}/shipping`;
  const justSent = /^\d{1,9}$/.test((await searchParams).sent ?? "")
    ? (await searchParams).sent
    : null;

  const supabase = await createClient();
  const [{ data }, setup, { count: sentThisWeek }] = await Promise.all([
    supabase
      .from("shipping_orders")
      .select(ORDER_FIELDS)
      .eq("tenant_id", tenant.id)
      .gt("units_left", 0)
      .eq("cancelled", false)
      .order("placed_at")
      .limit(500),
    loadShippingSetup(supabase, tenant.id),
    supabase
      .from("shipments")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .is("voided_at", null)
      .gte("shipped_at", daysFromNow(-7)),
  ]);
  const orders = (data ?? []) as unknown as ShippingOrder[];
  const ready = orders.filter((order) => queueOf(order) === "ready");
  const held = orders.filter((order) => queueOf(order) === "hold");
  const unpaid = orders.filter((order) => queueOf(order) === "unpaid");
  const oldest = ready[0]?.placed_at;
  const waitingDays = oldest
    ? Math.max(0, Math.floor((Date.parse(daysFromNow(0)) - Date.parse(oldest)) / 86_400_000))
    : 0;
  const unprinted = ready.filter((order) => !order.slip_printed_at);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
  });
  const stats = [
    { label: "Ready to send", value: String(ready.length), note: "paid and waiting on you" },
    {
      label: "Longest wait",
      value: ready.length ? `${waitingDays}d` : "–",
      note: ready.length ? "since the oldest was ordered" : "nothing waiting",
    },
    { label: "On hold", value: String(held.length), note: "set aside by your team" },
    {
      label: "Sent this week",
      value: String(sentThisWeek ?? 0),
      note: "parcels in the last 7 days",
    },
  ];

  const list = (rows: ShippingOrder[]) => (
    <ul className="divide-border flex flex-col divide-y">
      {rows.map((order) => {
        const part = order.items.some((item) => item.left < item.qty);
        return (
          <li key={order.id}>
            <Link
              href={`${base}/orders/${order.id}`}
              className="hover:bg-hover -mx-2 flex flex-wrap items-start gap-x-4 gap-y-1 rounded-sm px-2 py-2.5 text-sm"
            >
              <span className="text-muted-foreground w-16 shrink-0 tabular-nums">
                {order.name ?? "Order"}
              </span>
              <span className="min-w-0 flex-1 basis-56">
                <span className="font-read font-semibold">
                  {order.recipient ?? "No name on this order"}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  ·{" "}
                  {[
                    order.city,
                    order.region,
                    order.country_code !== "US" ? order.country_code : null,
                  ]
                    .filter(Boolean)
                    .join(", ") || "no address"}
                </span>
                <span className="text-text-2 font-read block">{itemsSummary(order)}</span>
                {order.on_hold && order.hold_reason && (
                  <span className="text-muted-foreground font-read block text-xs">
                    {order.hold_reason}
                  </span>
                )}
              </span>
              <span className="flex flex-wrap items-center justify-end gap-1.5">
                {!hasAddress(order) && <Badge tone="bad">Needs an address</Badge>}
                {part && <Badge tone="waiting">Part sent</Badge>}
                {order.slip_printed_at && <Badge tone="good">Slip printed</Badge>}
                {order.shipping_method && <Badge>{order.shipping_method}</Badge>}
                <span className="text-muted-foreground w-14 text-right tabular-nums">
                  {day.format(new Date(order.placed_at))}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      <PageHeader
        title="Shipping"
        description="What's waiting to go out, oldest first. Open an order to pack it and record its tracking."
      >
        {ready.length > 0 && (
          <Button asChild variant="outline" size="sm">
            <Link href={`${base}/slips`}>
              Print packing slips
              {unprinted.length > 0 && unprinted.length < ready.length
                ? ` (${unprinted.length} new)`
                : ""}
            </Link>
          </Button>
        )}
      </PageHeader>
      <ShippingTabs slug={tenant.slug} />

      {justSent && (
        <p role="status" className="bg-mint-soft text-mint-ink rounded-md px-4 py-2.5 text-sm">
          Parcel {justSent} recorded.{" "}
          <Link href={`${base}/sent`} className="font-semibold underline underline-offset-2">
            See what&apos;s been sent
          </Link>
        </p>
      )}

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="bg-card border-border rounded-lg border px-4 py-3">
            <dt className="text-muted-foreground text-xs font-semibold">{stat.label}</dt>
            <dd className="mt-1 text-2xl leading-none font-bold tabular-nums">{stat.value}</dd>
            <dd className="text-muted-foreground mt-1.5 text-xs">{stat.note}</dd>
          </div>
        ))}
      </dl>

      <Card>
        <CardHeader>
          <CardTitle>Ready to send</CardTitle>
        </CardHeader>
        <CardContent>
          {ready.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {setup.connected
                ? "All caught up. New orders appear here as they come in."
                : "Connect your shop under Connections and your orders to send will appear here."}
            </p>
          ) : (
            list(ready)
          )}
        </CardContent>
      </Card>

      {held.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>On hold</CardTitle>
            <CardDescription>Set aside until you take them off hold.</CardDescription>
          </CardHeader>
          <CardContent>{list(held)}</CardContent>
        </Card>
      )}
      {unpaid.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Waiting on payment</CardTitle>
            <CardDescription>
              Not paid in full yet. They move up once the payment lands.
            </CardDescription>
          </CardHeader>
          <CardContent>{list(unpaid)}</CardContent>
        </Card>
      )}
    </>
  );
}
