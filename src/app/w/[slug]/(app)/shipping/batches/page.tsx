import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/lib/dashboard/format";
import { parseBatchOrders } from "@/lib/shipping/batches";
import { shownBoxes } from "@/lib/shipping/labels";
import { createClient } from "@/lib/supabase/server";
import { shippingAccess } from "../gate";
import { ShippingTabs } from "../tabs";
import { BatchReprint, type BatchLabel } from "./reprint";

export const metadata: Metadata = { title: "Label batches" };

type Batch = {
  id: string;
  number: number;
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
  orders: unknown;
  order_count: number;
  bought_count: number;
  total: number | string;
  currency: string | null;
};

type Parcel = {
  id: string;
  number: number;
  tracking_number: string | null;
  tracking_url: string | null;
  label_url: string | null;
  label_parcels: unknown;
  voided_at: string | null;
};

/** Every bulk run of labels: who ran it, what was bought, what was left, and its labels to print again. */
export default async function LabelBatchesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/shipping/batches`);
  if (!access.ok) return access.upsell;
  const { tenant, user } = access;
  const base = `/w/${tenant.slug}/shipping`;
  const supabase = await createClient();
  const [{ data }, { data: roster }] = await Promise.all([
    supabase
      .from("shipping_label_batches")
      .select(
        "id, number, created_by, created_at, finished_at, orders, order_count, bought_count, total, currency",
      )
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.rpc("list_members", { p_tenant_id: tenant.id }),
  ]);
  const batches = ((data ?? []) as Batch[]).map((batch) => ({
    ...batch,
    orders: parseBatchOrders(batch.orders),
  }));
  const who = new Map(
    ((roster ?? []) as { user_id: string; email: string }[]).map((member) => [
      member.user_id,
      member.email,
    ]),
  );
  // The parcels these runs made, for printing their labels again.
  const numbers = [
    ...new Set(
      batches.flatMap((batch) =>
        batch.orders.flatMap((order) => (order.shipmentNumber ? [order.shipmentNumber] : [])),
      ),
    ),
  ];
  const parcels = new Map<number, Parcel>();
  for (let from = 0; from < numbers.length; from += 200) {
    const { data: rows } = await supabase
      .from("shipments")
      .select("id, number, tracking_number, tracking_url, label_url, label_parcels, voided_at")
      .eq("tenant_id", tenant.id)
      .in("number", numbers.slice(from, from + 200));
    for (const row of (rows ?? []) as Parcel[]) parcels.set(row.number, row);
  }
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <>
      <PageHeader
        title="Shipping"
        description="Every time labels were bought for several orders at once: what was bought, what was left out, and the labels to print again."
      />
      <ShippingTabs slug={tenant.slug} />
      {batches.length === 0 ? (
        <p className="bg-card border-border text-muted-foreground rounded-lg border px-4 py-8 text-center text-sm">
          No runs yet. On To ship, tick two or more orders and press Buy labels: each run is kept
          here.
        </p>
      ) : (
        batches.map((batch) => {
          const labels: BatchLabel[] = batch.orders.flatMap((order) => {
            const parcel = order.shipmentNumber ? parcels.get(order.shipmentNumber) : undefined;
            if (order.status !== "bought" || !parcel || parcel.voided_at) return [];
            return [
              {
                shipmentId: parcel.id,
                name: order.name,
                links: shownBoxes({
                  tracking_number: parcel.tracking_number,
                  tracking_url: parcel.tracking_url,
                  label_url: parcel.label_url,
                  boxes: parcel.label_parcels,
                })
                  .map((box) => box.labelUrl)
                  .filter((href): href is string => Boolean(href)),
              },
            ];
          });
          const open = batch.orders.filter(
            (order) => order.status === "waiting" || order.status === "buying",
          ).length;
          const unsure = batch.orders.filter((order) => order.status === "unsure").length;
          return (
            <Card key={batch.id}>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div>
                    <CardTitle>
                      Run {batch.number} · {when.format(new Date(batch.created_at))}
                    </CardTitle>
                    <CardDescription>
                      {batch.created_by === user.id
                        ? "You"
                        : (who.get(batch.created_by ?? "") ?? "Someone on the team")}{" "}
                      · {batch.order_count === 1 ? "1 order" : `${batch.order_count} orders`} ·{" "}
                      {batch.bought_count === 1 ? "1 label" : `${batch.bought_count} labels`} bought
                      {batch.bought_count > 0 && batch.currency
                        ? ` · ${formatMoney(Number(batch.total), batch.currency)}`
                        : ""}
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {unsure > 0 && (
                      <Badge tone="bad">
                        {unsure === 1 ? "1 needs a look" : `${unsure} need a look`}
                      </Badge>
                    )}
                    {open > 0 && <Badge tone="waiting">Didn&apos;t finish</Badge>}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {labels.length > 0 && <BatchReprint slug={tenant.slug} labels={labels} />}
                <ul className="divide-border divide-y text-sm">
                  {batch.orders.map((order) => (
                    <li
                      key={order.orderId}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2"
                    >
                      <Link
                        href={`${base}/orders/${order.orderId}`}
                        className="w-20 shrink-0 font-bold tabular-nums hover:underline"
                      >
                        {order.name}
                      </Link>
                      {order.status === "bought" ? (
                        <>
                          <span className="text-mint-ink font-semibold">Bought</span>
                          <span className="min-w-0 flex-1">
                            {order.service ?? "Label"}
                            {order.price && order.currency && (
                              <>
                                {" "}
                                ·{" "}
                                <b className="tabular-nums">
                                  {formatMoney(Number(order.price), order.currency)}
                                </b>
                              </>
                            )}
                            {order.shipmentNumber && (
                              <span className="text-muted-foreground">
                                {" "}
                                · parcel {order.shipmentNumber}
                                {parcels.get(order.shipmentNumber)?.voided_at ? " (voided)" : ""}
                              </span>
                            )}
                          </span>
                        </>
                      ) : order.status === "skipped" ? (
                        <>
                          <span className="text-text-2 font-semibold">Skipped</span>
                          <span className="text-muted-foreground min-w-0 flex-1 basis-64">
                            {order.reason ?? ""}
                          </span>
                        </>
                      ) : order.status === "unsure" ? (
                        <>
                          <span className="text-brick font-semibold">Needs a look</span>
                          <span className="min-w-0 flex-1 basis-64">
                            {order.reason ??
                              "Open the order: a label may have been bought. See “Labels to finish”."}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">
                          {order.status === "buying"
                            ? "Was being bought when the run stopped. Open the order to see whether a label was bought."
                            : "Not reached: the run stopped first. Nothing was bought."}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })
      )}
    </>
  );
}
