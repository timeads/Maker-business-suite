import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth";
import { loadDashboardConfig, loadRevenueSettings } from "@/lib/dashboard/data";
import { formatMoney, formatPercent } from "@/lib/dashboard/format";
import { monthName } from "@/lib/dashboard/inbox";
import { pageRange, rangeMonths } from "@/lib/dashboard/range";
import { balanceSheet, incomeStatement, type StatementLine } from "@/lib/dashboard/statements";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import { RangePicker } from "../range-picker";

export const metadata: Metadata = { title: "Statements" };

const asOf = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );

/**
 * Money → Statements: the income statement for the range, line by line as
 * the books lay it out, and the latest balance sheet in full. Read from what
 * the QuickBooks sync keeps; nothing here changes the books. The whole team
 * can look, as they can look at the rest of Money.
 */
export default async function StatementsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/statements`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const base = `/w/${tenant.slug}`;
  const here = `${base}/dashboard/statements`;

  const supabase = await createClient();
  const revenue = await loadRevenueSettings(supabase, tenant.id);
  const { config } = await loadDashboardConfig(supabase, tenant.id, revenue);
  const shown = pageRange((await searchParams).range, config.range, new Date(), tenant.timezone);
  const months = rangeMonths(shown.range, tenant.timezone);
  const [pnl, sheet] = await Promise.all([
    supabase
      .from("financial_snapshots")
      .select("period_start, data")
      .eq("tenant_id", tenant.id)
      .eq("kind", "profit_and_loss")
      .gte("period_start", `${months[0] ?? "0000-01"}-01`)
      .lte("period_start", `${months.at(-1) ?? "0000-01"}-01`)
      .order("period_start")
      .limit(400),
    supabase
      .from("financial_snapshots")
      .select("period_start, data")
      .eq("tenant_id", tenant.id)
      .eq("kind", "balance_sheet")
      .order("period_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (pnl.error) throw new Error(`Could not load the books: ${pnl.error.message}`);
  const booked = ((pnl.data ?? []) as { period_start: string; data: Record<string, unknown> }[])
    .filter((m) => months.includes(m.period_start.slice(0, 7)))
    .map((m) => ({ month: m.period_start.slice(0, 7), data: m.data ?? {} }));
  const statement = incomeStatement(booked);
  const latest =
    (sheet.data as { period_start: string; data: Record<string, unknown> } | null) ?? null;
  const balance = latest ? balanceSheet(latest.data ?? {}) : null;
  const money = (cents: number) => formatMoney(cents / 100, tenant.currency);

  return (
    <>
      <PageHeader
        title="Statements"
        description="Your profit and loss and your balance sheet, line by line as QuickBooks lays them out."
      />
      <RangePicker here={here} shown={shown} timezone={tenant.timezone} />

      {booked.length === 0 && !balance ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing from your books yet</CardTitle>
            <CardDescription>
              Once QuickBooks is connected, your statements show here within a few hours. Nothing is
              ever changed in your books.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href={`${base}/connections`}>Go to Connections</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Profit and loss</CardTitle>
              <CardDescription>
                {booked.length === 0
                  ? "Your books have no months in this range."
                  : `${monthName(statement.months[0])}${
                      statement.months.length > 1
                        ? ` to ${monthName(statement.months.at(-1)!)}`
                        : ""
                    }, each month added up.`}
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Profit and loss, line by line</caption>
                {statement.sections.map((section) => (
                  <tbody key={section.key}>
                    <tr>
                      <th
                        scope="rowgroup"
                        colSpan={2}
                        className="pt-3 pb-1 text-left text-xs font-semibold tracking-wide uppercase"
                      >
                        {section.name}
                      </th>
                    </tr>
                    <StatementLines lines={section.lines} money={money} />
                    <TotalRow
                      money={money}
                      label={`Total ${section.name.toLowerCase()}`}
                      cents={section.total}
                    />
                    {section.key === "COGS" && (
                      <TotalRow
                        money={money}
                        label={`Gross profit${
                          statement.grossShare === null
                            ? ""
                            : `, ${formatPercent(statement.grossShare)} of income`
                        }`}
                        cents={statement.grossProfit}
                        strong
                      />
                    )}
                    {section.key === "Expenses" && (
                      <TotalRow
                        money={money}
                        label="Operating profit"
                        cents={statement.operating}
                        strong
                      />
                    )}
                  </tbody>
                ))}
                <tbody>
                  <TotalRow money={money} label="Net income" cents={statement.netIncome} strong />
                </tbody>
              </table>
              {statement.totalsOnly.length > 0 && (
                <p className="text-muted-foreground mt-3 text-xs">
                  {statement.totalsOnly.length === 1
                    ? "One month was"
                    : `${statement.totalsOnly.length} months were`}{" "}
                  read before each account&apos;s line was kept, so only{" "}
                  {statement.totalsOnly.length === 1 ? "its" : "their"} totals are in the sections.
                  The next sync of your books fills them in.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Balance sheet</CardTitle>
              <CardDescription>
                {latest ? `As of ${asOf(latest.period_start)}.` : "Not read from your books yet."}
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {balance && balance.totalsOnly ? (
                <p className="text-muted-foreground text-sm">
                  This balance sheet was read before each account&apos;s line was kept.
                  {balance.totalAssets !== null &&
                    ` Total assets: ${money(balance.totalAssets)}.`}{" "}
                  The next sync of your books fills it in.
                </p>
              ) : (
                balance && (
                  <table className="w-full text-sm">
                    <caption className="sr-only">Balance sheet, line by line</caption>
                    {balance.sections.map((section) => (
                      <tbody key={section.key}>
                        <tr>
                          <th
                            scope="rowgroup"
                            colSpan={2}
                            className="pt-3 pb-1 text-left text-xs font-semibold tracking-wide uppercase"
                          >
                            {section.name}
                          </th>
                        </tr>
                        <StatementLines lines={section.lines} money={money} />
                        {section.key === "TotalAssets" && balance.totalAssets !== null && (
                          <TotalRow
                            money={money}
                            label="Total assets"
                            cents={balance.totalAssets}
                            strong
                          />
                        )}
                      </tbody>
                    ))}
                  </table>
                )
              )}
            </CardContent>
          </Card>
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        Read from QuickBooks every few hours. Amounts follow your company&apos;s own accounting
        method in QuickBooks.
      </p>
    </>
  );
}

type Money = (cents: number) => string;

function StatementLines({ lines, money }: { lines: StatementLine[]; money: Money }) {
  return (
    <>
      {lines.map((line, i) => (
        <tr key={`${line.name}-${i}`} className="border-border border-b last:border-0">
          <th
            scope="row"
            className="py-1.5 pr-3 text-left font-normal"
            style={{ paddingLeft: `${line.depth}rem` }}
          >
            {line.name}
          </th>
          <td className="py-1.5 text-right tabular-nums">{money(line.cents)}</td>
        </tr>
      ))}
    </>
  );
}

function TotalRow({
  label,
  cents,
  strong,
  money,
}: {
  label: string;
  cents: number;
  strong?: boolean;
  money: Money;
}) {
  return (
    <tr className="border-border border-t">
      <th scope="row" className={`py-2 pr-3 text-left ${strong ? "font-semibold" : "font-medium"}`}>
        {label}
      </th>
      <td className={`py-2 text-right tabular-nums ${strong ? "font-semibold" : "font-medium"}`}>
        {money(cents)}
      </td>
    </tr>
  );
}
