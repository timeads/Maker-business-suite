import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatWhen } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/dashboard/format";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { bookingsAccess } from "../gate";
import { BringBackButton, PlaceOnDateForm, type DateChoice } from "../shop-orders";

export const metadata: Metadata = { title: "Needs a date" };

type Marker = {
  id: string;
  provider: string;
  shop_order_id: string;
  line_id: string;
  shop_order_name: string;
  service_id: string | null;
  seats: number;
  order_cancelled: boolean;
  dismissed_at: string | null;
  created_at: string;
  services: { name: string } | null;
};
type OrderRow = {
  id: string;
  provider: string;
  external_id: string;
  email: string | null;
  customer_external_id: string | null;
};
type DateRow = {
  id: string;
  service_id: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  bookings: { seats: number; status: string }[];
};

const key = (provider: string, id: string) => `${provider}:${id}`;

/**
 * Shop orders that paid for a workshop with no usable date on them, waiting
 * for a manager to put them on one. Everything about who bought is read, as
 * the member, from what the shop sync already stored.
 */
export default async function NeedsDatePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/needs-date`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}/bookings`;

  const supabase = await createClient();
  const { data: markerRows } = await supabase
    .from("shop_undated_lines")
    .select(
      "id, provider, shop_order_id, line_id, shop_order_name, service_id, seats, order_cancelled, dismissed_at, created_at, services(name)",
    )
    .eq("tenant_id", tenant.id)
    .is("booking_id", null)
    .gt("seats", 0)
    .eq("order_cancelled", false)
    .order("created_at")
    .limit(200);
  const markers = (markerRows ?? []) as unknown as Marker[];
  const waiting = markers.filter((m) => !m.dismissed_at);
  const aside = markers.filter((m) => m.dismissed_at);

  const orderIds = [...new Set(markers.map((m) => m.shop_order_id))];
  const [{ data: orderRows }, { data: dateRows }, { data: workshopRows }] = await Promise.all([
    orderIds.length
      ? supabase
          .from("orders")
          .select("id, provider, external_id, email, customer_external_id")
          .eq("tenant_id", tenant.id)
          .in("external_id", orderIds)
      : Promise.resolve({ data: [] }),
    supabase
      .from("sessions")
      .select("id, service_id, starts_at, ends_at, capacity, bookings(seats, status)")
      .eq("tenant_id", tenant.id)
      .is("cancelled_at", null)
      .gte("starts_at", new Date().toISOString())
      .order("starts_at")
      .limit(300),
    supabase
      .from("services")
      .select("id, name")
      .eq("tenant_id", tenant.id)
      .eq("kind", "workshop")
      .order("name"),
  ]);
  const orders = (orderRows ?? []) as OrderRow[];
  const orderBy = new Map(orders.map((o) => [key(o.provider, o.external_id), o]));
  const customerIds = [...new Set(orders.map((o) => o.customer_external_id).filter(Boolean))];
  const [{ data: customerRows }, { data: lineRows }] = await Promise.all([
    customerIds.length
      ? supabase
          .from("customers")
          .select("provider, external_id, first_name, last_name")
          .eq("tenant_id", tenant.id)
          .in("external_id", customerIds as string[])
      : Promise.resolve({ data: [] }),
    orders.length
      ? supabase
          .from("order_lines")
          .select("order_id, external_id, title, variant_title, unit_price")
          .eq("tenant_id", tenant.id)
          .in(
            "order_id",
            orders.map((o) => o.id),
          )
      : Promise.resolve({ data: [] }),
  ]);
  const nameBy = new Map(
    (
      (customerRows ?? []) as {
        provider: string;
        external_id: string;
        first_name: string | null;
        last_name: string | null;
      }[]
    ).map((c) => [
      key(c.provider, c.external_id),
      [c.first_name, c.last_name].filter(Boolean).join(" ").trim(),
    ]),
  );
  const lineBy = new Map(
    (
      (lineRows ?? []) as {
        order_id: string;
        external_id: string;
        title: string;
        variant_title: string | null;
        unit_price: number;
      }[]
    ).map((l) => [`${l.order_id}:${l.external_id}`, l]),
  );

  const dates = (dateRows ?? []) as unknown as DateRow[];
  const choice = (d: DateRow): DateChoice => ({
    id: d.id,
    label: formatWhen(d.starts_at, d.ends_at, tenant.timezone),
    left: Math.max(
      0,
      d.capacity -
        d.bookings.filter((b) => b.status === "confirmed").reduce((n, b) => n + b.seats, 0),
    ),
  });
  const workshopName = new Map(
    ((workshopRows ?? []) as { id: string; name: string }[]).map((w) => [w.id, w.name]),
  );
  /** The dates a line can go on: its own workshop's, or any workshop's when we can't tell. */
  const datesFor = (serviceId: string | null): DateChoice[] =>
    dates
      .filter((d) => (serviceId ? d.service_id === serviceId : workshopName.has(d.service_id)))
      .map((d) =>
        serviceId
          ? choice(d)
          : { ...choice(d), label: `${workshopName.get(d.service_id)} · ${choice(d).label}` },
      );

  const describe = (m: Marker) => {
    const order = orderBy.get(key(m.provider, m.shop_order_id));
    const line = order ? lineBy.get(`${order.id}:${m.line_id}`) : undefined;
    const name = order?.customer_external_id
      ? nameBy.get(key(order.provider, order.customer_external_id))
      : "";
    return {
      who: name || order?.email || "Someone",
      email: order?.email ?? "",
      what:
        m.services?.name ??
        (line ? [line.title, line.variant_title].filter(Boolean).join(" · ") : "A workshop"),
      paid: line ? Math.round(Number(line.unit_price) * 100) * m.seats : 0,
    };
  };
  const day = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tenant.timezone,
      month: "short",
      day: "numeric",
    }).format(new Date(iso));

  return (
    <>
      <PageHeader
        title="Needs a date"
        description="Orders from your shop that paid for a workshop without choosing a date. Nobody is booked in until you put them on one."
      />
      {waiting.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing waiting</CardTitle>
            <CardDescription>
              When someone buys a workshop in your shop without a date (the shop&apos;s “Buy again”
              button does this), the order shows up here and you&apos;re told in Messages.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href={base} className="text-sm underline">
              Back to what&apos;s coming up
            </Link>
          </CardContent>
        </Card>
      ) : (
        waiting.map((m) => {
          const about = describe(m);
          return (
            <Card key={m.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span>Order {m.shop_order_name || m.shop_order_id}</span>
                  <Badge tone="waiting">Needs a date</Badge>
                  <Badge tone="open">{m.seats === 1 ? "1 place" : `${m.seats} places`}</Badge>
                </CardTitle>
                <CardDescription>
                  <span className="font-read">
                    {about.who}
                    {about.email && about.email !== about.who && ` · ${about.email}`}
                  </span>
                  {" · "}
                  {about.what}
                  {about.paid > 0 && ` · paid ${formatMoney(about.paid / 100, tenant.currency)}`}
                  {" · "}arrived {day(m.created_at)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {manager ? (
                  <PlaceOnDateForm
                    slug={tenant.slug}
                    line={{
                      id: m.id,
                      provider: m.provider,
                      orderId: m.shop_order_id,
                      lineId: m.line_id,
                    }}
                    dates={datesFor(m.service_id)}
                    seats={m.seats}
                    hasEmail={Boolean(about.email)}
                  />
                ) : (
                  <p className="text-muted-foreground text-sm">
                    An owner or admin can put them on a date.
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })
      )}

      {aside.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Set aside</CardTitle>
            <CardDescription>
              Orders you&apos;ve dealt with some other way. They aren&apos;t booked onto any date.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-border flex flex-col divide-y">
              {aside.map((m) => {
                const about = describe(m);
                return (
                  <li
                    key={m.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                  >
                    <span className="text-sm">
                      <span className="font-semibold">
                        Order {m.shop_order_name || m.shop_order_id}
                      </span>
                      {" · "}
                      <span className="font-read">{about.who}</span>
                      {" · "}
                      {about.what} · {m.seats === 1 ? "1 place" : `${m.seats} places`}
                    </span>
                    {manager && <BringBackButton slug={tenant.slug} lineId={m.id} />}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
