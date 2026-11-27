import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth";
import { loadDashboardConfig, loadRevenueSettings } from "@/lib/dashboard/data";
import { formatMoney } from "@/lib/dashboard/format";
import { FIGURE_WORDS } from "@/lib/dashboard/lines";
import {
  ORDER_LINE_CAP,
  ORDER_PAGE,
  PAYMENT_STATUSES,
  PAYMENT_WORDS,
  linesOfOrder,
  orderCents,
  orderHref,
  paymentWords,
  parseOrderQuery,
} from "@/lib/dashboard/orders";
import { pageRange } from "@/lib/dashboard/range";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import { RangePicker } from "../range-picker";
import { loadOrderList } from "./data";

export const metadata: Metadata = { title: "Orders" };

/**
 * Money → Orders: the shop's orders for the range with the business lines
 * each one's items fall in, by payment status, line and words, all in the
 * address. Cancelled and test orders never show, as they never count.
 */
export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/orders`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const base = `/w/${tenant.slug}`;
  const here = `${base}/dashboard/orders`;
  const params2 = await searchParams;
  const query = parseOrderQuery(params2);

  const supabase = await createClient();
  const revenue = await loadRevenueSettings(supabase, tenant.id);
  const { config } = await loadDashboardConfig(supabase, tenant.id, revenue);
  const raw = Array.isArray(params2.range) ? params2.range[0] : params2.range;
  const shown = pageRange(raw, config.range, new Date(), tenant.timezone);
  const line = revenue.lines.find((l) => l.id === query.line) ?? null;
  const asked = { ...query, line: line?.id ?? null };
  const list = await loadOrderList(supabase, tenant.id, revenue, shown.range, asked, {
    limit: ORDER_PAGE,
    offset: (query.page - 1) * ORDER_PAGE,
  });
  const pages = Math.max(1, Math.ceil(list.total / ORDER_PAGE));
  const href = (change: Parameters<typeof orderHref>[3]) =>
    orderHref(here, shown.value, asked, change);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <>
      <PageHeader
        title="Orders"
        description={`Your shop's orders and the business lines they fall in, ${shown.phrase}.`}
      >
        {list.total > 0 && (
          <Button asChild variant="ghost" size="sm">
            <a href={orderHref(`${here}/export`, shown.value, asked, {})}>
              Download as a spreadsheet
            </a>
          </Button>
        )}
      </PageHeader>
      <RangePicker here={here} shown={shown} timezone={tenant.timezone} />

      <form action={here} className="flex flex-wrap items-end gap-2" role="search">
        <input type="hidden" name="range" value={shown.value} />
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Search</span>
          <input
            name="q"
            defaultValue={query.q}
            placeholder="Order number or tag"
            className="border-input bg-card h-9 w-full rounded-sm border px-3 text-sm sm:w-64"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Payment</span>
          <select
            name="status"
            defaultValue={query.status?.toLowerCase() ?? ""}
            className="border-input bg-card h-9 rounded-sm border px-2 text-sm"
          >
            <option value="">Any</option>
            {PAYMENT_STATUSES.map((s) => (
              <option key={s} value={s.toLowerCase()}>
                {PAYMENT_WORDS[s]}
              </option>
            ))}
          </select>
        </label>
        {revenue.lines.length > 0 && (
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Business line</span>
            <select
              name="line"
              defaultValue={line?.id ?? ""}
              className="border-input bg-card h-9 rounded-sm border px-2 text-sm"
            >
              <option value="">Every line</option>
              {revenue.lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button type="submit" variant="outline">
          Show
        </Button>
        {(query.q || query.status || line) && (
          <Button asChild variant="ghost">
            <Link href={href({ q: "", status: null, line: null })}>Clear</Link>
          </Button>
        )}
      </form>

      <p className="text-muted-foreground text-sm" role="status">
        {list.total === 0
          ? "No orders match."
          : `${list.total.toLocaleString("en-US")} ${list.total === 1 ? "order" : "orders"}. Revenue is ${FIGURE_WORDS[revenue.figure].lower}.`}
        {list.capped &&
          ` Only the latest ${ORDER_LINE_CAP.toLocaleString("en-US")} orders are looked through for one line; pick a shorter range for all of them.`}
      </p>

      {list.rows.length > 0 && (
        <div className="bg-card overflow-x-auto rounded-md border">
          <table className="w-full min-w-[40rem] text-sm">
            <caption className="sr-only">Orders from your shop</caption>
            <thead className="text-muted-foreground text-xs">
              <tr className="border-border border-b text-left">
                <th scope="col" className="px-3 py-2 font-medium">
                  Date
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Order
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Payment
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Lines
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Tags
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Revenue
                </th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((o) => (
                <tr key={o.id} className="border-border border-b last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap">
                    {day.format(new Date(o.processed_at))}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{o.name ?? "–"}</td>
                  <td className="px-3 py-2">
                    <Badge
                      tone={
                        o.financial_status?.toUpperCase() === "PAID"
                          ? "good"
                          : /REFUND|VOID/.test(o.financial_status?.toUpperCase() ?? "")
                            ? "closed"
                            : "waiting"
                      }
                    >
                      {paymentWords(o.financial_status)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {linesOfOrder(revenue, o)
                      .map((l) => l.name)
                      .join(", ") || "–"}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-xs">
                    {o.tags.join(", ") || "–"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMoney(orderCents(revenue, o) / 100, tenant.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav aria-label="Pages" className="flex items-center gap-2 text-sm">
          {query.page > 1 && (
            <Button asChild variant="outline" size="sm">
              <Link href={href({ page: query.page - 1 })}>Newer</Link>
            </Button>
          )}
          <span className="text-muted-foreground">
            Page {query.page} of {pages}
          </span>
          {query.page < pages && (
            <Button asChild variant="outline" size="sm">
              <Link href={href({ page: query.page + 1 })}>Older</Link>
            </Button>
          )}
        </nav>
      )}
    </>
  );
}
