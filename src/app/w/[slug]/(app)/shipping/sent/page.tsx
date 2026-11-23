import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/lib/dashboard/format";
import { countryName } from "@/lib/shipping/carriers";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { canManage } from "@/lib/tenants";
import { loadShippingSetup } from "../data";
import { ParcelForm, VoidButton } from "../forms";
import { shippingAccess } from "../gate";
import { ShippingTabs } from "../tabs";

export const metadata: Metadata = { title: "Sent parcels" };

type Parcel = {
  id: string;
  number: number;
  order_name: string | null;
  recipient: string | null;
  destination: string | null;
  carrier: string;
  service: string;
  tracking_number: string;
  tracking_url: string | null;
  cost: number | null;
  shipped_at: string;
  voided_at: string | null;
  shop_status: string;
  shop_error: string | null;
};

/** Worked out in the database (`shipping_report`), so the sums are exact. */
type Report = {
  days: number;
  parcels: number;
  priced: number;
  orders: number;
  postage: number;
  collected: number;
  margin: number;
  avg_days: number | null;
  destinations: { country: string; region: string | null; parcels: number }[];
};
const RANGES = [30, 90] as const;

export default async function SentParcelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { slug } = await params;
  const range = (await searchParams).range === "90" ? 90 : 30;
  const access = await shippingAccess(slug, `/w/${slug}/shipping/sent`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const supabase = await createClient();
  const [{ data }, setup, { data: reported }] = await Promise.all([
    supabase
      .from("shipments")
      .select(
        "id, number, order_name, recipient, destination, carrier, service, tracking_number, tracking_url, cost, shipped_at, voided_at, shop_status, shop_error",
      )
      .eq("tenant_id", tenant.id)
      .order("number", { ascending: false })
      .limit(300),
    loadShippingSetup(supabase, tenant.id),
    supabase.rpc("shipping_report", { p_tenant_id: tenant.id, p_days: range }),
  ]);
  const parcels = (data ?? []) as Parcel[];
  const report = (reported ?? null) as Report | null;
  const money = (value: number) => formatMoney(Number(value), tenant.currency);
  const home = setup.settings.ship_from_country;
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const manager = canManage(role) && entitlements.canWrite;

  return (
    <>
      <PageHeader
        title="Shipping"
        description="What shipping cost you against what shoppers paid, and every parcel you've recorded, newest first."
      />
      <ShippingTabs slug={tenant.slug} />

      {report && (
        <section aria-labelledby="report-title" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="report-title" className="text-base font-bold">
              Report
            </h2>
            <nav aria-label="Report range" className="flex gap-1">
              {RANGES.map((days) => (
                <Link
                  key={days}
                  href={
                    days === 30
                      ? `/w/${tenant.slug}/shipping/sent`
                      : `/w/${tenant.slug}/shipping/sent?range=${days}`
                  }
                  scroll={false}
                  aria-current={days === range ? "page" : undefined}
                  className={cn(
                    "rounded-full px-3 py-1 text-sm whitespace-nowrap transition-colors duration-150",
                    days === range
                      ? "bg-teal font-semibold text-white"
                      : "text-text-2 hover:bg-hover",
                  )}
                >
                  Last {days} days
                </Link>
              ))}
            </nav>
          </div>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {[
              {
                label: "Parcels sent",
                value: String(report.parcels),
                note: `for ${report.orders} order${report.orders === 1 ? "" : "s"}`,
              },
              {
                label: "Postage spent",
                value: report.priced ? money(report.postage) : "–",
                note: report.priced
                  ? report.priced < report.parcels
                    ? `${report.parcels - report.priced} parcel${report.parcels - report.priced === 1 ? " has" : "s have"} no cost noted`
                    : "what you paid the carriers"
                  : "note the cost when you record one",
              },
              {
                label: "Shipping collected",
                value: report.orders ? money(report.collected) : "–",
                note: "what shoppers paid at checkout",
              },
              {
                label: "Margin",
                value:
                  report.priced && report.orders
                    ? `${report.margin < 0 ? "−" : "+"}${money(Math.abs(report.margin))}`
                    : "–",
                note:
                  report.margin < 0
                    ? "postage cost more than you collected"
                    : "collected, less postage",
                bad: report.priced > 0 && report.orders > 0 && report.margin < 0,
              },
              {
                label: "Order to shipped",
                value: report.avg_days === null ? "–" : `${report.avg_days} days`,
                note: "on average, to the first parcel",
              },
            ].map((stat) => (
              <div key={stat.label} className="bg-card border-border rounded-lg border px-4 py-3">
                <dt className="text-muted-foreground text-xs font-semibold">{stat.label}</dt>
                <dd
                  className={cn(
                    "mt-1 text-2xl leading-none font-bold tabular-nums",
                    stat.bad && "text-brick",
                  )}
                >
                  {stat.value}
                </dd>
                <dd className="text-muted-foreground mt-1.5 text-xs">{stat.note}</dd>
              </div>
            ))}
          </dl>
          {report.destinations.length > 0 && (
            <div className="bg-card border-border rounded-lg border px-4 py-3">
              <h3 className="text-muted-foreground text-xs font-semibold">Top destinations</h3>
              <ol className="mt-2 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
                {report.destinations.map((place) => (
                  <li
                    key={`${place.country}-${place.region ?? ""}`}
                    className="flex justify-between gap-3"
                  >
                    <span className="truncate">
                      {place.country === home
                        ? (place.region ?? countryName(place.country))
                        : [place.region, countryName(place.country)].filter(Boolean).join(", ")}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {place.parcels} parcel{place.parcels === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}

      <Card>
        <CardContent className="pt-5">
          {parcels.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing sent yet. Parcels show here once you record them.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr>
                    <th className="py-2 pr-3 font-semibold">Parcel</th>
                    <th className="py-2 pr-3 font-semibold">To</th>
                    <th className="py-2 pr-3 font-semibold">Carrier</th>
                    <th className="py-2 pr-3 font-semibold">Tracking</th>
                    <th className="py-2 pr-3 text-right font-semibold">Postage</th>
                    <th className="py-2 pr-3 font-semibold">Sent</th>
                    {manager && <th className="py-2" aria-label="Undo" />}
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {parcels.map((parcel) => (
                    <tr key={parcel.id} className={parcel.voided_at ? "opacity-55" : undefined}>
                      <td className="py-2.5 pr-3 tabular-nums">
                        {parcel.number}
                        {parcel.order_name && (
                          <span className="text-muted-foreground block text-xs">
                            {parcel.order_name}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className="font-read">{parcel.recipient ?? "–"}</span>
                        <span className="text-muted-foreground block text-xs">
                          {parcel.destination}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3">
                        {parcel.carrier}
                        <span className="text-muted-foreground block text-xs">
                          {parcel.service}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3">
                        {parcel.tracking_url ? (
                          <a
                            href={parcel.tracking_url}
                            className="text-ochre-text font-medium hover:underline"
                            rel="noreferrer"
                            target="_blank"
                          >
                            {parcel.tracking_number}
                          </a>
                        ) : (
                          parcel.tracking_number || "–"
                        )}
                        <span className="mt-0.5 flex flex-wrap gap-1">
                          {parcel.voided_at && <Badge>Undone</Badge>}
                          {!parcel.voided_at && parcel.shop_status === "sent" && (
                            <Badge tone="good">Marked in shop</Badge>
                          )}
                          {!parcel.voided_at &&
                            ["pending", "sending"].includes(parcel.shop_status) && (
                              <Badge tone="open">Telling your shop</Badge>
                            )}
                          {!parcel.voided_at && parcel.shop_status === "failed" && (
                            <Badge tone="bad">Shop not updated</Badge>
                          )}
                        </span>
                        {!parcel.voided_at && parcel.shop_status === "failed" && (
                          <span className="text-muted-foreground block text-xs">
                            {parcel.shop_error}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">
                        {parcel.cost === null
                          ? "–"
                          : formatMoney(Number(parcel.cost), tenant.currency)}
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        {when.format(new Date(parcel.shipped_at))}
                      </td>
                      {manager && (
                        <td className="py-2.5 text-right">
                          {!parcel.voided_at && (
                            <VoidButton slug={tenant.slug} shipmentId={parcel.id} />
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {entitlements.canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>Record a parcel that isn&apos;t an order</CardTitle>
            <CardDescription>A replacement, a sample, something for a stockist.</CardDescription>
          </CardHeader>
          <CardContent>
            <ParcelForm
              slug={tenant.slug}
              orderId={null}
              lines={[]}
              defaultCarrier={setup.settings.default_carrier}
              shopOffered={false}
              shopDefault={false}
              notifyDefault={false}
              currency={tenant.currency}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}
