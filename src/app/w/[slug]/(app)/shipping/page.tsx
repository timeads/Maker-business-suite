import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { daysFromNow } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/dashboard/format";
import { countryName, hasAddress } from "@/lib/shipping/carriers";
import { orderRefusal } from "@/lib/shipping/bulk";
import { MOST_SHOWN, NO_PLAN, orderAge } from "@/lib/shipping/list";
import { NO_MEMORY } from "@/lib/shipping/memory";
import { dismissedKeys, liveSavedGroups, mergeSuggestions } from "@/lib/shipping/merge";
import { choiceOf, planCell, planFor } from "@/lib/shipping/plan";
import {
  QUEUE_VIEWS,
  cleanSearch,
  formatHoldDate,
  formatWeight,
  holdChoices,
  holdState,
  inQueueView,
  isInternational,
  isOpen,
  isPriority,
  isQueueView,
  queueCounts,
  shipStatus,
  todayIn,
  type QueueView,
} from "@/lib/shipping/queue";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import {
  ORDER_FIELDS,
  itemsSummary,
  loadBoxes,
  loadGroups,
  loadLabelConnections,
  loadOpenLabelOrders,
  loadOpenOrders,
  loadPackingMemory,
  loadPlans,
  loadShippingSetup,
  placeOf,
  planSetupOf,
  withRuleFacts,
  type ShippingOrder,
} from "./data";
import { shippingAccess } from "./gate";
import { ListFreshness, PrintingChip, RuleHolds } from "./list-tools";
import { QueueTable, type QueueRow } from "./queue-table";
import { ShippingTabs } from "./tabs";
import { TogetherBanners, type TogetherGroup } from "./together-ui";

export const metadata: Metadata = { title: "Shipping" };

/** The queues where orders are posted, so where "Ship together?" is worth asking. */
const TOGETHER_VIEWS: QueueView[] = ["ready", "priority", "international", "all"];

const EMPTY: Record<QueueView, string> = {
  ready: "All caught up. New orders appear here as they come in.",
  pickup: "Nobody is waiting to collect an order.",
  priority: "No rush orders right now.",
  signature: "Nothing waiting needs a signature.",
  unpaid: "Every open order has been paid for.",
  hold: "Nothing is on hold.",
  international: "Nothing is waiting to go abroad.",
  all: "No open orders.",
};

export default async function ShippingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ sent?: string; view?: string; q?: string }>;
}) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/shipping`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  const base = `/w/${tenant.slug}/shipping`;
  const query = await searchParams;
  const justSent = /^\d{1,9}$/.test(query.sent ?? "") ? query.sent : null;
  const view: QueueView = isQueueView(query.view) ? query.view : "ready";
  const q = cleanSearch(query.q);

  const supabase = await createClient();
  const [loaded, setup, groups, boxes, postage, labelOpen, found] = await Promise.all([
    loadOpenOrders(supabase, tenant.id),
    loadShippingSetup(supabase, tenant.id),
    loadGroups(supabase, tenant.id),
    loadBoxes(supabase, tenant.id),
    loadLabelConnections(supabase, tenant.id),
    loadOpenLabelOrders(supabase, tenant.id),
    q
      ? supabase
          .from("shipping_orders")
          .select(ORDER_FIELDS)
          .eq("tenant_id", tenant.id)
          .or(`name.ilike."%${q}%",email.ilike."%${q}%",recipient.ilike."%${q}%"`)
          .order("placed_at", { ascending: false })
          .limit(100)
      : null,
  ]);
  const now = new Date(daysFromNow(0));
  const today = todayIn(tenant.timezone, now);
  const home = setup.settings.ship_from_country;
  const signatureOver = setup.settings.signature_over;
  const bare = planSetupOf({ shipping: setup, boxes, postage, memory: NO_MEMORY }, tenant.currency);
  // The rules have their say first: who needs a signature, and which orders they hold.
  // A hold shows here straight away; `RuleHolds` below writes it down for every other screen.
  const ruled = withRuleFacts(loaded, bare);
  const open = ruled.orders;
  const counts = queueCounts(open, today, home, signatureOver);
  // A search can turn up orders that aren't open; the open ones come as the list has them.
  const openById = new Map(open.map((order) => [order.id, order]));
  const matching = found
    ? ((found.data ?? []) as unknown as ShippingOrder[]).map(
        (order) => openById.get(order.id) ?? { ...order, order_total: null },
      )
    : open.filter((order) => inQueueView(order, view, today, home, signatureOver));
  const shown = matching.slice(0, MOST_SHOWN);
  const unprinted = open.filter(
    (order) => inQueueView(order, "ready", today, home) && !order.slip_printed_at,
  );
  // What the list already knows about each order shown: its box, best price and address check.
  const [plans, memory] = await Promise.all([
    loadPlans(
      supabase,
      tenant.id,
      shown.filter(isOpen).map((order) => order.id),
    ),
    loadPackingMemory(supabase, tenant.id, shown.filter(isOpen)),
  ]);
  const planSetup = { ...bare, memory };
  // Whatever is missing is worked out once the list is on screen, a few orders at a time.
  const willFill = entitlements.canWrite && !q;

  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
  });
  // "Nov 20, 5:03 PM", for hovering over an order's age.
  const placed = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  // Orders that could share a box, and groups someone saved to finish.
  const offerTogether = !q && TOGETHER_VIEWS.includes(view);
  const savedTogether: TogetherGroup[] = offerTogether
    ? liveSavedGroups(groups, open, today).map(({ savedAt, ...group }) => ({
        ...group,
        saved: `saved ${day.format(new Date(savedAt))}`,
      }))
    : [];
  const savedKeys = new Set(savedTogether.map((group) => group.key));
  const suggested: TogetherGroup[] = offerTogether
    ? mergeSuggestions(open, dismissedKeys(groups), today).filter(
        (group) => !savedKeys.has(group.key),
      )
    : [];
  // Orders that are waiting to go in one parcel, or could: a bulk run leaves those for their own page.
  const partners = new Map<string, string[]>();
  for (const group of [
    ...liveSavedGroups(groups, open, today),
    ...mergeSuggestions(open, dismissedKeys(groups), today),
  ]) {
    group.orderIds.forEach((orderId, index) => {
      const others = group.names.filter((_, at) => at !== index);
      partners.set(
        orderId,
        [...new Set([...(partners.get(orderId) ?? []), ...others])].slice(0, 3),
      );
    });
  }
  const ruleHeld = new Set(ruled.holds.map((held) => held.id));
  const rows: QueueRow[] = shown.map((order) => {
    const stillOpen = isOpen(order);
    const hold = stillOpen ? holdState(order, today) : "none";
    const plan = stillOpen
      ? planFor(order, choiceOf(plans.get(order.id)), order.order_total, planSetup)
      : null;
    return {
      id: order.id,
      name: order.name ?? "Order",
      age: orderAge(order.placed_at, now, tenant.timezone),
      placed: placed.format(new Date(order.placed_at)),
      customer: order.recipient ?? order.email ?? "No name on this order",
      email: order.email,
      itemCount: order.items.reduce((sum, item) => sum + (stillOpen ? item.left : item.qty), 0),
      items: stillOpen
        ? itemsSummary(order)
        : order.items.map((item) => `${item.qty} × ${item.title}`).join(", "),
      weight: formatWeight(order.weight_grams, home === "US"),
      chose: order.shipping_method ?? "–",
      priority: stillOpen && isPriority(order.shipping_method),
      paid:
        order.shipping_paid === null
          ? "–"
          : Number(order.shipping_paid) === 0
            ? "Free"
            : formatMoney(Number(order.shipping_paid), tenant.currency),
      place: order.pickup ? "Collecting" : placeOf(order, home, countryName) || "No address",
      needsAddress: stillOpen && !order.pickup && !hasAddress(order),
      open: stillOpen,
      status: stillOpen ? null : shipStatus(order, today).label,
      hold,
      holdUntil: hold === "held" && order.hold_until ? formatHoldDate(order.hold_until) : "",
      holdNote: order.hold_reason,
      unpaid: !order.paid,
      pickup: order.pickup,
      pickupReady: Boolean(order.pickup_ready_at),
      partSent: stillOpen && order.items.some((item) => item.left < item.qty),
      slipPrinted: Boolean(order.slip_printed_at),
      signature: Boolean(plan?.signature) && !order.pickup,
      adultSignature: plan?.signatureKind === "adult" && !order.pickup,
      heldByRule: ruleHeld.has(order.id),
      bulkWhy: stillOpen
        ? orderRefusal({
            cancelled: order.cancelled,
            unitsLeft: order.units_left,
            pickedUp: Boolean(order.picked_up_at),
            hold,
            ruleHold: null,
            paid: order.paid,
            pickup: order.pickup,
            abroad: isInternational(order.country_code, home),
            partSent: order.items.some((item) => item.left < item.qty),
            labelOpen: labelOpen.has(order.id),
            togetherWith: partners.get(order.id) ?? [],
          })
        : "Everything on it has already gone.",
      plan: plan
        ? planCell(plan, plans.get(order.id), {
            now,
            willFill,
            paidCents:
              order.shipping_paid === null ? null : Math.round(Number(order.shipping_paid) * 100),
            currency: tenant.currency,
            imperial: home === "US",
            money: formatMoney,
          })
        : NO_PLAN,
    };
  });

  return (
    <>
      <PageHeader
        title="Shipping"
        description="Orders waiting to ship, labels from every carrier, packing slips and the packing station."
      >
        <PrintingChip href={`/w/${tenant.slug}/settings/shipping/printing#printing`} />
        {counts.ready > 0 && (
          <Button asChild variant="outline" size="sm">
            <Link href={`${base}/slips`}>
              Print packing slips
              {unprinted.length > 0 && unprinted.length < counts.ready
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

      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <nav aria-label="Queues" className="flex min-w-0 flex-1 flex-wrap gap-1">
          {QUEUE_VIEWS.map((chip) => {
            const active = chip.key === view && !q;
            return (
              <Link
                key={chip.key}
                href={chip.key === "ready" ? base : `${base}?view=${chip.key}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition-colors duration-150",
                  active ? "bg-teal font-semibold text-white" : "text-text-2 hover:bg-hover",
                )}
              >
                {chip.label}
                <span className="ml-1.5 tabular-nums opacity-80">{counts[chip.key]}</span>
              </Link>
            );
          })}
        </nav>
        <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:flex-nowrap">
          <ListFreshness readAt={now.getTime()} />
          <form action={base} role="search" className="w-full min-w-0 sm:w-72">
            <Input
              name="q"
              type="search"
              defaultValue={q}
              maxLength={60}
              placeholder="Find any order — #, email or name"
              aria-label="Find any order"
            />
          </form>
        </div>
      </div>

      {q && (
        <p className="text-sm">
          {matching.length === 0
            ? `Nothing matches “${q}”.`
            : `${matching.length === 100 ? "The newest 100 orders" : matching.length === 1 ? "1 order" : `${matching.length} orders`} matching “${q}”, sent or not.`}{" "}
          <Link href={view === "ready" ? base : `${base}?view=${view}`} className="underline">
            Clear the search
          </Link>
        </p>
      )}

      {entitlements.canWrite && ruled.holds.length > 0 && (
        <RuleHolds slug={tenant.slug} count={ruled.holds.length} />
      )}

      {(savedTogether.length > 0 || suggested.length > 0) && (
        <TogetherBanners
          slug={tenant.slug}
          suggestions={suggested}
          saved={savedTogether}
          canWrite={entitlements.canWrite}
        />
      )}

      {rows.length === 0 ? (
        !q && (
          <p className="bg-card border-border text-muted-foreground rounded-lg border px-4 py-8 text-center text-sm">
            {setup.connected || open.length > 0
              ? EMPTY[view]
              : "Connect your shop under Connections and your orders to ship will appear here."}
          </p>
        )
      ) : (
        <QueueTable
          slug={tenant.slug}
          rows={rows}
          canWrite={entitlements.canWrite}
          today={today}
          choices={holdChoices(today)}
          view={found ? "all" : view}
          fill={willFill ? view : undefined}
          currency={tenant.currency}
          canBuy={entitlements.canWrite && postage.active.length > 0}
        />
      )}
      {matching.length > shown.length && (
        <p className="text-muted-foreground text-sm">
          Showing the oldest {shown.length} of {matching.length}. Use a chip or the search to narrow
          it down.
        </p>
      )}
    </>
  );
}
