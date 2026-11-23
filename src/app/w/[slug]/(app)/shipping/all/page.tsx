import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { daysFromNow } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/dashboard/format";
import {
  HISTORY_VIEWS,
  cleanSearch,
  isHistoryView,
  shipStatus,
  todayIn,
  type HistoryView,
} from "@/lib/shipping/queue";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { ORDER_FIELDS, type ShippingOrder } from "../data";
import { shippingAccess } from "../gate";
import { ShippingTabs } from "../tabs";

export const metadata: Metadata = { title: "All orders" };

const STEP = 50;
/** One request returns 1,000 rows at most; past that, the search finds older orders. */
const MOST = 1000;

type Row = ShippingOrder & {
  orders:
    | { total: number; currency: string | null; financial_status: string | null }
    | { total: number; currency: string | null; financial_status: string | null }[]
    | null;
  shipments:
    | {
        carrier: string;
        tracking_number: string;
        tracking_url: string | null;
        voided_at: string | null;
      }[]
    | null;
};

/** "PARTIALLY_PAID" -> "Partially paid". */
const human = (value: string | null | undefined) =>
  value
    ? value
        .toLowerCase()
        .replace(/_/g, " ")
        .replace(/^./, (c) => c.toUpperCase())
    : "–";

export default async function AllOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ view?: string; q?: string; limit?: string }>;
}) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/shipping/all`);
  if (!access.ok) return access.upsell;
  const { tenant } = access;
  const base = `/w/${tenant.slug}/shipping`;
  const query = await searchParams;
  const view: HistoryView = isHistoryView(query.view) ? query.view : "all";
  const q = cleanSearch(query.q);
  const asked = Number.parseInt(query.limit ?? "", 10);
  const limit = Math.min(MOST, Math.max(STEP, Number.isFinite(asked) ? asked : STEP));
  const href = (next: { view?: HistoryView; q?: string; limit?: number }) => {
    const search = new URLSearchParams();
    const v = next.view ?? view;
    const text = next.q ?? q;
    if (v !== "all") search.set("view", v);
    if (text) search.set("q", text);
    if (next.limit && next.limit > STEP) search.set("limit", String(next.limit));
    const tail = search.toString();
    return `${base}/all${tail ? `?${tail}` : ""}`;
  };

  const supabase = await createClient();
  let request = supabase
    .from("shipping_orders")
    .select(
      `${ORDER_FIELDS}, orders(total, currency, financial_status), shipments(carrier, tracking_number, tracking_url, voided_at)`,
    )
    .eq("tenant_id", tenant.id)
    // Orders with nothing that goes in a box (a gift card, a class) aren't shipping's business.
    .neq("items", "[]")
    .order("placed_at", { ascending: false })
    .order("id")
    // One more than shown, to know whether there is more.
    .range(0, Math.min(limit, MOST - 1));
  if (view === "to_ship") {
    request = request.eq("cancelled", false).gt("units_left", 0).is("picked_up_at", null);
  } else if (view === "shipped") {
    request = request.eq("cancelled", false).or("units_left.eq.0,picked_up_at.not.is.null");
  } else if (view === "cancelled") {
    request = request.eq("cancelled", true);
  }
  if (q) request = request.or(`name.ilike."%${q}%",email.ilike."%${q}%",recipient.ilike."%${q}%"`);
  const { data } = await request;
  const all = (data ?? []) as unknown as Row[];
  const rows = all.slice(0, limit);
  const more = all.length > limit || all.length >= MOST;

  const today = todayIn(tenant.timezone, new Date(daysFromNow(0)));
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const th = "py-2 pr-4 text-left font-semibold whitespace-nowrap";
  const td = "py-2.5 pr-4 align-top";

  return (
    <>
      <PageHeader
        title="Shipping"
        description="Every order with something to send, newest first, whether it has gone or not."
      />
      <ShippingTabs slug={tenant.slug} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <nav aria-label="Filter orders" className="flex flex-1 flex-wrap gap-1">
          {HISTORY_VIEWS.map((chip) => (
            <Link
              key={chip.key}
              href={href({ view: chip.key })}
              aria-current={chip.key === view ? "page" : undefined}
              className={cn(
                "rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition-colors duration-150",
                chip.key === view
                  ? "bg-teal font-semibold text-white"
                  : "text-text-2 hover:bg-hover",
              )}
            >
              {chip.label}
            </Link>
          ))}
        </nav>
        <form action={`${base}/all`} role="search" className="flex w-full gap-2 sm:w-80">
          {view !== "all" && <input type="hidden" name="view" value={view} />}
          <Input
            name="q"
            type="search"
            defaultValue={q}
            maxLength={60}
            placeholder="Order #, email or name"
            aria-label="Search all orders"
          />
        </form>
      </div>

      {rows.length === 0 ? (
        <p className="bg-card border-border text-muted-foreground rounded-lg border px-4 py-8 text-center text-sm">
          {q ? `Nothing matches “${q}”.` : "No orders here yet."}
        </p>
      ) : (
        <div className="bg-card border-border overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="text-muted-foreground border-border border-b text-xs">
              <tr>
                <th className={`${th} pl-4`}>Order</th>
                <th className={th}>Customer</th>
                <th className={th}>Items</th>
                <th className={`${th} text-right`}>Total</th>
                <th className={th}>Payment</th>
                <th className={th}>Status</th>
                <th className={th}>Tracking</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {rows.map((order) => {
                const sale = Array.isArray(order.orders) ? order.orders[0] : order.orders;
                const status = shipStatus(order, today);
                const parcels = (order.shipments ?? []).filter(
                  (parcel) => !parcel.voided_at && parcel.tracking_number,
                );
                const units = order.items.reduce((sum, item) => sum + item.qty, 0);
                return (
                  <tr key={order.id} className="hover:bg-hover/60">
                    <td className={`${td} pl-4 whitespace-nowrap`}>
                      <Link
                        href={`${base}/orders/${order.id}`}
                        className="text-ochre-text font-semibold tabular-nums hover:underline"
                      >
                        {order.name ?? "Order"}
                      </Link>
                      <span className="text-muted-foreground block text-xs">
                        {day.format(new Date(order.placed_at))}
                      </span>
                    </td>
                    <td className={td}>
                      <span className="font-read font-semibold">
                        {order.recipient ?? order.email ?? "–"}
                      </span>
                      <span className="text-muted-foreground font-read block text-xs">
                        {order.pickup
                          ? "Collecting"
                          : [order.city, order.region || order.country_code]
                              .filter(Boolean)
                              .join(", ")}
                      </span>
                    </td>
                    <td className={`${td} max-w-[26rem]`}>
                      <span className="tabular-nums">
                        {units} item{units === 1 ? "" : "s"}
                      </span>
                      <span className="text-muted-foreground font-read block truncate text-xs">
                        {order.items.map((item) => `${item.qty} × ${item.title}`).join(", ")}
                      </span>
                    </td>
                    <td className={`${td} text-right whitespace-nowrap tabular-nums`}>
                      {sale
                        ? formatMoney(Number(sale.total), sale.currency ?? tenant.currency)
                        : "–"}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {order.paid ? (
                        human(sale?.financial_status ?? "PAID")
                      ) : (
                        <Badge tone="waiting">{human(sale?.financial_status ?? "PENDING")}</Badge>
                      )}
                    </td>
                    <td className={td}>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </td>
                    <td className={td}>
                      {parcels.length === 0
                        ? "–"
                        : parcels.map((parcel) => (
                            <span key={parcel.tracking_number} className="block whitespace-nowrap">
                              <span className="text-muted-foreground">{parcel.carrier} </span>
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
                                parcel.tracking_number
                              )}
                            </span>
                          ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-muted-foreground text-sm">
        Showing {rows.length} order{rows.length === 1 ? "" : "s"}.{" "}
        {more && limit < MOST && (
          <Link
            href={href({ limit: Math.min(MOST, limit + STEP) })}
            scroll={false}
            className="text-ochre-text font-semibold hover:underline"
          >
            Load more
          </Link>
        )}
        {more &&
          limit >= MOST &&
          "That's as far back as this list goes. Search to find an older one."}
      </p>
    </>
  );
}
