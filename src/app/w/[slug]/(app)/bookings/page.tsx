import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatWhen } from "@/lib/bookings/slots";
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
  services: { name: string } | null;
  bookings: { seats: number; status: string; oversold: boolean }[];
};

export default async function BookingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}/bookings`;

  const supabase = await createClient();
  const [{ data: services }, { data: sessions }, { data: payout }, site] = await Promise.all([
    supabase
      .from("services")
      .select("id, kind, name, slug, duration_minutes, price_cents, active")
      .eq("tenant_id", tenant.id)
      .order("name"),
    supabase
      .from("sessions")
      .select("id, starts_at, ends_at, capacity, services(name), bookings(seats, status, oversold)")
      .eq("tenant_id", tenant.id)
      .is("cancelled_at", null)
      .gte("starts_at", new Date().toISOString())
      .order("starts_at")
      .limit(30),
    supabase
      .from("connections")
      .select("status, display_name, metadata")
      .eq("tenant_id", tenant.id)
      .eq("provider", "stripe")
      .maybeSingle(),
    getSiteUrl(),
  ]);
  const upcoming = ((sessions ?? []) as unknown as SessionRow[]).filter(
    (s) => s.bookings.some((b) => b.status === "confirmed") || s.capacity > 1,
  );
  const bookingUrl = `${site}/book/${tenant.slug}`;
  const hasPaid = (services ?? []).some((s) => s.price_cents > 0);
  const payoutsOn = payout?.status === "active";
  const stripeNotReady =
    (payout?.metadata as { charges_enabled?: boolean } | null)?.charges_enabled === false;

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Bookings</h1>
        <Link href={`${base}/settings`} className="text-muted-foreground text-sm hover:underline">
          Booking page settings
        </Link>
      </header>

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
            <Button asChild>
              <Link href={`/w/${tenant.slug}/connections`}>Go to Connections</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Coming up</CardTitle>
          <CardDescription>Your next dates and who&apos;s booked on them.</CardDescription>
        </CardHeader>
        <CardContent>
          {upcoming.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing on the calendar yet. Add a workshop date or wait for your first appointment.
            </p>
          ) : (
            <ul className="divide-border flex flex-col divide-y">
              {upcoming.map((s) => {
                const taken = s.bookings
                  .filter((b) => b.status === "confirmed")
                  .reduce((sum, b) => sum + b.seats, 0);
                return (
                  <li key={s.id}>
                    <Link
                      href={`${base}/sessions/${s.id}`}
                      className="hover:bg-muted -mx-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded px-2 py-2 text-sm"
                    >
                      <span className="font-medium">{s.services?.name}</span>
                      <span className="text-muted-foreground flex-1">
                        {formatWhen(s.starts_at, s.ends_at, tenant.timezone)}
                      </span>
                      <span>
                        {taken} of {s.capacity} booked
                        {s.bookings.some((b) => b.oversold && b.status === "confirmed") &&
                          " · over its limit"}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
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
                    className="hover:bg-muted -mx-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded px-2 py-2 text-sm"
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
