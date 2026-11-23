import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/lib/dashboard/format";
import { draftOrders, isPlanned, relativeDay } from "@/lib/stock/plan";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { startSuggestedOrder } from "./actions";
import { loadIncoming, loadStock } from "./data";
import { StartOrderButton } from "./forms";
import { stockAccess } from "./gate";
import { StockTabs } from "./tabs";

export const metadata: Metadata = { title: "Stock" };

export default async function StockPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}/stock`;

  const supabase = await createClient();
  const [{ rows, today, link, suppliers }, { incoming }] = await Promise.all([
    loadStock(supabase, tenant),
    loadIncoming(supabase, tenant),
  ]);
  const day = (value: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
      new Date(`${value}T12:00:00Z`),
    );
  const lateCount = incoming.filter((order) => order.late).length;
  const planned = rows.filter(isPlanned);
  const due = planned.filter((row) => row.due);
  const orders = draftOrders(rows, today);
  const unassigned = due.filter((row) => !row.supplier);
  const out = planned.filter((row) => row.health.health === "out" && !row.plan.isDeadStock);
  const onItsWay = planned.reduce((n, row) => n + row.onOrder, 0);
  const money = (value: number) => formatMoney(value, tenant.currency);
  const stats = [
    { label: "To order", value: String(due.length), note: "items due in the next two weeks" },
    {
      label: "Worth",
      value: money(orders.reduce((sum, order) => sum + order.totalCost, 0)),
      note: "if you place every suggested order",
    },
    { label: "Sold out", value: String(out.length), note: "things people still want" },
    { label: "On its way", value: String(onItsWay), note: "units on orders you've sent" },
  ];

  return (
    <>
      <PageHeader
        title="Stock"
        description="What to reorder and when, worked out from what you sell and how long things take to arrive."
      />
      <StockTabs slug={tenant.slug} manager={canManage(role)} />

      {rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {link.connected ? "Your shop's items are on their way" : "Connect your shop first"}
            </CardTitle>
            <CardDescription>
              {link.connected
                ? "We're reading what you stock from your shop. It appears here after the next sync, usually within the hour."
                : "Stock reads your items, their counts and your sales from your shop, then tells you what to reorder."}
            </CardDescription>
          </CardHeader>
          {!link.connected && (
            <CardContent>
              <Button asChild>
                <Link href={`/w/${tenant.slug}/connections`}>Go to Connections</Link>
              </Button>
            </CardContent>
          )}
        </Card>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {stats.map((stat) => (
              <div key={stat.label} className="bg-card border-border rounded-lg border px-4 py-3">
                <dt className="text-muted-foreground text-xs font-semibold">{stat.label}</dt>
                <dd className="mt-1 text-2xl leading-none font-bold tabular-nums">{stat.value}</dd>
                <dd className="text-muted-foreground mt-1.5 text-xs">{stat.note}</dd>
              </div>
            ))}
          </dl>

          {suppliers.length === 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Add who you buy from</CardTitle>
                <CardDescription>
                  Tell us your suppliers and how long each takes to deliver. Then we can group what
                  you need into one order for each of them.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline">
                  <Link href={`${base}/suppliers`}>Add a supplier</Link>
                </Button>
              </CardContent>
            </Card>
          )}

          {orders.length === 0 && unassigned.length === 0 && suppliers.length > 0 && (
            <Card>
              <CardContent className="pt-5">
                <p className="text-sm">
                  Nothing needs ordering right now. We&apos;ll list it here when it does.
                </p>
              </CardContent>
            </Card>
          )}

          {orders.map((order) => (
            <Card key={order.supplier.id}>
              <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>{order.supplier.name}</CardTitle>
                  <CardDescription>
                    {order.lines.length} item{order.lines.length === 1 ? "" : "s"} ·{" "}
                    {order.totalUnits} units · {money(order.totalCost)} · arrives about{" "}
                    {relativeDay(new Date(`${order.expectedOn}T00:00:00`), today)}
                    {order.bumpedToMinimum &&
                      ` · raised to their smallest order of ${order.supplier.moq}`}
                  </CardDescription>
                </div>
                {canEdit && (
                  <form action={startSuggestedOrder.bind(null, tenant.slug, order.supplier.id)}>
                    <StartOrderButton />
                  </form>
                )}
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <thead className="text-muted-foreground text-xs">
                      <tr>
                        <th className="py-2 pr-3 font-semibold">Item</th>
                        <th className="py-2 pr-3 text-right font-semibold">Have</th>
                        <th className="py-2 pr-3 font-semibold">Runs out</th>
                        <th className="py-2 pr-3 font-semibold">Order by</th>
                        <th className="py-2 text-right font-semibold">Order</th>
                      </tr>
                    </thead>
                    <tbody className="divide-border divide-y">
                      {order.lines.map((line) => {
                        const row = rows.find((r) => r.item.id === line.stock_item_id)!;
                        return (
                          <tr key={line.stock_item_id}>
                            <td className="py-2 pr-3">
                              <Link
                                href={`${base}/items/${row.item.id}`}
                                className="font-read hover:underline"
                              >
                                {line.name}
                              </Link>
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">
                              {row.item.on_hand}
                            </td>
                            <td className="py-2 pr-3">
                              {relativeDay(row.plan.stockOutDate, today)}
                            </td>
                            <td className="py-2 pr-3">
                              {row.plan.isOverdue ? (
                                <Badge tone="bad">{relativeDay(row.plan.reorderDate, today)}</Badge>
                              ) : (
                                relativeDay(row.plan.reorderDate, today)
                              )}
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              <span className="font-semibold">{line.qty}</span>
                              {line.cases && (
                                <span className="text-muted-foreground block text-xs">
                                  {line.cases}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ))}

          {incoming.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Incoming</CardTitle>
                <CardDescription>
                  Orders you&apos;ve sent that haven&apos;t all arrived, the longest-awaited first
                  {lateCount > 0 ? `. ${lateCount} ${lateCount === 1 ? "is" : "are"} late.` : "."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-border flex flex-col divide-y">
                  {incoming.map((order) => (
                    <li key={order.id}>
                      <Link
                        href={`${base}/orders/${order.number}`}
                        className="hover:bg-hover -mx-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-sm px-2 py-2.5 text-sm"
                      >
                        <span className="text-muted-foreground w-14 tabular-nums">
                          #{order.number}
                        </span>
                        <span className="min-w-0 flex-1 basis-40 font-semibold">
                          {order.supplierName}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {order.units} unit{order.units === 1 ? "" : "s"} to come
                          {order.shipments.length > 0 &&
                            ` · ${order.shipments.length} tracking number${order.shipments.length === 1 ? "" : "s"}`}
                        </span>
                        {order.stage === "arrived" ? (
                          <Badge tone="good">Here: check it in</Badge>
                        ) : order.late ? (
                          <Badge tone="bad">
                            {order.daysLate} day{order.daysLate === 1 ? "" : "s"} late
                          </Badge>
                        ) : order.stage === "shipped" ? (
                          <Badge tone="open">Shipped</Badge>
                        ) : (
                          <Badge tone="closed">Not shipped yet</Badge>
                        )}
                        <span className="text-muted-foreground w-28 text-right">
                          {order.stage === "arrived"
                            ? ""
                            : order.expected
                              ? `due ${day(order.expected)}`
                              : "no date yet"}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {unassigned.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Running low, with no supplier yet</CardTitle>
                <CardDescription>
                  Give these a supplier and they&apos;ll join that supplier&apos;s next order.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-border flex flex-col divide-y text-sm">
                  {unassigned.slice(0, 25).map((row) => (
                    <li
                      key={row.item.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2"
                    >
                      <Link
                        href={`${base}/items/${row.item.id}`}
                        className="font-read min-w-0 flex-1 basis-48 hover:underline"
                      >
                        {row.name}
                      </Link>
                      <span className="text-muted-foreground tabular-nums">
                        {row.item.on_hand} left · runs out{" "}
                        {relativeDay(row.plan.stockOutDate, today)}
                      </span>
                    </li>
                  ))}
                </ul>
                {unassigned.length > 25 && (
                  <p className="text-muted-foreground mt-2 text-xs">
                    And {unassigned.length - 25} more under{" "}
                    <Link href={`${base}/items?show=under`} className="underline">
                      Everything
                    </Link>
                    .
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </>
  );
}
