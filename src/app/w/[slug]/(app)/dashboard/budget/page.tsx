import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatTile } from "@/components/charts/stat-tile";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth";
import {
  PERIODS,
  PERIOD_WORDS,
  addMonths,
  isMonth,
  type BudgetSubject,
  type Period,
} from "@/lib/dashboard/budget";
import { loadBudgetView } from "@/lib/dashboard/budget-data";
import { formatMoney, formatPercent } from "@/lib/dashboard/format";
import { currentMonth, periodLabel } from "@/lib/dashboard/range";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { BudgetTable } from "../budget-table";

export const metadata: Metadata = { title: "Budget" };

const monthName = (month: string) => periodLabel(`${month}-01`, "month", true);

function periodName(period: Period, months: string[]): string {
  switch (period) {
    case "month":
      return monthName(months[0]);
    case "quarter":
      return `${monthName(months[0])} to ${monthName(months.at(-1)!)}`;
    case "ytd":
      return `${months[0].slice(0, 4)} so far, to ${monthName(months.at(-1)!)}`;
    case "year":
      return `All of ${months[0].slice(0, 4)}`;
  }
}

/**
 * Money → Budget: what was planned for each account (or business line)
 * against what the books spent, with break-even. The month, period and
 * view are in the address. The whole team can look; owners and admins
 * type budgets in.
 */
export default async function BudgetPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/budget`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const canEdit = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;
  const here = `${base}/dashboard/budget`;

  const query = await searchParams;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const now = new Date();
  const month = isMonth(one(query.month)) ? one(query.month)! : currentMonth(now, tenant.timezone);
  const period = (PERIODS as readonly string[]).includes(one(query.period) ?? "")
    ? (one(query.period) as Period)
    : "month";
  const subject: BudgetSubject = one(query.by) === "line" ? "line" : "account";
  const href = (change: { month?: string; period?: Period; by?: BudgetSubject }) => {
    const next = new URLSearchParams({
      month: change.month ?? month,
      period: change.period ?? period,
      by: change.by ?? subject,
    });
    return `${here}?${next}`;
  };

  const supabase = await createClient();
  const view = await loadBudgetView(supabase, tenant, { month, period, subject }, now);
  const money = (cents: number) => formatMoney(cents / 100, tenant.currency);
  const shown = view.rows.filter((row) => !row.hidden);
  const budgeted = shown.reduce((sum, row) => sum + row.budget, 0);
  const spent = shown.reduce((sum, row) => sum + row.actual, 0);
  const step = period === "month" ? 1 : period === "quarter" ? 3 : 12;
  const single = view.months.length === 1;
  const tableKey = view.rows.map((row) => `${row.key}:${row.budget}`).join("|");

  const pill = (active: boolean) =>
    cn(
      "rounded-md px-3 py-1.5 text-sm transition-colors",
      active ? "bg-card font-medium shadow-xs" : "text-muted-foreground hover:bg-card/60",
    );

  return (
    <>
      <PageHeader
        title="Budget"
        description="What you planned to spend against what your books say you spent, and the revenue you need to cover your costs."
      >
        <Button asChild variant="ghost" size="sm">
          <a href={href({}).replace(here, `${here}/export`)}>Download as a spreadsheet</a>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href={`${base}/settings/money/budget`}>Budget settings</Link>
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label="Period" className="bg-muted flex w-fit flex-wrap gap-1 rounded-lg p-1">
          {PERIODS.map((option) => (
            <Link
              key={option}
              href={href({ period: option })}
              aria-current={option === period ? "true" : undefined}
              className={pill(option === period)}
            >
              {PERIOD_WORDS[option]}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-1">
          <Button asChild variant="ghost" size="sm">
            <Link href={href({ month: addMonths(month, -step) })} aria-label="Earlier">
              ←
            </Link>
          </Button>
          <span className="text-sm font-medium">{periodName(period, view.months)}</span>
          <Button asChild variant="ghost" size="sm">
            <Link href={href({ month: addMonths(month, step) })} aria-label="Later">
              →
            </Link>
          </Button>
          {month !== view.current && (
            <Button asChild variant="ghost" size="sm">
              <Link href={href({ month: view.current })}>This month</Link>
            </Button>
          )}
        </div>
        {view.lines.length > 0 && (
          <nav aria-label="Budget by" className="bg-muted flex w-fit gap-1 rounded-lg p-1">
            <Link
              href={href({ by: "account" })}
              aria-current={view.subject === "account" ? "true" : undefined}
              className={pill(view.subject === "account")}
            >
              By account
            </Link>
            <Link
              href={href({ by: "line" })}
              aria-current={view.subject === "line" ? "true" : undefined}
              className={pill(view.subject === "line")}
            >
              By business line
            </Link>
          </nav>
        )}
      </div>

      {!view.hasExpenses ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing from your books yet</CardTitle>
            <CardDescription>
              Once QuickBooks is connected, what you spend shows up here against your budget,
              account by account. Nothing is ever changed in your books.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href={`${base}/connections`}>Go to Connections</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="grid grid-cols-2 gap-6 lg:grid-cols-4">
              <StatTile label="Budgeted" value={money(budgeted)} />
              <StatTile label="Spent" value={money(spent)} />
              <StatTile
                label={budgeted >= spent ? "Left" : "Over"}
                value={money(Math.abs(budgeted - spent))}
                note={budgeted === 0 ? "No budget set for this period yet" : undefined}
              />
              {view.breakEven ? (
                <StatTile
                  label="Break-even revenue"
                  value={view.breakEven.revenue === null ? "—" : money(view.breakEven.revenue)}
                  note={
                    view.breakEven.revenue === null
                      ? "Needs your cost of goods share, in Budget settings or from your books"
                      : `Fixed costs ${money(view.breakEven.fixed)} ÷ (1 − ${formatPercent(view.cogs!.share)} cost of goods)`
                  }
                />
              ) : (
                <StatTile
                  label="Revenue in your books"
                  value={view.revenue.known ? money(view.revenue.period) : "—"}
                />
              )}
            </CardContent>
          </Card>

          {view.breakEven && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Break-even</CardTitle>
                <CardDescription>
                  The revenue that covers what you&apos;ve budgeted, once cost of goods comes out of
                  every sale.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="text-muted-foreground">Cost of goods share</dt>
                    <dd className="font-medium">
                      {view.cogs ? formatPercent(view.cogs.share) : "—"}
                      <span className="text-muted-foreground block text-xs font-normal">
                        {view.cogs?.from === "setting"
                          ? "As set in Budget settings"
                          : view.cogs
                            ? "From your books, last 12 complete months"
                            : "Not known yet"}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Fixed costs budgeted</dt>
                    <dd className="font-medium tabular-nums">{money(view.breakEven.fixed)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {single
                        ? `Average revenue, ${view.averageOver.length} months before`
                        : "Average revenue a month"}
                    </dt>
                    <dd className="font-medium tabular-nums">{money(view.revenue.average)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Revenue in your books, this period</dt>
                    <dd className="font-medium tabular-nums">
                      {view.revenue.known ? money(view.revenue.period) : "—"}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {view.subject === "line" ? "By business line" : "By account"}
              </CardTitle>
              <CardDescription>
                {view.subject === "line"
                  ? "Spending sorted to each line in Expenses to sort, with its share of what's shared. Monthly costs your books don't hold aren't counted here."
                  : `Spending from your books, by the account it's filed under. Money moved between your own accounts and expenses set aside never count. Over or under by more than ${view.settings.warn_pct}% is flagged.`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BudgetTable
                key={`${month}-${period}-${view.subject}-${tableKey}`}
                slug={tenant.slug}
                month={month}
                subject={view.subject}
                rows={view.rows}
                editable={canEdit}
                single={single}
                currency={tenant.currency}
                averageLabel={
                  single ? `Average, ${view.averageOver.length} months before` : "Average a month"
                }
              />
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
