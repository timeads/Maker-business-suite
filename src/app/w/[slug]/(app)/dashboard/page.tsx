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
import { revenueExplained } from "@/lib/dashboard/explain";
import { MONEY_TOOL, moneySetupItems } from "@/lib/dashboard/setup";
import { loadMoneySetupFacts } from "@/lib/dashboard/setup-data";
import { loadNotNow } from "@/lib/setup/data";
import { sortItems, type SetupItem } from "@/lib/setup/items";
import { loadDashboardConfig, loadDashboardData, loadRevenueSettings } from "@/lib/dashboard/data";
import { resolveRange } from "@/lib/dashboard/range";
import {
  RANGE_LABELS,
  RANGE_PHRASES,
  RANGE_PRESETS,
  type RangePreset,
} from "@/lib/dashboard/schema";
import { TEMPLATE_ORDER, templateBlurb, templateConfig } from "@/lib/dashboard/templates";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { TemplatePicker } from "./template-picker";
import { Widget } from "./widget";

export const metadata: Metadata = { title: "Money" };

const isRange = (value: unknown): value is RangePreset =>
  typeof value === "string" && (RANGE_PRESETS as readonly string[]).includes(value);

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
  const preset = isRange(query.range) ? query.range : config.range;
  // One range for the whole page, so every number agrees with its neighbours.
  const range = resolveRange(preset, new Date(), tenant.timezone);
  const manager = canManage(role);
  const [data, setup] = await Promise.all([
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
  ]);

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

      {source === "invalid" && (
        <FormMessage>
          Your saved dashboard layout couldn&apos;t be read, so this is the standard one. Choosing a
          layout again will fix it.
        </FormMessage>
      )}

      <nav aria-label="Date range" className="bg-muted flex w-fit flex-wrap gap-1 rounded-lg p-1">
        {RANGE_PRESETS.map((option) => (
          <Link
            key={option}
            href={`${base}/dashboard?range=${option}`}
            aria-current={option === preset ? "true" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              option === preset
                ? "bg-card font-medium shadow-xs"
                : "text-muted-foreground hover:bg-card/60",
            )}
          >
            {RANGE_LABELS[option]}
          </Link>
        ))}
      </nav>
      <HowWorkedOut
        label="How revenue is worked out"
        lines={revenueExplained(revenue)}
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
              rangePhrase={RANGE_PHRASES[preset]}
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
