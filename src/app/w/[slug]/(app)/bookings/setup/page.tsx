import type { Metadata } from "next";
import Link from "next/link";
import { HowWorkedOut } from "@/components/setup/how-worked-out";
import { NotNowButton } from "@/components/setup/not-now-button";
import { SetupList } from "@/components/setup/setup-list";
import { SetupStepCard } from "@/components/setup/setup-step";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { readEmailSettings } from "@/lib/bookings/email-settings";
import { zoneExplained } from "@/lib/bookings/explain";
import { BOOKINGS_STEPS, BOOKINGS_TOOL, bookingsSetupItems } from "@/lib/bookings/setup";
import { loadBookingsSetupFacts } from "@/lib/bookings/setup-data";
import { loadNotNow } from "@/lib/setup/data";
import { firstOpenStep, openByStep, someNames, sortItems } from "@/lib/setup/items";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { BookingEmailsForm, ServiceForm } from "../forms";
import { bookingsAccess } from "../gate";
import { ReplyToForm } from "../words-form";

export const metadata: Metadata = { title: "Set up" };

/** Services listed by name in a step; the rest are on Coming up. */
const SHOWN = 8;

/**
 * Bookings → Set up: the checklist as steps, each writing through the same
 * forms and checked functions as everywhere else (the service form, the
 * emails form and the reply-to form are Bookings' own). Progress is the
 * facts (`bookingsSetupItems`), never stored; a person lands on the first
 * step with something open, and any step can be skipped. Everyone with
 * Bookings can look; what only owners and admins can change says so.
 */
export default async function BookingsSetupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/setup`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role);
  const canEdit = manager && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const [facts, notNow, emails, site] = await Promise.all([
    loadBookingsSetupFacts(supabase, tenant, {
      manager,
      can: (feature) => entitlements.can(feature),
    }),
    loadNotNow(supabase, tenant.id, BOOKINGS_TOOL),
    readEmailSettings(supabase, tenant.id),
    getSiteUrl(),
  ]);

  const { open, resting } = sortItems(bookingsSetupItems(facts), notNow);
  const steps = BOOKINGS_STEPS;
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
      tool={BOOKINGS_TOOL}
      items={byStep.get(id) ?? []}
      canSnooze={canEdit}
      canAct={canEdit}
    />
  );

  const live = facts.services.filter((s) => s.active);
  const workshops = live.filter((s) => s.kind === "workshop");
  const appointments = live.filter((s) => s.kind === "appointment");
  const inShop = workshops.filter((s) => s.inShop);
  const paidHere = live.filter((s) => s.paid && !s.inShop);
  const withDates = new Set(facts.workshopsWithDates);
  const withHours = new Set(facts.appointmentsWithHours);
  const { timing, words } = emails;

  return (
    <>
      <PageHeader
        title="Set up"
        description="A few steps so people can find a date, book it, pay and hear from you. Skip anything, come back any time: this page remembers nothing but what you've already set."
      />

      {!manager && (
        <Card>
          <CardContent className="pt-6 text-sm">
            An owner or admin sets most of these up. You can see where things stand, and anything
            that&apos;s theirs to do says so.
          </CardContent>
        </Card>
      )}

      {/* 1. What people can book */}
      <SetupStepCard
        {...stepProps("what")}
        description="A workshop has set dates with several places on each. An appointment is one person at a time, from your open hours."
      >
        <p className="text-sm">
          {live.length === 0
            ? "Nothing to book yet."
            : `${live.length} on offer: ${someNames(
                live.map((s) => s.name),
                SHOWN,
              )}.`}
        </p>
        {canEdit && (
          <details open={live.length === 0}>
            <summary className="text-ochre-text cursor-pointer text-sm font-medium">
              Add a workshop or appointment
            </summary>
            <div className="pt-4">
              <ServiceForm slug={tenant.slug} currency={tenant.currency} />
            </div>
          </details>
        )}
        {stepItems("what")}
      </SetupStepCard>

      {/* 2. Dates and open hours */}
      <SetupStepCard
        {...stepProps("dates")}
        description="Dates are added on each workshop's page; open hours on each appointment's page."
      >
        {live.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {[...workshops, ...appointments].slice(0, SHOWN * 2).map((s) => {
              const ready = s.kind === "workshop" ? withDates.has(s.id) : withHours.has(s.id);
              return (
                <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    {s.name}{" "}
                    <span className="text-muted-foreground">
                      ·{" "}
                      {s.kind === "workshop"
                        ? ready
                          ? "has dates coming up"
                          : "no dates coming up"
                        : ready
                          ? "has open hours"
                          : "no open hours"}
                    </span>
                  </span>
                  <Link
                    href={`${base}/bookings/services/${s.id}`}
                    className="text-ochre-text text-sm underline-offset-2 hover:underline"
                  >
                    {s.kind === "workshop" ? "Dates" : "Open hours"}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <HowWorkedOut
          label="Which clock the times are on"
          lines={zoneExplained(tenant.timezone, facts.now)}
          change={canEdit ? { href: `${base}/settings`, label: "Workspace settings" } : null}
        />
        {stepItems("dates")}
      </SetupStepCard>

      {/* 3. How people pay */}
      <SetupStepCard
        {...stepProps("selling")}
        description="Two ways: on your own booking page, paid into your own Stripe account, or through your shop, where the shop takes the payment and its orders become bookings."
      >
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-semibold">On your booking page</p>
          <p className="text-muted-foreground">
            {paidHere.length === 0
              ? "Nothing with a price is booked here, so Stripe isn't needed."
              : facts.stripe?.status === "active"
                ? facts.stripe.chargesEnabled === false
                  ? "Stripe is connected, but hasn't switched payments on for you yet. It's usually still checking your details, or needs something more from you."
                  : `Stripe is connected: payments for ${someNames(
                      paidHere.map((s) => s.name),
                      SHOWN,
                    )} go straight into your own account.`
                : "Stripe isn't connected, so only free bookings can be made here."}
          </p>
          <p className="text-muted-foreground">
            Your page:{" "}
            <a href={`${site}/book/${tenant.slug}`} className="text-ochre-text hover:underline">
              {`${site}/book/${tenant.slug}`}
            </a>
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {canEdit && (
              <Button asChild variant="outline" size="sm">
                <Link href={`${base}/connections`}>Go to Connections</Link>
              </Button>
            )}
            {facts.stripe?.status === "active" && facts.stripe.chargesEnabled === false && (
              <Button asChild variant="ghost" size="sm">
                <a href="https://dashboard.stripe.com/account/status">Check your Stripe account</a>
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-semibold">Through your shop</p>
          <p className="text-muted-foreground">
            {inShop.length === 0
              ? "No workshop is sold through your shop. To sell one there, link it to its product on the workshop's page."
              : `${inShop.length} ${inShop.length === 1 ? "workshop is" : "workshops are"} sold in your shop: ${someNames(
                  inShop.map((s) => s.name),
                  SHOWN,
                )}.`}
          </p>
          {inShop.length > 0 && (
            <p className="text-muted-foreground">
              {facts.shopBookings === null
                ? "We couldn't tell whether bookings have come in through your shop yet."
                : facts.shopBookings > 0
                  ? `${facts.shopBookings} ${facts.shopBookings === 1 ? "booking has" : "bookings have"} come in through your shop since a workshop was linked, so the date picker is working.`
                  : "We can't see your theme from here. Paste the date picker and the cart check into it (Settings → Bookings → Shop product page); this step ticks itself off when the first booking comes in through your shop."}
            </p>
          )}
          {canEdit && inShop.length > 0 && (
            <Button asChild variant="outline" size="sm" className="w-fit">
              <Link href={`${base}/settings/bookings/shop-page`}>Get the snippets</Link>
            </Button>
          )}
        </div>
        {stepItems("selling")}
      </SetupStepCard>

      {/* 4. Emails */}
      <SetupStepCard
        {...stepProps("emails")}
        description="Everyone gets a confirmation with a link to change or cancel, then a reminder. Change the words of any of them under Email words."
      >
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-semibold">Where replies go</p>
          {canEdit ? (
            <ReplyToForm slug={tenant.slug} replyTo={words.reply_to} />
          ) : (
            <p className="text-muted-foreground">
              {words.reply_to
                ? `Replies go to ${words.reply_to}.`
                : "No reply address yet. An owner or admin can add one."}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-semibold">When they go</p>
          {canEdit ? (
            <BookingEmailsForm slug={tenant.slug} settings={timing} />
          ) : (
            <p className="text-muted-foreground">
              Reminders go {timing.reminder_hours} hours before; the thank-you is{" "}
              {timing.followup_on ? `sent ${timing.followup_hours} hours after` : "off"}.
            </p>
          )}
        </div>
        <Button asChild variant="ghost" size="sm" className="w-fit">
          <Link href={`${base}/settings/bookings/words`}>Read every email&apos;s words</Link>
        </Button>
        {stepItems("emails")}
      </SetupStepCard>

      {/* 5. Extras */}
      <SetupStepCard
        {...stepProps("extras")}
        description="None of these are needed for people to book. Take them or leave them."
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
            {workshops.length} {workshops.length === 1 ? "workshop" : "workshops"},{" "}
            {appointments.length} {appointments.length === 1 ? "appointment" : "appointments"}.
          </li>
          <li>
            {workshops.filter((s) => withDates.has(s.id)).length} of the workshops have dates coming
            up.
          </li>
        </ul>
        {open.length === 0 ? (
          <p className="text-sm">Nothing left to set up. People can find a date, book and pay.</p>
        ) : (
          <>
            <p className="text-sm font-medium">Still open</p>
            <SetupList
              slug={tenant.slug}
              tool={BOOKINGS_TOOL}
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
                      tool={BOOKINGS_TOOL}
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
          <Link href={`${base}/bookings`}>See what&apos;s coming up</Link>
        </Button>
      </SetupStepCard>
    </>
  );
}
