import type { Metadata } from "next";
import Link from "next/link";
import { HowWorkedOut } from "@/components/setup/how-worked-out";
import { NotNowButton } from "@/components/setup/not-now-button";
import { SetupList } from "@/components/setup/setup-list";
import { SetupStepCard } from "@/components/setup/setup-step";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/lib/dashboard/format";
import { loadNotNow } from "@/lib/setup/data";
import { firstOpenStep, openByStep, someNames, sortItems } from "@/lib/setup/items";
import { packingExplained } from "@/lib/shipping/explain";
import { boxSize } from "@/lib/shipping/labels";
import { SHIPPING_STEPS, SHIPPING_TOOL, shippingSetupItems } from "@/lib/shipping/setup";
import { loadShippingSetupFacts } from "@/lib/shipping/setup-data";
import { SOURCE_NAMES } from "@/lib/shipping/sources/types";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { ShopPermissionNote } from "../../connections/shop-permission-note";
import { SyncShopButton } from "../../stock/home-parts";
import { BoxesForm } from "../box-forms";
import { loadBoxes, loadShippingSetup } from "../data";
import { ShippingSettingsForm } from "../forms";
import { shippingAccess } from "../gate";

export const metadata: Metadata = { title: "Set up" };

/**
 * Shipping → Set up: the checklist as steps, each writing through the same
 * forms and checked functions as Settings → Shipping (the ship-from and box
 * forms are its own). Progress is the facts (`shippingSetupItems`), never
 * stored; a person lands on the first step with something open, and any
 * step can be skipped. Everyone with Shipping can look; what only owners and
 * admins can change says so. How a computer prints is that computer's own
 * choice, so it is only pointed at here.
 */
export default async function ShippingSetupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/shipping/setup`);
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
  const [facts, notNow, setup, boxes] = await Promise.all([
    loadShippingSetupFacts(supabase, tenant),
    loadNotNow(supabase, tenant.id, SHIPPING_TOOL),
    loadShippingSetup(supabase, tenant.id),
    loadBoxes(supabase, tenant.id),
  ]);

  const { open, resting } = sortItems(shippingSetupItems(facts), notNow);
  const steps = SHIPPING_STEPS;
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
      tool={SHIPPING_TOOL}
      items={byStep.get(id) ?? []}
      canSnooze={canEdit}
      canAct={canEdit}
    />
  );
  const onlyManagers = (
    <p className="text-muted-foreground text-sm">
      An owner or admin can change this. It&apos;s also under Settings → Shipping.
    </p>
  );
  const sources = (keys: readonly (keyof typeof SOURCE_NAMES)[]) =>
    someNames(keys.map((key) => SOURCE_NAMES[key]));
  const shopOn = facts.shop?.status === "active";

  return (
    <>
      <PageHeader
        title="Set up"
        description="A few steps that make labels price right and parcels go out smoothly. Skip anything, come back any time: this page remembers nothing but what you've already set."
      />

      {!manager && (
        <Card>
          <CardContent className="pt-6 text-sm">
            An owner or admin sets most of these up. You can see where things stand, and anything
            that&apos;s theirs to do says so.
          </CardContent>
        </Card>
      )}

      {/* 1. The shop and its orders */}
      <SetupStepCard
        {...stepProps("shop")}
        description="Shipping reads the orders waiting to go, and where they're going, from your shop. Addresses are read on their own, apart from sales."
      >
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            {shopOn
              ? `Your shop was last read ${when(facts.shop?.lastSyncedAt ?? null)}.`
              : "Your shop isn't connected."}
          </li>
          {facts.recent && shopOn && (
            <li>
              In the last 30 days, {facts.recent.shipping} orders reached Shipping
              {facts.recent.shop > 0 ? ` (your shop charged postage on ${facts.recent.shop})` : ""}.
            </li>
          )}
          {facts.open && (
            <li>
              {facts.open.toPost} waiting to post
              {facts.open.noAddress > 0 ? `, ${facts.open.noAddress} with no address` : ""}.
            </li>
          )}
        </ul>
        {(byStep.get("shop") ?? []).some(
          (item) => item.id === "shop.addresses" || item.id === "orders.no-address",
        ) && (
          <p className="font-read text-sm">
            When orders come in but their addresses don&apos;t, your shop usually hasn&apos;t let us
            see customers&apos; delivery details. Connect it again from Connections and allow
            everything it asks for; addresses then come across with the next read. Orders a shopper
            is collecting never need one.
          </p>
        )}
        {canEdit &&
          (shopOn ? (
            <div className="flex">
              <SyncShopButton slug={tenant.slug} />
            </div>
          ) : (
            <Button asChild variant="outline" className="w-fit">
              <Link href={`${base}/connections`}>Go to Connections</Link>
            </Button>
          ))}
        {facts.permission.state !== "not_connected" && (
          <div className="border-border flex flex-col gap-2 border-t pt-3">
            <p className="text-sm font-medium">Telling your shop a parcel went</p>
            <ShopPermissionNote
              slug={tenant.slug}
              permission={facts.permission}
              what="mark its orders as sent"
              canCheck={canEdit}
              timezone={tenant.timezone}
            />
            {facts.permission.state === "watch_only" && (
              <p className="text-muted-foreground font-read text-sm">
                Watching only is a fine choice: parcels are still recorded here, and you mark orders
                as sent in your shop yourself.
              </p>
            )}
          </div>
        )}
        {stepItems("shop")}
      </SetupStepCard>

      {/* 2. Ship-from */}
      <SetupStepCard
        {...stepProps("from")}
        description="Carriers need it to price and print a label, and the packing slip prints it as your return address."
      >
        {canEdit ? (
          <ShippingSettingsForm
            slug={tenant.slug}
            settings={setup.settings}
            canSend={setup.canSend}
          />
        ) : facts.shipFromMissing.length === 0 ? (
          <p className="text-sm">Your ship-from address is complete.</p>
        ) : (
          onlyManagers
        )}
        {stepItems("from")}
      </SetupStepCard>

      {/* 3. Boxes */}
      <SetupStepCard
        {...stepProps("boxes")}
        description="The boxes and envelopes you pack in, so a label starts with the right size and weight."
      >
        {canEdit ? (
          <BoxesForm slug={tenant.slug} boxes={boxes} />
        ) : boxes.length === 0 ? (
          onlyManagers
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {boxes.map((box) => (
              <li key={box.id}>
                {box.name} <span className="text-muted-foreground">· {boxSize(box)}</span>
                {box.is_default && <span className="text-muted-foreground"> · usual box</span>}
              </li>
            ))}
          </ul>
        )}
        <HowWorkedOut
          label="How an order's box is chosen"
          lines={packingExplained(setup.settings, boxes)}
          change={
            canEdit
              ? { href: `${base}/settings/shipping/rules`, label: "Rules and remembering" }
              : null
          }
        />
        {stepItems("boxes")}
      </SetupStepCard>

      {/* 4. Labels */}
      <SetupStepCard
        {...stepProps("labels")}
        description="Labels can be bought here from EasyPost, your own UPS account or Redo, all on one price list. If you buy labels elsewhere, record each parcel by hand instead; that works just as well."
      >
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            {facts.postage.active.length > 0
              ? `Buying labels through ${sources(facts.postage.active)}.`
              : "No postage account connected: parcels are recorded by hand."}
          </li>
          {facts.open && facts.open.noWeight > 0 && (
            <li>
              {facts.open.noWeight} orders waiting have items with no weight. Weights come from your
              shop: add them to the products there and they come across with the next read.
            </li>
          )}
        </ul>
        {canEdit && (
          <Button asChild variant="outline" size="sm" className="w-fit">
            <Link href={`${base}/connections`}>Postage accounts in Connections</Link>
          </Button>
        )}
        <p className="text-muted-foreground font-read text-sm">
          Printing is set on each computer, not for the whole workspace: on the computer you pack
          at, go to{" "}
          <Link
            href={`${base}/settings/shipping/printing#printing`}
            className="underline underline-offset-2"
          >
            Printing on this computer
          </Link>
          .
        </p>
        {stepItems("labels")}
      </SetupStepCard>

      {/* 5. Packing slip */}
      <SetupStepCard
        {...stepProps("slip")}
        description="What the slip in each parcel shows. The usual one works fine as it is."
      >
        <ul className="flex flex-col gap-1 text-sm">
          <li>{facts.slip.saved ? "You've made the slip your own." : "Using the usual slip."}</li>
          <li>
            {facts.slip.logo
              ? "Your logo prints at the top."
              : "No logo yet: tag a picture “logo” in Social → Assets and it prints at the top."}
          </li>
        </ul>
        {canEdit && (
          <Button asChild variant="outline" size="sm" className="w-fit">
            <Link href={`${base}/settings/shipping/slip`}>Design the slip</Link>
          </Button>
        )}
        {stepItems("slip")}
      </SetupStepCard>

      {/* 6. Rules */}
      <SetupStepCard
        {...stepProps("rules")}
        description="Say once what should happen, and every order follows: a box for certain items, a signature on big orders, a hold for something that needs a look."
      >
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            {facts.rules.count === 0
              ? "No rules yet."
              : `${facts.rules.count} rule${facts.rules.count === 1 ? "" : "s"}, checked from the top.`}
          </li>
          <li>
            {facts.rules.signatureOver === null
              ? "No signature asked for by order value."
              : `Orders of ${formatMoney(facts.rules.signatureOver, tenant.currency)} or more need a signature.`}
          </li>
        </ul>
        {canEdit && (
          <Button asChild variant="outline" size="sm" className="w-fit">
            <Link href={`${base}/settings/shipping/rules`}>Your rules</Link>
          </Button>
        )}
        {stepItems("rules")}
      </SetupStepCard>

      {/* 7. Review */}
      <SetupStepCard {...stepProps("review")} description="Where things stand now.">
        {open.filter((item) => !item.optional).length === 0 ? (
          <p className="text-sm">
            Nothing left that gets in the way of sending. Anything below is up to you.
          </p>
        ) : null}
        {open.length > 0 && (
          <>
            <p className="text-sm font-medium">Still open</p>
            <SetupList
              slug={tenant.slug}
              tool={SHIPPING_TOOL}
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
                      tool={SHIPPING_TOOL}
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
          <Link href={`${base}/shipping`}>See what&apos;s to ship</Link>
        </Button>
      </SetupStepCard>
    </>
  );
}
