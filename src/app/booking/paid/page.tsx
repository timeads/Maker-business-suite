import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { BookingShell } from "@/app/book/shell";
import { confirmCheckout } from "@/lib/bookings/payments";
import {
  bookingsConfigured,
  getPayoutAccount,
  getPublicWorkspace,
  livePaymentDeps,
} from "@/lib/bookings/server";

export const metadata: Metadata = { title: "Booking", robots: { index: false } };

/**
 * Where Stripe sends people after paying. The payment is checked with Stripe
 * here as well as by the webhook, so the booking is confirmed straight away
 * whichever arrives first.
 */
export default async function PaidPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string; checkout?: string }>;
}) {
  const { w, checkout } = await searchParams;
  if (!bookingsConfigured() || !w || !checkout || !/^cs_[A-Za-z0-9_]+$/.test(checkout)) notFound();
  const tenant = await getPublicWorkspace(w);
  if (!tenant) notFound();
  const payout = await getPayoutAccount(tenant.id);
  if (!payout) notFound();

  let outcome;
  try {
    outcome = await confirmCheckout(checkout, payout.account, livePaymentDeps());
  } catch (err) {
    console.error("Could not check a booking payment", err instanceof Error ? err.message : err);
    outcome = { result: "unpaid" as const };
  }
  if ("manageToken" in outcome && outcome.manageToken && outcome.tenantId === tenant.id) {
    redirect(`/booking/${outcome.manageToken}?new=1`);
  }
  if (outcome.result === "not_ours") notFound();

  return (
    <BookingShell workspaceName={tenant.name} href={`/book/${tenant.slug}`}>
      <h1 className="text-3xl font-semibold tracking-tight">
        Thanks! We&apos;re confirming your payment
      </h1>
      <p>
        This usually takes a few seconds. You&apos;ll get an email as soon as your booking is
        confirmed, so it&apos;s fine to close this page.
      </p>
    </BookingShell>
  );
}
