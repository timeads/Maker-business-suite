import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/lib/dashboard/format";
import { aggregateSpend, monthsBefore } from "@/lib/stock/spend";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { loadSpendLines, stockToday } from "../data";
import { stockAccess } from "../gate";
import { StockTabs } from "../tabs";

export const metadata: Metadata = { title: "Stock spend" };

const RANGES = [
  { key: "3", label: "3 months", months: 3 },
  { key: "6", label: "6 months", months: 6 },
  { key: "12", label: "12 months", months: 12 },
  { key: "all", label: "All time", months: null },
] as const;
const ITEM_LIMIT = 200;

export default async function StockSpendPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/spend`);
  if (!access.ok) return access.upsell;
  const { tenant, role } = access;
  const { range } = await searchParams;
  const active = RANGES.find((r) => r.key === range) ?? RANGES[1];
  const base = `/w/${tenant.slug}/stock`;
  const header = (
    <>
      <PageHeader
        title="Stock"
        description="What you've spent with suppliers: the items on orders you've sent, without shipping or tax."
      />
      <StockTabs slug={tenant.slug} manager={canManage(role)} />
    </>
  );
  if (!canManage(role)) {
    return (
      <>
        {header}
        <p className="text-muted-foreground text-sm">Spend is for owners and admins.</p>
      </>
    );
  }

  const lines = await loadSpendLines(await createClient(), tenant);
  const today = new Date(`${stockToday(tenant.timezone)}T00:00:00Z`);
  const data = aggregateSpend(lines, active.months ? monthsBefore(today, active.months) : null);
  const money = (value: string) => formatMoney(Number(value), tenant.currency);
  const monthName = (month: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", year: "numeric" }).format(
      new Date(`${month}-01T12:00:00Z`),
    );
  const day = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(
      new Date(iso),
    );
  const biggestMonth = Math.max(1, ...data.byMonth.map((m) => Number(m.spend)));
  const stats = [
    {
      label: `Spent · ${active.label.toLowerCase()}`,
      value: money(data.total),
      note: `${data.poCount} order${data.poCount === 1 ? "" : "s"}`,
    },
    { label: "Items", value: String(data.bySku.length), note: "different things ordered" },
    { label: "Suppliers", value: String(data.byVendor.length), note: "ordered from" },
    {
      label: "Most with",
      value: data.byVendor[0]?.supplierName ?? "–",
      note: data.byVendor[0] ? money(data.byVendor[0].spend) : "",
    },
  ];

  return (
    <>
      {header}
      <nav aria-label="Range" className="flex flex-wrap gap-1 print:hidden">
        {RANGES.map((r) => (
          <Link
            key={r.key}
            href={`${base}/spend?range=${r.key}`}
            aria-current={active.key === r.key ? "page" : undefined}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs whitespace-nowrap transition-colors duration-150",
              active.key === r.key
                ? "bg-teal font-semibold text-white"
                : "text-text-2 hover:bg-hover",
            )}
          >
            {r.label}
          </Link>
        ))}
      </nav>

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="bg-card border-border rounded-lg border px-4 py-3">
            <dt className="text-muted-foreground text-xs font-semibold">{stat.label}</dt>
            <dd className="mt-1 truncate text-2xl leading-none font-bold tabular-nums">
              {stat.value}
            </dd>
            <dd className="text-muted-foreground mt-1.5 text-xs">{stat.note}</dd>
          </div>
        ))}
      </dl>

      {data.lineCount === 0 ? (
        <Card>
          <CardContent className="pt-5">
            <p className="text-sm">
              Nothing was ordered in this time. Spend counts orders once you&apos;ve marked them as
              sent; drafts and cancelled orders are left out.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>By month</CardTitle>
                <CardDescription>Counted in the month each order was sent.</CardDescription>
              </CardHeader>
              <CardContent>
                <table className="w-full text-left text-sm">
                  <thead className="text-muted-foreground text-xs">
                    <tr>
                      <th className="w-28 py-2 pr-3 font-semibold">Month</th>
                      <th className="py-2 pr-3 font-semibold" aria-label="Share of the biggest" />
                      <th className="w-28 py-2 text-right font-semibold">Spent</th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {data.byMonth.map((m) => (
                      <tr key={m.month}>
                        <td className="py-2 pr-3 whitespace-nowrap">{monthName(m.month)}</td>
                        <td className="py-2 pr-3">
                          <span
                            aria-hidden
                            className="block h-2.5 rounded-sm bg-[var(--chart-1)]"
                            style={{
                              width: `${Math.max(1, Math.round((Number(m.spend) / biggestMonth) * 100))}%`,
                            }}
                          />
                        </td>
                        <td className="py-2 text-right tabular-nums">{money(m.spend)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>By supplier</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-left text-sm">
                    <thead className="text-muted-foreground text-xs">
                      <tr>
                        <th className="py-2 pr-3 font-semibold">Supplier</th>
                        <th className="py-2 pr-3 text-right font-semibold">Items</th>
                        <th className="py-2 pr-3 text-right font-semibold">Units</th>
                        <th className="py-2 pr-3 text-right font-semibold">Orders</th>
                        <th className="py-2 text-right font-semibold">Spent</th>
                      </tr>
                    </thead>
                    <tbody className="divide-border divide-y tabular-nums">
                      {data.byVendor.map((v) => (
                        <tr key={v.supplierId}>
                          <td className="py-2 pr-3 font-semibold">{v.supplierName}</td>
                          <td className="py-2 pr-3 text-right">{v.skuCount}</td>
                          <td className="py-2 pr-3 text-right">
                            {v.units.toLocaleString("en-US")}
                          </td>
                          <td className="py-2 pr-3 text-right">{v.poCount}</td>
                          <td className="py-2 text-right">{money(v.spend)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>By item</CardTitle>
              <CardDescription>
                The most spent on first
                {data.bySku.length > ITEM_LIMIT
                  ? `: the top ${ITEM_LIMIT} of ${data.bySku.length}.`
                  : "."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="text-muted-foreground text-xs">
                    <tr>
                      <th className="py-2 pr-3 font-semibold">Item</th>
                      <th className="py-2 pr-3 font-semibold">Supplier</th>
                      <th className="py-2 pr-3 text-right font-semibold">Units</th>
                      <th className="py-2 pr-3 text-right font-semibold">Orders</th>
                      <th className="py-2 pr-3 font-semibold">Last ordered</th>
                      <th className="py-2 text-right font-semibold">Spent</th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y tabular-nums">
                    {data.bySku.slice(0, ITEM_LIMIT).map((s) => (
                      <tr key={s.sku ?? `title:${s.title}`}>
                        <td className="py-2 pr-3">
                          <span className="font-read">{s.title}</span>
                          {s.sku && (
                            <span className="text-muted-foreground block text-xs">{s.sku}</span>
                          )}
                        </td>
                        <td className="py-2 pr-3">{s.supplierName}</td>
                        <td className="py-2 pr-3 text-right">{s.units.toLocaleString("en-US")}</td>
                        <td className="py-2 pr-3 text-right">{s.poCount}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{day(s.lastOrdered)}</td>
                        <td className="py-2 text-right">{money(s.spend)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
