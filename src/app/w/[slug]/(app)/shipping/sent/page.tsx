import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { daysFromNow } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/dashboard/format";
import { createClient } from "@/lib/supabase/server";
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

export default async function SentParcelsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/shipping/sent`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const supabase = await createClient();
  const [{ data }, setup] = await Promise.all([
    supabase
      .from("shipments")
      .select(
        "id, number, order_name, recipient, destination, carrier, service, tracking_number, tracking_url, cost, shipped_at, voided_at, shop_status, shop_error",
      )
      .eq("tenant_id", tenant.id)
      .order("number", { ascending: false })
      .limit(300),
    loadShippingSetup(supabase, tenant.id),
  ]);
  const parcels = (data ?? []) as Parcel[];
  const live = parcels.filter((parcel) => !parcel.voided_at);
  const month = live.filter((parcel) => parcel.shipped_at >= daysFromNow(-30));
  const spent = month.reduce((sum, parcel) => sum + Number(parcel.cost ?? 0), 0);
  const priced = month.filter((parcel) => parcel.cost !== null).length;
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
      <PageHeader title="Shipping" description="Every parcel you've recorded, newest first." />
      <ShippingTabs slug={tenant.slug} />

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="bg-card border-border rounded-lg border px-4 py-3">
          <dt className="text-muted-foreground text-xs font-semibold">Last 30 days</dt>
          <dd className="mt-1 text-2xl leading-none font-bold tabular-nums">{month.length}</dd>
          <dd className="text-muted-foreground mt-1.5 text-xs">parcels sent</dd>
        </div>
        <div className="bg-card border-border rounded-lg border px-4 py-3">
          <dt className="text-muted-foreground text-xs font-semibold">Postage</dt>
          <dd className="mt-1 text-2xl leading-none font-bold tabular-nums">
            {priced ? formatMoney(spent, tenant.currency) : "–"}
          </dd>
          <dd className="text-muted-foreground mt-1.5 text-xs">
            {priced ? `across ${priced} with a cost noted` : "note the cost when you record one"}
          </dd>
        </div>
      </dl>

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
