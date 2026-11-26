import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatTile } from "@/components/charts/stat-tile";
import { TimeChart } from "@/components/charts/time-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth";
import { loadDebtView } from "@/lib/dashboard/debt/data";
import {
  STRATEGIES,
  STRATEGY_META,
  addMonth,
  strategiesConverge,
} from "@/lib/dashboard/debt/engine";
import { bankKey, scheduleLength } from "@/lib/dashboard/debt/figures";
import { bpWords } from "@/lib/dashboard/debt/settings";
import { formatMoney, formatPercent, prepareTimeChart } from "@/lib/dashboard/format";
import { periodLabel } from "@/lib/dashboard/range";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import {
  EmergencyAccountPicker,
  FollowRecommended,
  ScheduleEditor,
  UseStrategy,
} from "../debt-forms";
import { choiceNote, recommendationWords } from "@/lib/dashboard/debt/recommend";

export const metadata: Metadata = { title: "Payoff plan" };

const monthWords = (month: string, long = true) => periodLabel(`${month}-01`, "month", long);
const span = (months: number) => {
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return (
    [
      years ? `${years} ${years === 1 ? "year" : "years"}` : "",
      rest ? `${rest} ${rest === 1 ? "month" : "months"}` : "",
    ]
      .filter(Boolean)
      .join(" ") || "under a month"
  );
};

/**
 * Money → Payoff plan: the debts paid down month by month, the emergency
 * fund built alongside, and the four orders compared. Owners and admins
 * only: for anyone else this page doesn't exist, and the database gives
 * them no debts to show.
 */
export default async function PayoffPlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ months?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const user = await requireUser(`/w/${slug}/dashboard/debts`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) notFound();
  const { tenant } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const canEdit = entitlements.canWrite;
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const view = await loadDebtView(supabase, tenant);
  const money = (cents: number) => formatMoney(cents / 100, tenant.currency);
  const { result, totals, emergency, settings } = view;
  const all = query.months === "all";

  const header = (
    <PageHeader
      title="Payoff plan"
      description="Your debts paid down a month at a time, with a safety cushion built up alongside. Only owners and admins can see this."
    >
      <Button asChild variant="outline" size="sm">
        <Link href={`${base}/settings/money/debts`}>Plan settings</Link>
      </Button>
    </PageHeader>
  );

  if (view.debts.length === 0) {
    return (
      <>
        {header}
        <Card>
          <CardHeader>
            <CardTitle>Your debts come from your books</CardTitle>
            <CardDescription>
              Each time QuickBooks syncs, the cards, loans and lines of credit on your balance sheet
              come in by themselves. Add each one&apos;s rate and minimum and the plan works out the
              rest, month by month. Nothing here changes anything in your books or with a lender.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href={`${base}/dashboard/debts/accounts`}>See your debts</Link>
            </Button>
          </CardContent>
        </Card>
      </>
    );
  }

  const thisMonth = result.schedule[0];
  const atYear = result.plan[11]?.emergencyBalance ?? null;
  const shown = result.plan.slice(0, scheduleLength(result.plan, all));
  const chartMonths = result.plan.slice(0, 36);
  const point = (month: string, cents: number) => ({
    key: `${month}-01`,
    label: periodLabel(`${month}-01`, "month"),
    longLabel: periodLabel(`${month}-01`, "month", true),
    value: cents / 100,
  });
  const owedChart = prepareTimeChart(
    [
      point(view.current, totals.owed),
      ...chartMonths.map((m) => point(addMonth(m.month, 1), m.total)),
    ].slice(0, 37),
    "money",
    tenant.currency,
  );
  const fundChart = prepareTimeChart(
    [
      point(view.current, emergency.current),
      ...chartMonths.map((m) => point(addMonth(m.month, 1), m.emergencyBalance)),
    ].slice(0, 37),
    "money",
    tenant.currency,
  );
  const converge = result.poolDebts.length > 0 && strategiesConverge(result.sims);
  const fastest = Math.min(...STRATEGIES.map((s) => result.sims[s].monthsToFreedom));
  const cheapest = Math.min(...STRATEGIES.map((s) => result.sims[s].totalInterest));
  const names = new Map(view.debts.map((d) => [d.id, d.name]));

  return (
    <>
      {header}

      {view.noBalance.length > 0 && (
        <p
          className="border-ochre/30 bg-ochre-soft text-ochre-text rounded-lg border px-3 py-2 text-sm"
          role="status"
        >
          {view.noBalance.map((d) => d.name).join(", ")}{" "}
          {view.noBalance.length === 1 ? "has" : "have"} no balance yet, so the plan leaves{" "}
          {view.noBalance.length === 1 ? "it" : "them"} out.{" "}
          <Link href={`${base}/dashboard/debts/accounts`} className="underline underline-offset-4">
            Give a balance
          </Link>
          .
        </p>
      )}

      {view.noRate.length > 0 && (
        <p
          className="border-ochre/30 bg-ochre-soft text-ochre-text rounded-lg border px-3 py-2 text-sm"
          role="status"
        >
          {view.noRate.map((d) => d.name).join(", ")} {view.noRate.length === 1 ? "has" : "have"} no
          rate yet, so the plan counts {view.noRate.length === 1 ? "it" : "them"} at 0%: the
          interest below leaves {view.noRate.length === 1 ? "it" : "them"} out, and paying off may
          take longer than shown.{" "}
          <Link href={`${base}/dashboard/debts/accounts`} className="underline underline-offset-4">
            Add the rate
          </Link>{" "}
          from the statement.
        </p>
      )}

      <Card>
        <CardContent className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          <StatTile label="Owed now" value={money(totals.owed)} />
          <StatTile
            label="Paid off so far"
            value={money(totals.paidOff)}
            note="Against what each debt started at, where you gave it"
          />
          <StatTile label="Payments a month" value={money(totals.monthly)} />
          <StatTile
            label="Emergency fund in a year"
            value={atYear === null ? "—" : money(atYear)}
            note={
              emergency.target > 0
                ? `Aiming for ${money(emergency.target)}`
                : "Set a target in plan settings"
            }
          />
        </CardContent>
      </Card>

      {thisMonth && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">This month, {monthWords(thisMonth.month)}</CardTitle>
            <CardDescription>
              The {STRATEGY_META[view.strategy].label.toLowerCase()} order
              {view.strategyFrom === "recommended" ? " (recommended)" : ""}, for the debts the plan
              pays down.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <StatTile
              label="Pay the minimums"
              value={money(thisMonth.totals.minPaid)}
              note={`Across ${thisMonth.rows.length} ${thisMonth.rows.length === 1 ? "debt" : "debts"}`}
            />
            <StatTile
              label={
                thisMonth.targetName ? `Send extra to ${thisMonth.targetName}` : "Send extra to"
              }
              value={money(thisMonth.totals.extraPaid)}
              note={
                thisMonth.totals.extraPaid === 0
                  ? "Nothing extra this month yet: it grows as debts are paid off"
                  : undefined
              }
            />
            <StatTile
              label="All together"
              value={money(thisMonth.totals.totalPaid)}
              note={`${money(thisMonth.totals.interest)} of it is interest`}
            />
          </CardContent>
        </Card>
      )}

      {view.milestones.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payoff milestones</CardTitle>
            <CardDescription>
              When each debt is cleared, and where its freed minimum goes next.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-2 text-sm">
              {view.milestones.map((m, i) => (
                <li
                  key={m.id}
                  className="border-border flex flex-wrap items-baseline justify-between gap-2 rounded-lg border p-3"
                >
                  <span>
                    <span className="text-muted-foreground mr-2 tabular-nums">{i + 1}.</span>
                    <span className="font-medium">{m.name}</span>
                    <span className="text-muted-foreground">
                      {m.rollsInto
                        ? ` frees ${money(m.freed)} a month for ${m.rollsInto}`
                        : " is the last one"}
                    </span>
                  </span>
                  <Badge tone="good">Paid off {monthWords(m.month, false)}</Badge>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Owed, over the next three years</CardTitle>
            <CardDescription>Starting from what&apos;s owed today.</CardDescription>
          </CardHeader>
          <CardContent>
            <TimeChart
              points={owedChart.points}
              ticks={owedChart.ticks}
              variant="column"
              valueLabel="Owed at the start of the month"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Emergency fund, over the next three years</CardTitle>
            <CardDescription>
              {emergency.target > 0
                ? view.emergencyAt
                  ? `Reaches ${money(emergency.target)} in ${monthWords(view.emergencyAt)}.`
                  : `Doesn't reach ${money(emergency.target)} within five years at this pace.`
                : "Set a target in plan settings."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TimeChart
              points={fundChart.points}
              ticks={fundChart.ticks}
              variant="column"
              valueLabel="In the fund at the start of the month"
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Month by month</CardTitle>
          <CardDescription>
            The pool is only the payments freed as debts are paid off; your profit stays in the
            business. Part goes to the emergency fund until it&apos;s reached, the rest to the
            debts. Months you set by hand are marked.{" "}
            <Link
              href={`${base}/dashboard/debts${all ? "" : "?months=all"}`}
              className="underline underline-offset-4"
            >
              {all ? "Show 24 months" : "Show every month to payoff"}
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {canEdit && (
            <ScheduleEditor
              slug={tenant.slug}
              currency={tenant.currency}
              rows={shown.map((m) => ({
                month: m.month,
                label: monthWords(m.month, false),
                pool: "",
                emergency: "",
                overridden: m.overridden,
              }))}
            />
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <caption className="sr-only">The payoff plan month by month</caption>
              <thead className="text-muted-foreground text-xs">
                <tr className="border-border border-b">
                  {[
                    "Month",
                    "Pool",
                    "Emergency fund",
                    "For debts",
                    "Not used",
                    "Fund after",
                    "Owed after",
                  ].map((h, i) => (
                    <th
                      key={h}
                      scope="col"
                      className={`py-2 font-medium ${i === 0 ? "pr-3" : "px-2 text-right"}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => (
                  <tr key={m.month} className="border-border border-b last:border-0">
                    <th scope="row" className="py-2 pr-3 font-normal whitespace-nowrap">
                      {monthWords(m.month, false)}{" "}
                      {m.overridden && <Badge tone="open">Set by hand</Badge>}
                    </th>
                    <td className="px-2 py-2 text-right tabular-nums">{money(m.pool)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(m.emergencyIn)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(m.poolBudget)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {money(Math.max(0, m.pool - m.emergencyIn - m.poolBudget))}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {money(m.emergencyBalance)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(m.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {result.poolDebts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Four ways to send the extra</CardTitle>
            <CardDescription>
              Every debt gets its minimum either way; only the order of the extra changes.
              {converge
                ? " Here they come out nearly the same: the same debt comes first whichever way you look at it."
                : ""}
            </CardDescription>
          </CardHeader>
          {view.recommendation && (
            <CardContent className="flex flex-col gap-2 pb-0">
              <p className="text-sm" role="status">
                <Badge tone="good" className="mr-2">
                  Recommended
                </Badge>
                {recommendationWords(view.recommendation, money)}
              </p>
              <p className="text-muted-foreground text-sm">
                {view.strategyFrom === "recommended"
                  ? "You haven't chosen an order, so the plan follows the recommended one by itself, and keeps following it as your balances change."
                  : `You chose ${STRATEGY_META[view.strategy].label.toLowerCase()}, so the plan keeps to it.`}{" "}
                {view.strategyFrom === "person" &&
                  choiceNote(view.strategy, view.recommendation, result.sims, money)}
              </p>
              {view.strategyFrom === "person" && canEdit && (
                <FollowRecommended slug={tenant.slug} />
              )}
              {view.noRate.length > 0 && (
                <p className="text-muted-foreground text-xs">
                  {view.noRate.map((d) => d.name).join(", ")}{" "}
                  {view.noRate.length === 1 ? "has" : "have"} no rate yet, so{" "}
                  {view.noRate.length === 1 ? "its" : "their"} interest is left out of this
                  comparison.
                </p>
              )}
            </CardContent>
          )}
          <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {STRATEGIES.map((s) => {
              const sim = result.sims[s];
              const meta = STRATEGY_META[s];
              return (
                <div
                  key={s}
                  className={`flex flex-col gap-3 rounded-lg border p-4 ${s === view.strategy ? "border-teal ring-teal/30 ring-2" : "border-border"}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">{meta.label}</span>
                    <span className="flex flex-wrap gap-1">
                      {s === view.recommendation?.strategy && (
                        <Badge tone="good">Recommended</Badge>
                      )}
                      {s === view.strategy && <Badge tone="open">Your plan</Badge>}
                    </span>
                  </div>
                  <span className="text-muted-foreground text-xs">{meta.tagline}</span>
                  <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Debt-free in</dt>
                    <dd className="text-right tabular-nums">
                      {sim.capped ? "Not within 50 years" : span(sim.monthsToFreedom)}
                      {!sim.capped && sim.monthsToFreedom === fastest && (
                        <Badge tone="good" className="ml-1">
                          Fastest
                        </Badge>
                      )}
                    </dd>
                    <dt className="text-muted-foreground">Interest</dt>
                    <dd className="text-right tabular-nums">
                      {money(sim.totalInterest)}
                      {sim.totalInterest === cheapest && (
                        <Badge tone="good" className="ml-1">
                          Least
                        </Badge>
                      )}
                    </dd>
                    <dt className="text-muted-foreground">Paid in all</dt>
                    <dd className="text-right tabular-nums">{money(sim.totalPaid)}</dd>
                  </dl>
                  <ul className="text-muted-foreground flex flex-col gap-0.5 text-xs">
                    {[...meta.pros.map((p) => `+ ${p}`), ...meta.cons.map((c) => `– ${c}`)].map(
                      (line) => (
                        <li key={line}>{line}</li>
                      ),
                    )}
                  </ul>
                  {canEdit && (s !== view.strategy || view.strategyFrom === "recommended") && (
                    <UseStrategy slug={tenant.slug} strategy={s} label={meta.label} />
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {view.cards.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By debt</CardTitle>
            <CardDescription>In the order they&apos;re paid off.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {view.cards.map((card, i) => (
              <div
                key={card.id}
                className="border-border flex flex-col gap-2 rounded-lg border p-4"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {i + 1}. {card.name}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {bpWords(card.rateBp)} a year
                  </span>
                </div>
                <div className="bg-muted h-1.5 overflow-hidden rounded-full" aria-hidden>
                  <div
                    className="bg-teal h-full"
                    style={{ width: `${Math.round(card.progress * 100)}%` }}
                  />
                </div>
                <dl className="grid grid-cols-2 gap-1 text-sm">
                  <dt className="text-muted-foreground">Owed now</dt>
                  <dd className="text-right tabular-nums">{money(card.startBalance)}</dd>
                  <dt className="text-muted-foreground">Interest to come</dt>
                  <dd className="text-right tabular-nums">{money(card.interest)}</dd>
                  <dt className="text-muted-foreground">Paid off</dt>
                  <dd className="text-right">
                    {card.payoffMonth ? monthWords(card.payoffMonth) : "—"}
                  </dd>
                </dl>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Emergency fund</CardTitle>
            <CardDescription>
              {emergency.targetFrom === "months" && emergency.usualMonth !== null
                ? `${settings.emergency_months} months of your usual ${money(emergency.usualMonth)} of expenses.`
                : "The amount you chose."}{" "}
              {emergency.currentFrom === "books"
                ? emergency.accounts.length > 0
                  ? `Read from ${emergency.accounts.join(", ")} in your books, at every sync.`
                  : "None of its accounts is on your latest balance sheet."
                : emergency.currentFrom === "typed"
                  ? "The amount you typed in."
                  : "Tick the account it's kept in and its balance comes from your books."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-2xl font-semibold tabular-nums">
                {money(emergency.current)}
              </span>
              <span className="text-muted-foreground">of {money(emergency.target)}</span>
            </div>
            <div
              className="bg-muted h-2 overflow-hidden rounded-full"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(emergency.progress * 100)}
              aria-label="Emergency fund"
            >
              <div
                className="bg-mint-ink h-full"
                style={{ width: `${Math.round(emergency.progress * 100)}%` }}
              />
            </div>
            <span className="text-muted-foreground text-sm">
              {emergency.progress >= 1
                ? "Reached. Everything freed now goes to the debts."
                : `${formatPercent(emergency.progress)} of the way there`}
              {settings.emergency_monthly_cents > 0
                ? `, with ${money(settings.emergency_monthly_cents)} a month going in.`
                : `, with ${settings.emergency_split_pct}% of freed payments going in.`}
            </span>
            {emergency.missing.length > 0 && (
              <span className="text-ochre-text text-sm">
                Your latest balance sheet doesn&apos;t have {emergency.missing.join(", ")}.{" "}
                <Link
                  href={`${base}/settings/money/debts#emergency-accounts`}
                  className="underline underline-offset-4"
                >
                  Tick the account it&apos;s in now
                </Link>
                .
              </span>
            )}
            {emergency.currentFrom !== "books" && canEdit && view.banks.length > 0 && (
              <EmergencyAccountPicker
                slug={tenant.slug}
                banks={view.banks.map((bank) => ({
                  key: bankKey(bank),
                  id: bank.id ?? null,
                  name: bank.name,
                  balance: money(bank.cents),
                }))}
                picked={[]}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">After the debt</CardTitle>
            <CardDescription>
              What a month looks like once the plan&apos;s debts are gone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Debt-free in</dt>
              <dd className="text-right">
                {view.after.months === null ? "Not within 50 years" : span(view.after.months)}
              </dd>
              <dt className="text-muted-foreground">Freed each month</dt>
              <dd className="text-right tabular-nums">{money(view.after.freed)}</dd>
              <dt className="text-muted-foreground">Operating profit a month now</dt>
              <dd className="text-right tabular-nums">{money(view.after.profitNow)}</dd>
              <dt className="text-muted-foreground">…and after</dt>
              <dd className="text-right tabular-nums">{money(view.after.profitAfter)}</dd>
              <dt className="text-muted-foreground">Share of revenue going to debt</dt>
              <dd className="text-right tabular-nums">
                {view.after.shareOfRevenue === null
                  ? "—"
                  : formatPercent(view.after.shareOfRevenue)}
              </dd>
            </dl>
          </CardContent>
        </Card>
      </div>

      {view.payments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payments from your books</CardTitle>
            <CardDescription>
              Money moved into each debt&apos;s own account, as your books show it. These never
              count as expenses.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              {view.payments.slice(0, 12).map((p, i) => (
                <li
                  key={`${p.debtId}-${p.date}-${i}`}
                  className="flex flex-wrap justify-between gap-2"
                >
                  <span>
                    {names.get(p.debtId) ?? "A debt"}
                    {p.fromAccount && (
                      <span className="text-muted-foreground"> from {p.fromAccount}</span>
                    )}
                  </span>
                  <span className="tabular-nums">
                    {money(p.cents)} · {periodLabel(p.date, "day", true)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
