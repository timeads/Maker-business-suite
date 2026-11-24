import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/lib/dashboard/format";
import { bySupplier, computeBuildAhead } from "@/lib/stock/engine/seasons";
import {
  closureOrders,
  draftOrders,
  hasLiveSupplier,
  isPlanned,
  relativeDay,
  seasonGroupItems,
  seasonLeadGroups,
} from "@/lib/stock/plan";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { setSeasonCard, startClosureOrder, startSeasonOrder, startSuggestedOrder } from "./actions";
import { CARRIER_WORDS, isCarrierStatus, type CarrierStatus } from "@/lib/stock/tracking";
import { loadIncoming, loadIncomingParcels, loadStock } from "./data";
import { RequestKey, StartOrderButton } from "./forms";
import { CheckAllButton, ParcelButtons, SyncShopButton } from "./home-parts";
import { SubmitButton } from "@/components/ui/submit-button";
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
  const [
    { rows, today, link, suppliers, seasons, settings },
    { incoming },
    { parcels, canAskUps },
  ] = await Promise.all([
    loadStock(supabase, tenant),
    loadIncoming(supabase, tenant),
    loadIncomingParcels(supabase, tenant),
  ]);
  const day = (value: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
      new Date(`${value}T12:00:00Z`),
    );
  const lateCount = incoming.filter((order) => order.late).length;
  // Where UPS is asked, the furthest-along word for an order's travelling parcels
  // (trouble first, since that is what needs a person).
  const carrierSaid = (order: (typeof incoming)[number]) => {
    const said = order.shipments
      .filter((s) => !s.arrivedOn && isCarrierStatus(s.carrierStatus))
      .map((s) => s.carrierStatus as CarrierStatus);
    const first = (["problem", "out_for_delivery", "on_the_way", "label"] as const).find((status) =>
      said.includes(status),
    );
    return first ? CARRIER_WORDS[first] : null;
  };
  const planned = rows.filter(isPlanned);
  const due = planned.filter((row) => row.due);
  const everyOrder = draftOrders(rows, today);
  // Orders that must land before a supplier shuts. One that is due now takes
  // the place of that supplier's usual order: it holds the same items and more.
  const beforeClosures = closureOrders(rows, today);
  const orders = everyOrder.filter(
    (order) => !beforeClosures.some((c) => c.dueNow && c.supplier.id === order.supplier.id),
  );
  const longDay = (value: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      ...(value.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
    }).format(new Date(`${value}T12:00:00Z`));
  // No supplier, or one marked "we don't order from them any more".
  const unassigned = due.filter((row) => !hasLiveSupplier(row));
  const out = planned.filter((row) => row.health.health === "out" && !row.plan.isDeadStock);
  const onItsWay = planned.reduce((n, row) => n + row.onOrder, 0);
  const money = (value: number) => formatMoney(value, tenant.currency);
  const overdue = planned.filter((row) => row.plan.isOverdue && row.suggestedQty > 0);
  const stats: { label: string; value: string; note: string; bad?: boolean; href?: string }[] = [
    {
      label: "Being reordered",
      value: planned.length.toLocaleString("en-US"),
      note: "items we plan for",
      href: `${base}/items?show=all`,
    },
    { label: "To order", value: String(due.length), note: "due in the next two weeks" },
    {
      label: "Overdue",
      value: String(overdue.length),
      note: overdue.length > 0 ? "past their order-by date" : "all clear",
      bad: overdue.length > 0,
      href: `${base}/items?show=all&sort=orderBy&dir=asc`,
    },
    {
      label: "Worth",
      value: money(everyOrder.reduce((sum, order) => sum + order.totalCost, 0)),
      note: "if you place every suggested order",
    },
    { label: "Sold out", value: String(out.length), note: "things people still want" },
    {
      label: "On its way",
      value: onItsWay.toLocaleString("en-US"),
      note: "units on orders you've sent",
      href: `${base}/items?show=onorder`,
    },
  ];
  const lastRead = link.lastSyncedAt
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: tenant.timezone,
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(link.lastSyncedAt))
    : null;
  // Seasons still to come, each with the last day to order from every
  // supplier (one line per lead time). Worked out here; only the season is kept.
  const cardOf = new Map(seasons.map((season) => [season.id, season.card]));
  const seasonPlans = computeBuildAhead(
    seasons.map((season) => ({
      id: season.id,
      name: season.name,
      inStockBy: season.in_stock_by,
      liftPct: season.lift_pct,
      note: season.note,
    })),
    seasonLeadGroups(rows),
    settings.review_buffer_days,
    today,
  );
  const shownSeasons = seasonPlans.filter((plan) => cardOf.get(plan.id) !== "hidden");
  const putAway = seasonPlans.length - shownSeasons.length;
  const toOrderIn = (supplierId: string, leadDays: number) =>
    seasonGroupItems(rows, supplierId, leadDays).length;

  return (
    <>
      <PageHeader
        title="Stock"
        description="What to reorder and when, worked out from what you sell and how long things take to arrive."
      >
        {link.connected && (
          <>
            <span className="text-muted-foreground text-xs">
              {lastRead ? `Shop last read ${lastRead}` : "Shop not read yet"}
            </span>
            {canEdit && <SyncShopButton slug={tenant.slug} />}
          </>
        )}
      </PageHeader>
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
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {stats.map((stat) => (
              <div key={stat.label} className="bg-card border-border rounded-lg border px-4 py-3">
                <dt className="text-muted-foreground text-xs font-semibold">
                  {stat.href ? (
                    <Link href={stat.href} className="hover:underline">
                      {stat.label}
                    </Link>
                  ) : (
                    stat.label
                  )}
                </dt>
                <dd
                  className={`mt-1 text-2xl leading-none font-bold tabular-nums ${stat.bad ? "text-brick" : ""}`}
                >
                  {stat.value}
                </dd>
                <dd className="text-muted-foreground mt-1.5 text-xs">{stat.note}</dd>
              </div>
            ))}
          </dl>

          {shownSeasons.map((plan) => {
            const groups = plan.suppliers.filter(
              (group) => toOrderIn(group.supplierId, group.leadDays) > 0,
            );
            const now = groups.filter((group) => group.status === "overdue").length;
            const soon = groups.filter((group) => group.status === "soon").length;
            const summary =
              now + soon === 0
                ? groups.length === 0
                  ? "Nothing to order"
                  : "On track"
                : [now > 0 ? `${now} to order now` : "", soon > 0 ? `${soon} due soon` : ""]
                    .filter(Boolean)
                    .join(" · ");
            const folded = cardOf.get(plan.id) === "folded";
            return (
              <Card key={`season-${plan.id}`}>
                <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 basis-80">
                    <CardTitle className="flex flex-wrap items-center gap-2">
                      {plan.name}
                      <Badge tone={now > 0 ? "bad" : soon > 0 ? "waiting" : "good"}>
                        {summary}
                      </Badge>
                    </CardTitle>
                    <CardDescription>
                      In stock by {longDay(plan.inStockBy)} · {plan.daysUntil} day
                      {plan.daysUntil === 1 ? "" : "s"} away
                      {plan.liftPct > 0 && ` · suggestions for that month raised ${plan.liftPct}%`}
                      {plan.note && ` · ${plan.note}`}
                    </CardDescription>
                  </div>
                  {canEdit && (
                    <div className="flex items-center gap-1">
                      <form
                        action={setSeasonCard.bind(
                          null,
                          tenant.slug,
                          plan.id,
                          folded ? "open" : "folded",
                        )}
                      >
                        <Button type="submit" variant="ghost" size="sm">
                          {folded ? "Open" : "Fold"}
                        </Button>
                      </form>
                      <form action={setSeasonCard.bind(null, tenant.slug, plan.id, "hidden")}>
                        <Button type="submit" variant="ghost" size="sm">
                          Put away
                        </Button>
                      </form>
                    </div>
                  )}
                </CardHeader>
                {!folded && (
                  <CardContent className="flex flex-col gap-3">
                    {plan.suppliers.length === 0 && (
                      <p className="text-muted-foreground text-sm">
                        Give your items a supplier and their order-by dates appear here.
                      </p>
                    )}
                    {bySupplier(plan.suppliers).map((supplier) => (
                      <div
                        key={supplier.supplierId}
                        className="border-border border-t pt-3 first:border-0 first:pt-0"
                      >
                        <p className="text-sm font-semibold">
                          {supplier.supplierName}{" "}
                          <span className="text-muted-foreground font-normal">
                            · {supplier.groups.reduce((n, group) => n + group.itemCount, 0)} items
                            {supplier.groups.length > 1 &&
                              ` · ${supplier.groups.length} groups by days to arrive`}
                          </span>
                        </p>
                        <ul className="mt-1.5 flex flex-col gap-1.5">
                          {supplier.groups.map((group) => {
                            const count = toOrderIn(group.supplierId, group.leadDays);
                            return (
                              <li
                                key={group.leadDays}
                                className="flex flex-wrap items-center justify-between gap-2 text-sm"
                              >
                                <span className="flex flex-wrap items-center gap-2">
                                  <span className="text-muted-foreground w-28 tabular-nums">
                                    {group.leadDays} days to arrive
                                  </span>
                                  <Badge
                                    tone={
                                      group.status === "overdue"
                                        ? "bad"
                                        : group.status === "soon"
                                          ? "waiting"
                                          : "closed"
                                    }
                                  >
                                    Order by {longDay(group.orderBy)}
                                    {group.status === "overdue"
                                      ? ": now"
                                      : group.status === "soon"
                                        ? `: ${group.daysUntilOrderBy} day${group.daysUntilOrderBy === 1 ? "" : "s"} left`
                                        : ""}
                                  </Badge>
                                  <span className="text-muted-foreground">
                                    {group.itemCount} item{group.itemCount === 1 ? "" : "s"}
                                  </span>
                                </span>
                                {canEdit &&
                                  (count > 0 ? (
                                    <form
                                      action={startSeasonOrder.bind(
                                        null,
                                        tenant.slug,
                                        group.supplierId,
                                        group.leadDays,
                                      )}
                                    >
                                      <RequestKey />
                                      <SubmitButton
                                        variant="outline"
                                        size="sm"
                                        pendingText="Drafting…"
                                      >
                                        Draft an order ({count})
                                      </SubmitButton>
                                    </form>
                                  ) : (
                                    <span className="text-muted-foreground text-xs">
                                      Nothing to order
                                    </span>
                                  ))}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                    <p className="text-muted-foreground font-read border-border border-t pt-2 text-xs">
                      &quot;Order by&quot; is the in-stock day, less the days that supplier takes,
                      less the {settings.review_buffer_days} days you leave between order reviews.
                      Items that take different times to arrive get their own line, and each line
                      drafts its own order, at amounts already raised for the season.
                    </p>
                  </CardContent>
                )}
              </Card>
            );
          })}
          {putAway > 0 && canEdit && (
            <form action={setSeasonCard.bind(null, tenant.slug, null, "show_all")}>
              <Button type="submit" variant="ghost" size="sm">
                Show {putAway} season{putAway === 1 ? "" : "s"} you put away
              </Button>
            </form>
          )}

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

          {beforeClosures.map((order) => (
            <Card key={`closure-${order.supplier.id}`}>
              <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 basis-80">
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    Order before {order.closure.name}: {longDay(order.orderBefore)}
                    {order.missed ? (
                      <Badge tone="bad">That day has passed</Badge>
                    ) : (
                      <Badge tone={order.dueNow ? "waiting" : "open"}>
                        {relativeDay(new Date(`${order.orderBefore}T00:00:00`), today)}
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription>
                    <span className="text-foreground font-semibold">{order.supplier.name}</span> is
                    shut {longDay(order.closure.startsOn)} to {longDay(order.closure.endsOn)}.{" "}
                    {order.missed
                      ? `An order placed now may not get going until they're back, arriving about ${longDay(order.expectedOn)}.`
                      : `Ordered by then, it arrives before they shut.`}{" "}
                    {order.lines.length} item{order.lines.length === 1 ? "" : "s"} ·{" "}
                    {order.totalUnits} units · {money(order.totalCost)}, enough to last until about{" "}
                    {longDay(order.nextArrival)}, when the first order after they reopen could
                    arrive
                    {order.bumpedToMinimum &&
                      ` · raised to their smallest order of ${order.supplier.moq}`}
                    .
                  </CardDescription>
                </div>
                {canEdit && (
                  <form action={startClosureOrder.bind(null, tenant.slug, order.supplier.id)}>
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
                        <th className="py-2 pr-3 text-right font-semibold">Coming</th>
                        <th className="py-2 pr-3 font-semibold">Runs out</th>
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
                            <td className="py-2 pr-3 text-right tabular-nums">
                              {row.onOrder || "–"}
                            </td>
                            <td className="py-2 pr-3">
                              {relativeDay(row.plan.stockOutDate, today)}
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

          {orders.length === 0 &&
            beforeClosures.length === 0 &&
            unassigned.length === 0 &&
            suppliers.length > 0 && (
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
                        <span className="text-muted-foreground w-40 font-mono text-xs">
                          {order.reference ?? `#${order.number}`}
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
                          <Badge tone={carrierSaid(order)?.tone ?? "open"}>
                            {carrierSaid(order)?.label ?? "Shipped"}
                          </Badge>
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

          {parcels.length > 0 && (
            <Card>
              <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Parcels on the way · {parcels.length}</CardTitle>
                  <CardDescription>
                    Each tracking number on an open order, the soonest due first.
                    {canAskUps
                      ? " UPS is asked about its own numbers every few hours."
                      : " Add tracking numbers on an order's page."}
                  </CardDescription>
                </div>
                {canEdit && canAskUps && parcels.some((parcel) => parcel.canCheck) && (
                  <CheckAllButton slug={tenant.slug} />
                )}
              </CardHeader>
              <CardContent>
                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {parcels.map((parcel) => (
                    <li
                      key={parcel.id}
                      className="border-border flex flex-col gap-2 rounded-lg border p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Badge tone={parcel.late ? "bad" : parcel.status.tone}>
                          {parcel.late && parcel.status.label !== "Late"
                            ? `${parcel.status.label}, late`
                            : parcel.status.label}
                        </Badge>
                        <span className="text-muted-foreground text-xs">
                          {parcel.expectedOn ? `Due ${day(parcel.expectedOn)}` : "No date yet"}
                        </span>
                      </div>
                      <div>
                        <span className="font-semibold">{parcel.carrier || "Carrier not set"}</span>{" "}
                        {parcel.url ? (
                          <a
                            href={parcel.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-ochre-text font-mono text-xs underline-offset-2 hover:underline"
                          >
                            {parcel.tracking}
                          </a>
                        ) : (
                          <span className="font-mono text-xs">{parcel.tracking}</span>
                        )}
                        <span className="text-muted-foreground block text-xs">
                          <Link
                            href={`${base}/orders/${parcel.orderNumber}`}
                            className="font-mono hover:underline"
                          >
                            {parcel.orderReference}
                          </Link>{" "}
                          · {parcel.supplierName}
                        </span>
                      </div>
                      {parcel.items.length > 0 ? (
                        <p className="font-read text-xs">
                          {parcel.items.map((item) => `${item.quantity} × ${item.name}`).join(", ")}
                        </p>
                      ) : (
                        <p className="text-muted-foreground text-xs">
                          What&apos;s in it hasn&apos;t been said yet
                        </p>
                      )}
                      {parcel.note && (
                        <p className="text-muted-foreground font-read text-xs">{parcel.note}</p>
                      )}
                      {canEdit && (
                        <div className="mt-auto">
                          <ParcelButtons
                            slug={tenant.slug}
                            orderId={parcel.orderId}
                            shipmentId={parcel.id}
                            canCheck={parcel.canCheck}
                          />
                        </div>
                      )}
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
                  Give these a supplier you still order from and they&apos;ll join that
                  supplier&apos;s next order.
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
                        {row.supplier ? `was ${row.supplier.name} · ` : ""}
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
