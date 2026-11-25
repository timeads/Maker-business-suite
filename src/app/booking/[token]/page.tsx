import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BookingShell, priceLabel } from "@/app/book/shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { Select } from "@/components/ui/input";
import {
  bookingsConfigured,
  getBookingDetails,
  getSessionAvailability,
} from "@/lib/bookings/server";
import { formatWhen, isUpcoming } from "@/lib/bookings/slots";

export const metadata: Metadata = {
  title: "Your booking",
  robots: { index: false },
  referrer: "no-referrer",
};

const NOTES: Record<string, { kind: "error" | "success"; text: string }> = {
  moved: { kind: "success", text: "Done. Your booking has been moved." },
  cancelled: { kind: "success", text: "Your booking has been cancelled." },
  full: { kind: "error", text: "Sorry, that date doesn't have enough places left." },
  unavailable: { kind: "error", text: "That date isn't available. Pick another one." },
  too_late: {
    kind: "error",
    text: "This booking has already started, so it can't be changed here.",
  },
};

/** The page behind the link in a customer's confirmation email. */
export default async function ManageBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ new?: string; note?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  if (!bookingsConfigured() || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) notFound();
  const booking = await getBookingDetails({ token });
  if (!booking) notFound();

  const upcoming = isUpcoming(booking.starts_at);
  const confirmed = booking.status === "confirmed" && !booking.session_cancelled;
  const canChange = confirmed && upcoming;
  const others =
    canChange && booking.service_kind === "workshop"
      ? (await getSessionAvailability(booking.tenant_id, booking.service_id)).filter(
          (s) => s.session_id !== booking.session_id && s.seats_left >= booking.seats,
        )
      : [];
  const note = NOTES[query.note ?? ""];
  const when = formatWhen(booking.starts_at, booking.ends_at, booking.timezone);

  const heading = booking.session_cancelled
    ? `${booking.workspace_name} cancelled this date`
    : booking.status === "cancelled"
      ? "This booking is cancelled"
      : booking.status === "pending_payment"
        ? "This booking is waiting for payment"
        : query.new === "1"
          ? "You're booked!"
          : "Your booking";

  return (
    <BookingShell workspaceName={booking.workspace_name} href={`/book/${booking.workspace_slug}`}>
      <h1 className="text-3xl font-semibold tracking-tight">{heading}</h1>
      {note && <FormMessage kind={note.kind}>{note.text}</FormMessage>}
      {booking.session_cancelled && (
        <p className="text-muted-foreground">
          We&apos;re sorry for the change of plans.
          {booking.amount_cents > 0
            ? ` ${booking.workspace_name} will be in touch about your payment.`
            : " There's nothing you need to do."}
        </p>
      )}
      {query.new === "1" && confirmed && (
        <p className="text-muted-foreground">
          We&apos;ve emailed the details to {booking.customer_email}. Keep this page&apos;s link if
          you might need to change or cancel.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{booking.service_name}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">When</dt>
            <dd>{when}</dd>
            {booking.location && (
              <>
                <dt className="text-muted-foreground">Where</dt>
                <dd>{booking.location}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Name</dt>
            <dd>{booking.customer_name}</dd>
            {booking.service_kind === "workshop" && (
              <>
                <dt className="text-muted-foreground">Places</dt>
                <dd>{booking.seats}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{booking.amount_cents > 0 ? "Paid" : "Price"}</dt>
            <dd>{priceLabel(booking.amount_cents, booking.currency)}</dd>
          </dl>
        </CardContent>
      </Card>

      {canChange && others.length > 0 && (
        <form action="/api/book/manage" method="post" className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Move to another date</h2>
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="intent" value="move" />
          <div className="flex flex-col gap-3 sm:flex-row">
            <Select name="session" aria-label="New date" required className="sm:flex-1">
              {others.map((s) => (
                <option key={s.session_id} value={s.session_id}>
                  {formatWhen(s.starts_at, s.ends_at, booking.timezone)}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="outline">
              Move my booking
            </Button>
          </div>
        </form>
      )}

      {canChange && (
        <form action="/api/book/manage" method="post" className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Can&apos;t make it?</h2>
          <p className="text-muted-foreground text-sm">
            Cancelling frees your place for someone else.
            {booking.amount_cents > 0 &&
              ` Refunds are handled by ${booking.workspace_name}, so get in touch with them about your payment.`}
          </p>
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="intent" value="cancel" />
          <Button type="submit" variant="outline" className="sm:w-fit">
            Cancel my booking
          </Button>
        </form>
      )}

      {!canChange && (
        <Button asChild variant="outline" className="sm:w-fit">
          <Link href={`/book/${booking.workspace_slug}`}>Book something else</Link>
        </Button>
      )}
    </BookingShell>
  );
}
