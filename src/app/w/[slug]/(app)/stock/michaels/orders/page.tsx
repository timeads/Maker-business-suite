import type { Metadata } from "next";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { buildOrderResolver, orderPreview } from "@/lib/michaels/orders";
import { createClient } from "@/lib/supabase/server";
import { loadMichaels, loadOrders } from "../data";
import { michaelsAccess } from "../gate";
import { MichaelsTabs, WatchingBanner } from "../tabs";

export const metadata: Metadata = { title: "Michaels orders" };

const STATUS_WORDS: Record<string, { label: string; tone: BadgeTone; open: boolean }> = {
  PENDING_CONFIRMATION: { label: "Waiting to be confirmed", tone: "waiting", open: true },
  READY_TO_SHIP: { label: "Ready to ship", tone: "open", open: true },
  PARTIAL_FULFILLED: { label: "Partly shipped", tone: "open", open: true },
  FULFILLED: { label: "Shipped", tone: "good", open: false },
  PARTIAL_DELIVERED: { label: "Partly delivered", tone: "good", open: false },
  DELIVERED: { label: "Delivered", tone: "good", open: false },
  COMPLETED: { label: "Finished", tone: "closed", open: false },
  CANCELLED: { label: "Cancelled", tone: "closed", open: false },
};

export default async function MichaelsOrdersPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await michaelsAccess(slug, `/w/${slug}/stock/michaels/orders`);
  if (!access.ok) return access.upsell;
  const { tenant } = access;
  const supabase = await createClient();
  const [{ settings }, { orders, listings, items }] = await Promise.all([
    loadMichaels(supabase, tenant),
    loadOrders(supabase, tenant.id),
  ]);
  const resolve = buildOrderResolver(listings, items);
  const itemNames = new Map(items.map((item) => [item.id, item.name]));
  const day = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: tenant.timezone,
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(new Date(value))
      : "–";

  return (
    <>
      <PageHeader
        title="Michaels Marketplace"
        description="Recent Michaels orders, and what bringing each into your shop would make."
        back={{ href: `/w/${tenant.slug}/stock`, label: "Stock" }}
      />
      <MichaelsTabs slug={tenant.slug} />
      <WatchingBanner />

      {orders.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No orders seen yet</CardTitle>
            <CardDescription>
              {settings.jobs.orders
                ? "Orders from the last 30 days that still need shipping, and the last week's finished ones, appear here after a look."
                : "Reading orders is switched off under Settings → Stock → Michaels."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            These are only shown. Nothing has been created in your shop, confirmed on Michaels or
            marked as shipped, and we keep no buyer&apos;s name or address. Carry on handling
            Michaels orders the way you do today.
          </p>
          {orders.map((order) => {
            const status = STATUS_WORDS[order.status] ?? {
              label: order.status,
              tone: "closed" as BadgeTone,
              open: false,
            };
            const preview = orderPreview(order, resolve);
            return (
              <Card key={order.id}>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="font-mono text-base break-all">
                      {order.order_number}
                    </CardTitle>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {status.open &&
                        (preview.wouldCreate ? (
                          <Badge tone="good">Would become a shop order</Badge>
                        ) : (
                          <Badge tone="bad">Couldn&apos;t be brought in yet</Badge>
                        ))}
                    </div>
                  </div>
                  <CardDescription>
                    Placed {day(order.placed_at)}
                    {status.open && order.promise_ship_at
                      ? `, to ship by ${day(order.promise_ship_at)}`
                      : ""}
                    {order.grand_total ? `. Paid $${order.grand_total} on Michaels.` : "."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {status.open && preview.problems.length > 0 && (
                    <ul className="text-brick list-disc pl-5 text-sm">
                      {preview.problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  )}
                  {status.open && preview.wouldCreate && (
                    <p className="text-muted-foreground text-sm">
                      Bringing it in would make one paid shop order of {preview.units} unit
                      {preview.units === 1 ? "" : "s"} (${preview.itemsTotal} of items), with no
                      emails to the buyer, and take those units off your shop&apos;s count.
                    </p>
                  )}
                  {preview.lines.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[520px] text-left text-sm">
                        <thead className="text-muted-foreground text-xs">
                          <tr>
                            <th className="py-2 pr-3 font-semibold">Ordered on Michaels</th>
                            <th className="py-2 pr-3 font-semibold">In your shop</th>
                            <th className="py-2 pr-3 text-right font-semibold">Qty</th>
                            <th className="py-2 text-right font-semibold">Each</th>
                          </tr>
                        </thead>
                        <tbody className="divide-border divide-y">
                          {preview.lines.map((line) => (
                            <tr key={line.order_item_id}>
                              <td className="py-2 pr-3">
                                <div>{line.product_name ?? "Unnamed"}</div>
                                <div className="text-muted-foreground font-mono text-xs break-all">
                                  {line.seller_sku ??
                                    `Michaels no. ${line.michaels_sku_number ?? "?"}`}
                                </div>
                              </td>
                              <td className="py-2 pr-3">
                                {line.item_id ? (
                                  (itemNames.get(line.item_id) ?? "Matched")
                                ) : (
                                  <Badge tone="bad">SKU not known</Badge>
                                )}
                              </td>
                              <td className="py-2 pr-3 text-right tabular-nums">{line.quantity}</td>
                              <td className="py-2 text-right tabular-nums">
                                {line.unit_price ? `$${line.unit_price}` : "–"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </>
      )}
    </>
  );
}
