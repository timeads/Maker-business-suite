import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import {
  bookingsConfigured,
  getAppointmentSlots,
  getBookingForm,
  getLivePayoutAccount,
  getPublicService,
  getPublicWorkspace,
  getSessionAvailability,
} from "@/lib/bookings/server";
import { formatDay, formatTime, formatWhen } from "@/lib/bookings/slots";
import { BookingShell, NOTICES, durationLabel, priceLabel } from "../../shell";

export const metadata: Metadata = { title: "Book", robots: { index: false } };

const choice =
  "border-input bg-card has-checked:border-primary has-checked:ring-primary flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm has-checked:ring-1";

export default async function ServicePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; service: string }>;
  searchParams: Promise<{
    embed?: string;
    day?: string;
    error?: string;
    notice?: string;
    waitlist?: string;
  }>;
}) {
  const { slug, service: serviceSlug } = await params;
  const query = await searchParams;
  const embed = query.embed === "1";
  if (!bookingsConfigured()) notFound();
  const tenant = await getPublicWorkspace(slug);
  if (!tenant) notFound();
  const service = await getPublicService(tenant.id, serviceSlug);
  if (!service) notFound();

  const base = `/book/${tenant.slug}/${service.slug}`;
  const withEmbed = (extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ ...(embed ? { embed: "1" } : {}), ...extra }).toString();
    return q ? `${base}?${q}` : base;
  };

  const [form, payout] = await Promise.all([
    getBookingForm(tenant.id),
    service.price_cents > 0 ? getLivePayoutAccount(tenant.id) : null,
  ]);
  const canPay = service.price_cents === 0 || Boolean(payout?.ready);
  const message = NOTICES[query.error ?? ""] ?? NOTICES[query.notice ?? ""];

  const sessions =
    service.kind === "workshop" ? await getSessionAvailability(tenant.id, service.id) : [];
  const slots = service.kind === "appointment" ? await getAppointmentSlots(tenant, service) : [];
  const days = [...new Set(slots.map((s) => s.day))];
  const day = days.includes(query.day ?? "") ? (query.day as string) : days[0];
  const open = sessions.filter((s) => s.seats_left > 0);
  const waitlistFor = sessions.find((s) => s.session_id === query.waitlist && s.seats_left === 0);
  const nothing = service.kind === "workshop" ? sessions.length === 0 : slots.length === 0;
  const maxSeats = Math.min(10, Math.max(1, ...open.map((s) => s.seats_left)));

  const details = (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Your name</Label>
          <Input id="name" name="name" autoComplete="name" maxLength={120} required />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
      </div>
      {/* Left empty by people; filled in by bots. */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" />
    </>
  );

  return (
    <BookingShell workspaceName={tenant.name} href={`/book/${tenant.slug}`} embed={embed}>
      <header className="flex flex-col gap-2">
        {embed && (
          <Link
            href={`/book/${tenant.slug}?embed=1`}
            className="text-muted-foreground text-sm hover:underline"
          >
            ← Everything you can book
          </Link>
        )}
        <h1 className="text-3xl font-semibold tracking-tight">{service.name}</h1>
        <p className="text-muted-foreground text-sm">
          {durationLabel(service.duration_minutes)} ·{" "}
          {priceLabel(service.price_cents, tenant.currency)}
          {service.kind === "workshop" && service.price_cents > 0 ? " per place" : ""}
        </p>
        {service.description && <p className="whitespace-pre-line">{service.description}</p>}
      </header>

      <FormMessage kind={query.error ? "error" : "success"}>{message}</FormMessage>

      {waitlistFor ? (
        <form action="/api/book/waitlist" method="post" className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">
            Join the waitlist for{" "}
            {formatWhen(waitlistFor.starts_at, waitlistFor.ends_at, tenant.timezone)}
          </h2>
          <p className="text-muted-foreground text-sm">
            We&apos;ll email you if a place opens up. It&apos;s first come, first served.
          </p>
          <input type="hidden" name="workspace" value={tenant.slug} />
          <input type="hidden" name="service" value={service.slug} />
          <input type="hidden" name="session" value={waitlistFor.session_id} />
          {embed && <input type="hidden" name="embed" value="1" />}
          {details}
          <div className="flex gap-3">
            <Button type="submit">Join the waitlist</Button>
            <Button asChild variant="outline">
              <Link href={withEmbed()}>Back</Link>
            </Button>
          </div>
        </form>
      ) : nothing ? (
        <p className="text-muted-foreground">There are no times open right now. Check back soon.</p>
      ) : !canPay ? (
        <FormMessage>{NOTICES.payments_off}</FormMessage>
      ) : (
        <form
          action="/api/book/reserve"
          method="post"
          // Payment happens on Stripe's page, which can't sit inside a frame.
          target={embed ? "_top" : undefined}
          className="flex flex-col gap-6"
        >
          <input type="hidden" name="workspace" value={tenant.slug} />
          <input type="hidden" name="service" value={service.slug} />

          {service.kind === "workshop" ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="pb-2 text-lg font-semibold">Pick a date</legend>
              {sessions.map((s, i) => {
                const when = formatWhen(s.starts_at, s.ends_at, tenant.timezone);
                return s.seats_left > 0 ? (
                  <label key={s.session_id} className={choice}>
                    <input
                      type="radio"
                      name="session"
                      value={s.session_id}
                      required
                      defaultChecked={open.length === 1 || (open[0] === s && i === 0)}
                    />
                    <span className="flex-1">{when}</span>
                    <span className="text-muted-foreground">
                      {s.seats_left === 1 ? "1 place left" : `${s.seats_left} places left`}
                    </span>
                  </label>
                ) : (
                  <div
                    key={s.session_id}
                    className="border-input text-muted-foreground flex items-center gap-3 rounded-md border border-dashed px-3 py-2 text-sm"
                  >
                    <span className="flex-1">{when}</span>
                    <span>Full</span>
                    <Link
                      href={withEmbed({ waitlist: s.session_id })}
                      className="text-ochre-text font-medium hover:underline"
                    >
                      Join the waitlist
                    </Link>
                  </div>
                );
              })}
            </fieldset>
          ) : (
            <div className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">Pick a time</h2>
              <nav aria-label="Days" className="flex flex-wrap gap-2">
                {days.map((d) => (
                  <Link
                    key={d}
                    href={withEmbed({ day: d })}
                    aria-current={d === day ? "date" : undefined}
                    className="border-input aria-[current]:border-primary aria-[current]:bg-primary aria-[current]:text-primary-foreground rounded-md border px-3 py-1.5 text-sm"
                  >
                    {formatDay(d).replace(/^(\w{3})\w*, (\w{3})\w* /, "$1, $2 ")}
                  </Link>
                ))}
              </nav>
              <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <legend className="text-muted-foreground pb-2 text-sm">{formatDay(day)}</legend>
                {slots
                  .filter((s) => s.day === day)
                  .map((s) => (
                    <label key={s.startsAt} className={choice}>
                      <input type="radio" name="starts_at" value={s.startsAt} required />
                      {formatTime(s.startsAt, tenant.timezone)}
                    </label>
                  ))}
              </fieldset>
              <p className="text-muted-foreground text-xs">
                Times are shown in {tenant.timezone.replace(/_/g, " ")} time.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">Your details</h2>
            {details}
            {service.kind === "workshop" && (
              <div className="flex flex-col gap-2 sm:w-40">
                <Label htmlFor="seats">How many places?</Label>
                <Select id="seats" name="seats" defaultValue="1">
                  {Array.from({ length: maxSeats }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {i + 1}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {form.questions.map((q) => (
              <div key={q.id} className="flex flex-col gap-2">
                <Label htmlFor={`answer_${q.id}`}>
                  {q.label}
                  {!q.required && <span className="text-muted-foreground"> (optional)</span>}
                </Label>
                <Input
                  id={`answer_${q.id}`}
                  name={`answer_${q.id}`}
                  maxLength={1000}
                  required={q.required}
                />
              </div>
            ))}
          </div>

          <Button type="submit" className="sm:w-fit">
            {service.price_cents > 0 ? "Continue to payment" : "Book now"}
          </Button>
        </form>
      )}
    </BookingShell>
  );
}
