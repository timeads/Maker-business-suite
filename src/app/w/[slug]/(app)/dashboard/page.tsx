import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import { HowWorkedOut } from "@/components/setup/how-worked-out";
import { SetupCard } from "@/components/setup/setup-card";
import { requireUser } from "@/lib/auth";
import { booksRevenueExplained, revenueExplained } from "@/lib/dashboard/explain";
import { MONEY_TOOL, moneySetupItems } from "@/lib/dashboard/setup";
import { loadMoneySetupFacts } from "@/lib/dashboard/setup-data";
import { loadNotNow } from "@/lib/setup/data";
import { sortItems, type SetupItem } from "@/lib/setup/items";
import { loadDashboardConfig, loadDashboardData, loadRevenueSettings } from "@/lib/dashboard/data";
import { pageRange } from "@/lib/dashboard/range";
import { TEMPLATE_ORDER, templateBlurb, templateConfig } from "@/lib/dashboard/templates";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { RangePicker } from "./range-picker";
import { TemplatePicker } from "./template-picker";
import { Widget } from "./widget";
import { SummaryCard } from "./summary-card";
import { addMonths } from "@/lib/dashboard/budget";
import { currentMonth, periodLabel } from "@/lib/dashboard/range";
import { readSections } from "@/lib/dashboard/summary";
import { nameOf, type Person } from "@/lib/messages/format";

export const metadata: Metadata = { title: "Money" };

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const user = await requireUser(`/w/${slug}/dashboard`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const base = `/w/${tenant.slug}`;
  const entitlements = await getEntitlements(tenant.id);

  if (!entitlements.can("module.dashboard")) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Money</h1>
        <Card>
          <CardHeader>
            <CardTitle>See your sales, margins and cash in one place</CardTitle>
            <CardDescription>
              The money view is part of every plan. Pick one to switch it on — the first 14 days are
              free.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canManage(role) ? (
              <Button asChild>
                <Link href={`${base}/settings/billing`}>See plans</Link>
              </Button>
            ) : (
              <p className="text-muted-foreground text-sm">
                Ask a workspace owner or admin to pick a plan.
              </p>
            )}
          </CardContent>
        </Card>
      </>
    );
  }

  const supabase = await createClient();
  const revenue = await loadRevenueSettings(supabase, tenant.id);
  const { config, source } = await loadDashboardConfig(supabase, tenant.id, revenue);
  // One range for the whole page, so every number agrees with its neighbours:
  // a preset, or one month, quarter or year picked by hand.
  const now = new Date();
  const shown = pageRange(query.range, config.range, now, tenant.timezone);
  const { range } = shown;
  const manager = canManage(role);
  // The monthly summary of the last complete month: owners and admins only
  // (the database hands nobody else one). Allowed to fail.
  const summaryMonth = addMonths(currentMonth(now, tenant.timezone), -1);
  const [data, setup, summaryRow, people] = await Promise.all([
    loadDashboardData(supabase, tenant, config, range, revenue),
    // "Finish setting up", for the people who can do it. Never stops the page.
    manager
      ? Promise.all([
          loadMoneySetupFacts(supabase, tenant, { manager, revenue }),
          loadNotNow(supabase, tenant.id, MONEY_TOOL),
        ])
          .then(([facts, notNow]) => sortItems(moneySetupItems(facts), notNow).open)
          .catch((): SetupItem[] => [])
      : Promise.resolve([] as SetupItem[]),
    manager
      ? supabase
          .from("money_summaries")
          .select("sections, written_by, written_at")
          .eq("tenant_id", tenant.id)
          .eq("month", `${summaryMonth}-01`)
          .maybeSingle()
          .then(
            ({ data: row }) =>
              row as { sections: unknown; written_by: string | null; written_at: string } | null,
            () => null,
          )
      : Promise.resolve(null),
    manager
      ? supabase.rpc("list_members", { p_tenant_id: tenant.id }).then(
          ({ data: rows }) => (rows ?? []) as Person[],
          () => [] as Person[],
        )
      : Promise.resolve([] as Person[]),
  ]);
  const summary = summaryRow
    ? {
        sections: readSections(summaryRow.sections),
        writtenOn: new Intl.DateTimeFormat("en-US", {
          timeZone: tenant.timezone,
          dateStyle: "medium",
        }).format(new Date(summaryRow.written_at)),
        writtenBy: summaryRow.written_by
          ? nameOf(people.find((p) => p.user_id === summaryRow.written_by))
          : "someone who has left",
      }
    : null;

  return (
    <>
      <PageHeader
        title="Money"
        description={`Times and totals follow your workspace timezone and currency (${tenant.currency}).`}
      >
        {canManage(role) && entitlements.canWrite && (
          <TemplatePicker
            slug={tenant.slug}
            currentName={config.name}
            options={TEMPLATE_ORDER.map((key) => ({
              key,
              name: templateConfig(key).name,
              blurb: templateBlurb(key),
            }))}
          />
        )}
      </PageHeader>

      <SetupCard
        slug={tenant.slug}
        tool={MONEY_TOOL}
        items={setup}
        canSnooze={manager && entitlements.canWrite}
        setupHref="dashboard/setup"
      />

      {manager && (
        <SummaryCard
          slug={tenant.slug}
          monthWords={periodLabel(`${summaryMonth}-01`, "month", true)}
          summary={summary}
          canWrite={entitlements.canWrite}
        />
      )}

      {source === "invalid" && (
        <FormMessage>
          Your saved dashboard layout couldn&apos;t be read, so this is the standard one. Choosing a
          layout again will fix it.
        </FormMessage>
      )}

      <RangePicker here={`${base}/dashboard`} shown={shown} timezone={tenant.timezone}>
        <Button asChild variant="ghost" size="sm">
          <a href={`${base}/dashboard/export?range=${encodeURIComponent(shown.value)}`}>
            Download these figures
          </a>
        </Button>
        {config.widgets.some((w) => w.type === "profit_by_line") && (
          <Button asChild variant="ghost" size="sm">
            <a
              href={`${base}/dashboard/export?range=${encodeURIComponent(shown.value)}&what=profit`}
            >
              Download profit by line
            </a>
          </Button>
        )}
      </RangePicker>
      <HowWorkedOut
        label="How revenue is worked out"
        lines={[
          ...revenueExplained(revenue),
          ...(revenue.books.invoices || revenue.books.other_income
            ? booksRevenueExplained(revenue)
            : []),
        ]}
        change={{ href: `${base}/settings/money/lines`, label: "Change how revenue is counted" }}
      />

      {config.widgets.every((widget) => data[widget.id].type === "empty") ? (
        // Nothing connected yet: one clear next step beats a page of empty cards.
        <Card>
          <CardHeader>
            <CardTitle>Connect your store and your books to fill this in</CardTitle>
            <CardDescription>
              Sales, best sellers and channels come from Shopify. Cash, margin and what you&apos;re
              owed come from QuickBooks. Either one is enough to get started.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href={`${base}/connections`}>Go to Connections</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {config.widgets.map((widget) => (
            <Widget
              key={widget.id}
              widget={widget}
              data={data[widget.id]}
              currency={tenant.currency}
              rangePhrase={shown.phrase}
              connectionsHref={`${base}/connections`}
              linesHref={`${base}/settings/money/lines`}
              inboxHref={`${base}/dashboard/expenses`}
              profitHref={`${base}/settings/money/profit`}
            />
          ))}
        </div>
      )}
    </>
  );
}
