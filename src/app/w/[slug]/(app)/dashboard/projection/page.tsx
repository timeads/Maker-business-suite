import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HowWorkedOut } from "@/components/setup/how-worked-out";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth";
import { projectionExplained } from "@/lib/dashboard/explain";
import { formatMoney, formatPercent } from "@/lib/dashboard/format";
import { monthName } from "@/lib/dashboard/inbox";
import { OTHER } from "@/lib/dashboard/projection";
import { loadProjection } from "@/lib/dashboard/projection-data";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";

export const metadata: Metadata = { title: "Projection" };

/**
 * Money → Projection: three years on from the books' last twelve complete
 * months, each line, cost of goods and running costs grown by its own
 * yearly rate (Settings → Money → Projection). The whole team can look.
 */
export default async function ProjectionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/projection`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const base = `/w/${tenant.slug}`;
  const view = await loadProjection(await createClient(), tenant);
  const money = (cents: number) => formatMoney(cents / 100, tenant.currency);
  const lineName = (id: string) =>
    id === OTHER ? "Other revenue" : `${view.lines.find((l) => l.id === id)?.name ?? id} revenue`;
  const years = view.years ?? [];
  const keys = [...(years[0]?.byLine.keys() ?? [])];
  const row = (label: string, values: string[], strong = false) => (
    <tr key={label} className="border-border border-b last:border-0">
      <th scope="row" className={`py-2 pr-3 text-left ${strong ? "font-semibold" : "font-normal"}`}>
        {label}
      </th>
      {values.map((v, i) => (
        <td
          key={i}
          className={`px-2 py-2 text-right tabular-nums ${strong ? "font-semibold" : ""}`}
        >
          {v}
        </td>
      ))}
    </tr>
  );
  const share = (s: number | null) => (s === null ? "—" : formatPercent(s));

  return (
    <>
      <PageHeader
        title="Projection"
        description="Where three more years at your own growth rates would take revenue, costs and profit."
      >
        {view.years && (
          <Button asChild variant="ghost" size="sm">
            <a href={`${base}/dashboard/projection/export`}>Download as a spreadsheet</a>
          </Button>
        )}
        <Button asChild variant="outline" size="sm">
          <Link href={`${base}/settings/money/projection`}>Change the rates</Link>
        </Button>
      </PageHeader>
      {!view.years ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing from your books to start from yet</CardTitle>
            <CardDescription>
              The projection starts from your books&apos; last twelve complete months. Once
              QuickBooks is connected and read, it fills in.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href={`${base}/connections`}>Go to Connections</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profit and loss, three years on</CardTitle>
            <CardDescription>
              Starting from {monthName(view.months[0])} to {monthName(view.months.at(-1)!)}
              {view.booked < 12 ? ` (${view.booked} of those months are in your books)` : ""}.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <caption className="sr-only">The projection, year by year</caption>
              <thead className="text-muted-foreground text-xs">
                <tr className="border-border border-b">
                  <th scope="col" className="py-2 pr-3 text-left font-medium" />
                  {years.map((y) => (
                    <th key={y.label} scope="col" className="px-2 py-2 text-right font-medium">
                      {y.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keys.map((k) =>
                  row(
                    lineName(k),
                    years.map((y) => money(y.byLine.get(k) ?? 0)),
                  ),
                )}
                {row(
                  "Revenue",
                  years.map((y) => money(y.revenue)),
                  true,
                )}
                {row(
                  "Cost of goods",
                  years.map((y) => money(y.cogs)),
                )}
                {row(
                  "Gross profit",
                  years.map((y) => money(y.grossProfit)),
                  true,
                )}
                {row(
                  "Gross margin",
                  years.map((y) => share(y.grossShare)),
                )}
                {row(
                  "Running costs",
                  years.map((y) => money(y.costs)),
                )}
                {row(
                  "Net income",
                  years.map((y) => money(y.net)),
                  true,
                )}
                {row(
                  "Net margin",
                  years.map((y) => share(y.netShare)),
                )}
              </tbody>
            </table>
            <div className="mt-4">
              <HowWorkedOut
                lines={projectionExplained(view.settings, view.lines)}
                change={{ href: `${base}/settings/money/projection`, label: "Change the rates" }}
              />
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
