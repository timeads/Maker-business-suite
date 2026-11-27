import type { Metadata } from "next";
import Link from "next/link";
import { HowWorkedOut } from "@/components/setup/how-worked-out";
import { NotNowButton } from "@/components/setup/not-now-button";
import { SetupList } from "@/components/setup/setup-list";
import { SetupStepCard } from "@/components/setup/setup-step";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { loadNotNow } from "@/lib/setup/data";
import { firstOpenStep, openByStep, someNames, sortItems } from "@/lib/setup/items";
import { planningExplained } from "@/lib/stock/explain";
import { hasLiveSupplier, isPlanned } from "@/lib/stock/plan";
import { STOCK_STEPS, STOCK_TOOL, stockSetupItems } from "@/lib/stock/setup";
import { loadStockSetupFacts } from "@/lib/stock/setup-data";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadStock } from "../data";
import { StockSettingsForm } from "../forms";
import { stockAccess } from "../gate";
import { SyncShopButton } from "../home-parts";

export const metadata: Metadata = { title: "Set up" };

/** Suppliers listed by name in step 2; the rest are on the Suppliers page. */
const SHOWN = 8;

/**
 * Stock → Set up: the checklist as steps, each writing through the same
 * forms and checked functions as everywhere else (the planning form is
 * Settings → Stock's own). Progress is the facts (`stockSetupItems`), never
 * stored; a person lands on the first step with something open, and any
 * step can be skipped. Everyone with Stock can look; what only owners and
 * admins can change says so.
 */
export default async function StockSetupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/setup`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role);
  const canEdit = manager && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;
  const when = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: tenant.timezone,
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(new Date(iso))
      : "not yet";

  const supabase = await createClient();
  const [stock, notNow, { data: books }] = await Promise.all([
    loadStock(supabase, tenant),
    loadNotNow(supabase, tenant.id, STOCK_TOOL),
    supabase
      .from("connections")
      .select("status")
      .eq("tenant_id", tenant.id)
      .eq("provider", "quickbooks")
      .maybeSingle(),
  ]);
  const { rows, suppliers, settings, seasons, link } = stock;
  const facts = await loadStockSetupFacts(supabase, tenant, {
    manager,
    seesCosts: entitlements.seesCosts,
    loaded: { rows, suppliers, settings, seasons },
  });

  const { open, resting } = sortItems(stockSetupItems(facts), notNow);
  const steps = STOCK_STEPS;
  const current = firstOpenStep(steps, open);
  const byStep = openByStep(open);
  const stepProps = (id: string) => {
    const index = steps.findIndex((s) => s.id === id);
    return {
      id,
      number: index + 1,
      title: steps[index].title,
      open: byStep.get(id)?.length ?? 0,
      current: current === id,
      next: steps[index + 1]
        ? { id: steps[index + 1].id, title: steps[index + 1].title }
        : undefined,
    };
  };
  const stepItems = (id: string) => (
    <SetupList
      slug={tenant.slug}
      tool={STOCK_TOOL}
      items={byStep.get(id) ?? []}
      canSnooze={canEdit}
      canAct={canEdit}
    />
  );

  const planned = rows.filter(isPlanned);
  const live = suppliers.filter((s) => !s.archived_at);
  const usedBy = new Map<string, number>();
  for (const row of planned) {
    if (hasLiveSupplier(row)) usedBy.set(row.supplier!.id, (usedBy.get(row.supplier!.id) ?? 0) + 1);
  }
  const bySource = { own: 0, average: 0, shop: 0, none: 0 };
  for (const row of planned) bySource[row.cost.source] += 1;

  return (
    <>
      <PageHeader
        title="Set up"
        description="A few steps that make Stock's order-by dates and suggestions true to your business. Skip anything, come back any time: this page remembers nothing but what you've already set."
      />

      {!manager && (
        <Card>
          <CardContent className="pt-6 text-sm">
            An owner or admin sets most of these up. You can see where things stand, and anything
            that&apos;s theirs to do says so.
          </CardContent>
        </Card>
      )}

      {/* 1. The shop */}
      <SetupStepCard
        {...stepProps("shop")}
        description="Stock reads your items, their counts and your sales from your shop, about once an hour."
      >
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            {link.connected
              ? `${rows.length.toLocaleString("en-US")} items from your shop, ${planned.length.toLocaleString("en-US")} of them planned for. Last read ${when(link.lastSyncedAt)}.`
              : "Your shop isn't connected."}
          </li>
        </ul>
        {canEdit &&
          (link.connected ? (
            <div className="flex">
              <SyncShopButton slug={tenant.slug} />
            </div>
          ) : (
            <Button asChild variant="outline" className="w-fit">
              <Link href={`${base}/connections`}>Go to Connections</Link>
            </Button>
          ))}
        {stepItems("shop")}
      </SetupStepCard>

      {/* 2. Suppliers */}
      <SetupStepCard
        {...stepProps("suppliers")}
        description="Each item is ordered from its supplier, and an order-by date counts back from how long that supplier takes. The vendor your shop gives a product becomes its supplier; one you choose by hand is never changed by a read."
      >
        <p className="text-sm">
          {live.length === 0
            ? "No suppliers yet."
            : `${live.length} supplier${live.length === 1 ? "" : "s"} in use: ${someNames(
                live.map((s) => s.name),
                SHOWN,
              )}.`}
        </p>
        {facts.suppliersNoLead.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {facts.suppliersNoLead.slice(0, SHOWN).map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  {s.name}{" "}
                  <span className="text-muted-foreground">
                    · {usedBy.get(s.id) ?? 0} items · follows your usual{" "}
                    {settings.default_lead_time_days} days
                  </span>
                </span>
                {canEdit && (
                  <Link
                    href={`${base}/stock/suppliers/${s.id}`}
                    className="text-ochre-text text-sm underline-offset-2 hover:underline"
                  >
                    Add their days
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`${base}/stock/suppliers`}>See your suppliers</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={`${base}/stock/items?show=nosupplier`}>Items with no supplier</Link>
          </Button>
        </div>
        {stepItems("suppliers")}
      </SetupStepCard>

      {/* 3. Planning */}
      <SetupStepCard
        {...stepProps("planning")}
        description="The usual figures every item falls back on. An item or a supplier can have its own."
      >
        {canEdit ? (
          <StockSettingsForm
            slug={tenant.slug}
            settings={settings}
            canPush={link.canPush}
            booksConnected={books?.status === "active"}
          />
        ) : (
          <p className="text-muted-foreground text-sm">
            An owner or admin can change these. They&apos;re also under Settings → Stock.
          </p>
        )}
        <HowWorkedOut
          label="How order-by dates and amounts are worked out"
          lines={planningExplained(settings)}
          change={
            canEdit
              ? { href: `${base}/settings/stock/seasons`, label: "Your selling seasons" }
              : null
          }
        />
        {stepItems("planning")}
      </SetupStepCard>

      {/* 4. Costs */}
      <SetupStepCard
        {...stepProps("costs")}
        description="What an item costs you starts every order line and adds up in Spend. Your own figure wins, then the average of your checked-in deliveries, then the cost in your shop."
      >
        {entitlements.seesCosts ? (
          <>
            <ul className="flex flex-col gap-1 text-sm">
              <li>Your own figure: {bySource.own}</li>
              <li>Average of your deliveries: {bySource.average}</li>
              <li>From your shop: {bySource.shop}</li>
              <li>Not known yet: {bySource.none}</li>
            </ul>
            <p className="text-muted-foreground text-sm">
              The quickest fix is usually the cost per item in your shop: it comes across with the
              next read. You can also type a figure in the Everything list (“Change figures”), or
              bring a spreadsheet across.
            </p>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link href={`${base}/stock/items?show=all`}>Open the Everything list</Link>
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <Link href={`${base}/settings/stock/import`}>Bring a spreadsheet across</Link>
                </Button>
              </div>
            )}
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            What things cost is for owners and admins in this workspace.
          </p>
        )}
        {stepItems("costs")}
      </SetupStepCard>

      {/* 5. Extras */}
      <SetupStepCard
        {...stepProps("extras")}
        description="None of these change your figures. Take them or leave them."
      >
        {(byStep.get("extras")?.length ?? 0) === 0 && (
          <p className="text-muted-foreground text-sm">Nothing to offer here right now.</p>
        )}
        {stepItems("extras")}
      </SetupStepCard>

      {/* 6. Review */}
      <SetupStepCard {...stepProps("review")} description="Where things stand now.">
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            {planned.length.toLocaleString("en-US")} items planned for,{" "}
            {planned.filter((row) => row.due).length} due to order in the next two weeks.
          </li>
          <li>
            Orders take {settings.default_lead_time_days} days to arrive unless a supplier says
            otherwise, and last {settings.default_coverage_days} days after.
          </li>
        </ul>
        {open.length === 0 ? (
          <p className="text-sm">
            Nothing left to set up. Your suggestions are as true as we can make them.
          </p>
        ) : (
          <>
            <p className="text-sm font-medium">Still open</p>
            <SetupList
              slug={tenant.slug}
              tool={STOCK_TOOL}
              items={open}
              canSnooze={canEdit}
              canAct={canEdit}
            />
          </>
        )}
        {resting.length > 0 && (
          <details>
            <summary className="text-muted-foreground cursor-pointer text-sm">
              {manager ? "You" : "An owner or admin"} said &ldquo;not now&rdquo; to {resting.length}
            </summary>
            <ul className="mt-2 flex flex-col gap-2 text-sm">
              {resting.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{item.title}</span>
                  {canEdit && (
                    <NotNowButton
                      slug={tenant.slug}
                      tool={STOCK_TOOL}
                      item={item.id}
                      facts={item.facts}
                      back
                    />
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
        <Button asChild variant="outline" className="w-fit">
          <Link href={`${base}/stock`}>See what to order</Link>
        </Button>
      </SetupStepCard>
    </>
  );
}
