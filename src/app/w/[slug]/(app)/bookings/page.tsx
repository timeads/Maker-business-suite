import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { daysFromNow, formatDay, formatTime, localDay } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/dashboard/format";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { ServiceForm } from "./forms";
import { bookingsAccess } from "./gate";

export const metadata: Metadata = { title: "Bookings" };

type SessionRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  private: boolean;
  bookings_closed: boolean;
  services: { name: string } | null;
  bookings: {
    seats: number;
    status: string;
    oversold: boolean;
    amount_cents: number;
    attendance: string | null;
    confirmed_at: string | null;
  }[];
};

export default async function BookingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}/bookings`;

  const supabase = await createClient();
  const days = daysFromNow;
  const [{ data: services }, { data: sessions }, { data: payout }, site, { data: recent }] =
    await Promise.all([
      supabase
        .from("services")
        .select("id, kind, name, slug, duration_minutes, price_cents, active")
        .eq("tenant_id", tenant.id)
        .order("name"),
      supabase
        .from("sessions")
        .select(
          "id, starts_at, ends_at, capacity, private, bookings_closed, services(name), bookings(seats, status, oversold, amount_cents, attendance, confirmed_at)",
        )
        .eq("tenant_id", tenant.id)
        .is("cancelled_at", null)
        .gte("starts_at", days(0))
        .order("starts_at")
        .limit(60),
      supabase
        .from("connections")
        .select("status, display_name, metadata")
        .eq("tenant_id", tenant.id)
        .eq("provider", "stripe")
        .maybeSingle(),
      getSiteUrl(),
      // The last 90 days, for the turnout figure.
      supabase
        .from("sessions")
        .select("bookings(seats, status, attendance)")
        .eq("tenant_id", tenant.id)
        .is("cancelled_at", null)
        .gte("starts_at", days(-90))
        .lt("starts_at", days(0))
        .limit(500),
    ]);
  const upcoming = ((sessions ?? []) as unknown as SessionRow[]).filter(
    (s) => s.bookings.some((b) => b.status === "confirmed") || s.capacity > 1,
  );
  const confirmed = (s: SessionRow) => s.bookings.filter((b) => b.status === "confirmed");
  const seats = (s: SessionRow) => confirmed(s).reduce((sum, b) => sum + b.seats, 0);
  const soon = ((sessions ?? []) as unknown as SessionRow[]).filter((s) => s.starts_at < days(30));
  const soonSeats = soon.reduce((n, s) => n + seats(s), 0);
  const soonRoom = soon.filter((s) => s.capacity > 1).reduce((n, s) => n + s.capacity, 0);
  const soonMoney = soon.reduce(
    (n, s) => n + confirmed(s).reduce((sum, b) => sum + b.amount_cents, 0),
    0,
  );
  const newThisWeek = ((sessions ?? []) as unknown as SessionRow[]).reduce(
    (n, s) => n + confirmed(s).filter((b) => (b.confirmed_at ?? "") > days(-7)).length,
    0,
  );
  const marked = ((recent ?? []) as unknown as { bookings: SessionRow["bookings"] }[])
    .flatMap((s) => s.bookings)
    .filter((b) => b.status === "confirmed" && b.attendance);
  const cameShare = marked.length
    ? Math.round((marked.filter((b) => b.attendance === "attended").length / marked.length) * 100)
    : null;
  const stats: { label: string; value: string; note: string }[] = [
    { label: "New this week", value: String(newThisWeek), note: "bookings in the last 7 days" },
    {
      label: "Next 30 days",
      value: String(soonSeats),
      note: soonRoom ? `places booked of ${soonRoom} on offer` : "places booked",
    },
    {
      label: "Paid ahead",
      value: formatMoney(soonMoney / 100, tenant.currency),
      note: "for the next 30 days",
    },
    {
      label: "Turnout",
      value: cameShare === null ? "–" : `${cameShare}%`,
      note: cameShare === null ? "check people in to see this" : "showed up, last 90 days",
    },
  ];
  const byDay = new Map<string, SessionRow[]>();
  for (const s of upcoming) {
    const day = localDay(new Date(s.starts_at), tenant.timezone);
    byDay.set(day, [...(byDay.get(day) ?? []), s]);
  }
  const bookingUrl = `${site}/book/${tenant.slug}`;
  const hasPaid = (services ?? []).some((s) => s.price_cents > 0);
  const payoutsOn = payout?.status === "active";
  const stripeNotReady =
    (payout?.metadata as { charges_enabled?: boolean } | null)?.charges_enabled === false;

  return (
    <>
      <PageHeader
        title="Coming up"
        description="Your workshops and appointments, and who's coming."
      >
        <Button asChild variant="outline" size="sm">
          <a href={bookingUrl}>See your booking page</a>
        </Button>
      </PageHeader>

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="bg-card border-border rounded-lg border px-4 py-3">
            <dt className="text-muted-foreground text-xs font-semibold">{stat.label}</dt>
            <dd className="mt-1 text-2xl leading-none font-bold tabular-nums">{stat.value}</dd>
            <dd className="text-muted-foreground mt-1.5 text-xs">{stat.note}</dd>
          </div>
        ))}
      </dl>

      {hasPaid && payoutsOn && stripeNotReady && (
        <Card>
          <CardHeader>
            <CardTitle>Stripe isn&apos;t ready to take payments yet</CardTitle>
            <CardDescription>
              Your Stripe account is connected, but Stripe hasn&apos;t switched on payments for it.
              This usually means it is still checking your details, or needs something more from
              you. Until then, customers can&apos;t book anything with a price.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <a href="https://dashboard.stripe.com/account/status">Check your Stripe account</a>
            </Button>
          </CardContent>
        </Card>
      )}

      {hasPaid && !payoutsOn && (
        <Card>
          <CardHeader>
            <CardTitle>Connect Stripe to take payment</CardTitle>
            <CardDescription>
              Paid bookings go straight into your own Stripe account. Until it&apos;s connected,
              only free bookings can be made online.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href={`/w/${tenant.slug}/connections`}>Go to Connections</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Coming up</CardTitle>
          <CardDescription>
            Open a date to see who&apos;s coming and check people in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {upcoming.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing on the calendar yet. Add a workshop date or wait for your first appointment.
            </p>
          ) : (
            <div className="flex flex-col gap-5">
              {[...byDay].map(([day, list]) => (
                <section key={day}>
                  <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                    {formatDay(day)}
                  </h3>
                  <ul className="mt-1 flex flex-col">
                    {list.map((s) => {
                      const taken = seats(s);
                      const full = taken >= s.capacity;
                      return (
                        <li key={s.id}>
                          <Link
                            href={`${base}/sessions/${s.id}`}
                            className="hover:bg-hover -mx-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm px-2 py-2 text-sm"
                          >
                            <span className="text-muted-foreground w-20 shrink-0 tabular-nums">
                              {formatTime(s.starts_at, tenant.timezone)}
                            </span>
                            <span className="min-w-0 flex-1 basis-40 font-semibold">
                              {s.services?.name}
                            </span>
                            {s.private && <Badge tone="waiting">Private</Badge>}
                            {s.bookings_closed && <Badge>Not taking bookings</Badge>}
                            {s.bookings.some((b) => b.oversold && b.status === "confirmed") ? (
                              <Badge tone="bad">Over its limit</Badge>
                            ) : (
                              full && s.capacity > 1 && <Badge tone="good">Full</Badge>
                            )}
                            <span className="flex w-36 items-center gap-2">
                              <span
                                aria-hidden
                                className="bg-sunken h-1.5 flex-1 overflow-hidden rounded-full"
                              >
                                <span
                                  className="bg-teal block h-full rounded-full"
                                  style={{
                                    width: `${Math.min(100, (taken / s.capacity) * 100)}%`,
                                  }}
                                />
                              </span>
                              <span className="text-muted-foreground tabular-nums">
                                {taken} of {s.capacity}
                              </span>
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What people can book</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {(services ?? []).length > 0 && (
            <ul className="divide-border flex flex-col divide-y">
              {(services ?? []).map((service) => (
                <li key={service.id}>
                  <Link
                    href={`${base}/services/${service.id}`}
                    className="hover:bg-hover -mx-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-sm px-2 py-2 text-sm"
                  >
                    <span className="flex-1 font-medium">{service.name}</span>
                    <span className="text-muted-foreground">
                      {service.kind === "workshop" ? "Workshop" : "Appointment"} ·{" "}
                      {service.price_cents === 0
                        ? "Free"
                        : formatMoney(service.price_cents / 100, tenant.currency)}
                      {!service.active && " · hidden"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {canEdit ? (
            <details className="group" open={(services ?? []).length === 0}>
              <summary className="text-ochre-text cursor-pointer text-sm font-medium">
                Add a workshop or appointment
              </summary>
              <div className="pt-4">
                <ServiceForm slug={tenant.slug} currency={tenant.currency} />
              </div>
            </details>
          ) : (
            (services ?? []).length === 0 && (
              <p className="text-muted-foreground text-sm">
                An owner or admin can add the first workshop or appointment.
              </p>
            )
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your booking page</CardTitle>
          <CardDescription>
            Share the link, or put the booking form on your own site.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p>
            <a href={bookingUrl} className="text-ochre-text font-medium hover:underline">
              {bookingUrl}
            </a>
          </p>
          <p className="text-muted-foreground">
            To show it on your website or Shopify store, paste this where the form should appear (in
            Shopify: add a &quot;Custom liquid&quot; section to the page).
          </p>
          <pre className="bg-muted overflow-x-auto rounded p-3 text-xs">
            {`<div data-maker-booking="${tenant.slug}"></div>\n<script src="${site}/embed.js" async></script>`}
          </pre>
        </CardContent>
      </Card>
    </>
  );
}
