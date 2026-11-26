import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { shopLinks } from "@/lib/helpdesk/customer";
import { loadReturning } from "@/lib/bookings/runsheet-data";
import { limitsToFit, loadSeatFigures, overShared, sharedWords } from "@/lib/bookings/seats";
import { formatWhen, isUpcoming, localClock } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/dashboard/format";
import { LISTING_COLUMNS, linkState, type ListingRow } from "@/lib/eventbrite/events";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { DeleteDateForm, MoveDateForm, RaiseToFitForm } from "../../date-forms";
import { CancelSessionForm } from "../../forms";
import { bookingsAccess } from "../../gate";
import {
  AddPersonForm,
  EmailEveryoneForm,
  PrintButton,
  Roster,
  SessionSettingsForm,
  type RosterPerson,
} from "../../roster";
import { SharedLimitForms, ShareSeatsForm, type SharedDate } from "../../shared-seats";
import { RetryLinkForm } from "../../eventbrite-forms";
import { AddShopOrderForm } from "../../shop-orders";

export const metadata: Metadata = { title: "Who's coming" };

type BookingRow = {
  id: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  seats: number;
  status: "pending_payment" | "confirmed" | "cancelled";
  oversold: boolean;
  answers: Record<string, string>;
  confirmed_at: string | null;
  amount_cents: number;
  currency: string;
  attendance: "attended" | "no_show" | null;
  notes: string;
  tags: string[];
  source: "online" | "manual" | "eventbrite";
  email_opt_in: boolean;
  shop_order_id: string | null;
  shop_order_name: string | null;
  eventbrite_order_id: string | null;
};

const MAIL_WORDS: Record<string, string> = {
  reminder: "Reminder",
  day_of: "Day-of reminder",
  followup: "Thank-you",
  cancelled: "Cancellation email",
};

export default async function SessionPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/sessions/${id}`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createClient();
  const { data: session } = await supabase
    .from("sessions")
    .select(
      "id, starts_at, ends_at, capacity, cancelled_at, bookings_closed, private, notes, service_id, seat_group_id, services(name, kind, location, eventbrite_on)",
    )
    .eq("id", id)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!session) notFound();
  const service = session.services as unknown as {
    name: string;
    kind: string;
    location: string;
    eventbrite_on: boolean;
  };
  const [
    { data: bookingRows },
    { data: waiting },
    { data: siblings },
    { data: sent },
    { count: shopWorkshops },
    { data: mailRows },
    { data: sameTime },
    { data: shop },
    { data: eventbriteRow },
  ] = await Promise.all([
    supabase
      .from("bookings")
      .select(
        "id, customer_name, customer_email, customer_phone, seats, status, oversold, answers, confirmed_at, amount_cents, currency, attendance, notes, tags, source, email_opt_in, shop_order_id, shop_order_name, eventbrite_order_id",
      )
      .eq("session_id", id)
      .order("created_at"),
    supabase
      .from("waitlist")
      .select("id, customer_name, customer_email")
      .eq("session_id", id)
      .order("created_at"),
    supabase
      .from("sessions")
      .select("id, starts_at, ends_at")
      .eq("service_id", session.service_id)
      .is("cancelled_at", null)
      .neq("id", id)
      .gte("starts_at", new Date().toISOString())
      .order("starts_at")
      .limit(40),
    supabase
      .from("booking_messages")
      .select("id, subject, recipients, created_at")
      .eq("session_id", id)
      .order("created_at", { ascending: false })
      .limit(10),
    // Does this workspace sell any workshop through its shop? Then a shop
    // order can be added here by its number.
    supabase
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .not("shop_product_id", "is", null),
    // Automatic emails that didn't go, or may not have: someone should know.
    supabase
      .from("booking_emails")
      .select("booking_id, kind, status")
      .eq("session_id", id)
      .in("status", ["failed", "unsure"]),
    // Other classes running at the same time: they may share this room's places.
    supabase
      .from("sessions")
      .select("id, starts_at, ends_at, capacity, seat_group_id, services(name, kind)")
      .eq("tenant_id", tenant.id)
      .is("cancelled_at", null)
      .neq("id", id)
      .lt("starts_at", session.ends_at)
      .gt("ends_at", session.starts_at)
      .order("starts_at")
      .limit(20),
    // The shop's own name, so a shop-made booking can link to its order there.
    supabase
      .from("connections")
      .select("provider, external_account_id")
      .eq("tenant_id", tenant.id)
      .eq("provider", "shopify")
      .maybeSingle(),
    // Where this date is sold on Eventbrite too, and how its places stand there.
    supabase.from("eventbrite_listings").select(LISTING_COLUMNS).eq("session_id", id).maybeSingle(),
  ]);
  const overlapping = (
    (sameTime ?? []) as unknown as {
      id: string;
      starts_at: string;
      ends_at: string;
      capacity: number;
      seat_group_id: string | null;
      services: { name: string; kind: string } | null;
    }[]
  ).filter((s) => s.services?.kind === "workshop");
  const groupId = session.seat_group_id as string | null;
  const figures = await loadSeatFigures(supabase, [id, ...overlapping.map((s) => s.id)]);
  const mine = figures.get(id);
  const fit = session.cancelled_at ? null : limitsToFit(mine);
  const startClock = localClock(new Date(session.starts_at), tenant.timezone);
  const sharedDate = (s: (typeof overlapping)[number]): SharedDate => ({
    id: s.id,
    label: `${s.services?.name ?? "Class"}, ${formatWhen(s.starts_at, s.ends_at, tenant.timezone)}`,
    taken: figures.get(s.id)?.taken ?? 0,
    capacity: s.capacity,
  });
  const sharing = groupId ? overlapping.filter((s) => s.seat_group_id === groupId) : [];
  const candidates = groupId ? [] : overlapping.filter((s) => !s.seat_group_id);
  const bookings = (bookingRows ?? []) as BookingRow[];
  const coming = bookings.filter((b) => b.status === "confirmed");
  // After a date is called off, keep showing who had booked.
  const shown = session.cancelled_at ? bookings.filter((b) => b.confirmed_at) : coming;
  const taken = coming.reduce((sum, b) => sum + b.seats, 0);
  const here = coming.filter((b) => b.attendance === "attended").reduce((n, b) => n + b.seats, 0);
  const base = `/w/${tenant.slug}/bookings`;
  const live = !session.cancelled_at;
  const upcoming = isUpcoming(session.starts_at);
  const canWrite = entitlements.canWrite && live;
  const manager = canManage(role);
  // Check-in shows from the day before, so the buttons aren't in the way while a date fills.
  const nearOrPast = !isUpcoming(
    new Date(Date.parse(session.starts_at) - 24 * 3600 * 1000).toISOString(),
  );

  const eventbrite = (eventbriteRow ?? null) as ListingRow | null;
  const eventbriteState = eventbrite ? linkState(eventbrite) : null;

  const mailTrouble = new Map<string, string[]>();
  for (const row of (mailRows ?? []) as { booking_id: string; kind: string; status: string }[]) {
    const what = MAIL_WORDS[row.kind] ?? "Email";
    const words = row.status === "unsure" ? `${what} may not have sent` : `${what} didn't send`;
    mailTrouble.set(row.booking_id, [...(mailTrouble.get(row.booking_id) ?? []), words]);
  }

  // Who has come before: worked out now, from the workspace's own earlier bookings.
  const returning = await loadReturning(
    supabase,
    tenant.id,
    shown.map((b) => ({ id: b.id, email: b.customer_email, starts_at: session.starts_at })),
  );
  const shopAccount = shop as { provider: string; external_account_id: string | null } | null;
  const orderLink = (b: BookingRow) => {
    if (!b.shop_order_id) return null;
    const href = shopLinks(
      shopAccount?.provider ?? null,
      shopAccount?.external_account_id ?? null,
      {
        order: b.shop_order_id,
      },
    ).order;
    return { label: b.shop_order_name || "Shop order", href };
  };

  const people: RosterPerson[] = shown.map((b) => ({
    id: b.id,
    name: b.customer_name,
    email: b.customer_email,
    phone: b.customer_phone,
    seats: b.seats,
    attendance: b.attendance,
    notes: b.notes,
    tags: b.tags ?? [],
    manual: b.source === "manual",
    eventbrite: b.source === "eventbrite" ? (b.eventbrite_order_id ?? "") || "?" : null,
    oversold: b.oversold,
    emails: b.email_opt_in,
    paid: b.amount_cents > 0 ? formatMoney(b.amount_cents / 100, b.currency) : null,
    answers: Object.entries(b.answers ?? {}),
    mailTrouble: mailTrouble.get(b.id) ?? [],
    returning: returning.has(b.id),
    order: orderLink(b),
  }));
  const otherDates = (siblings ?? []).map((s) => ({
    id: s.id as string,
    label: formatWhen(s.starts_at as string, s.ends_at as string, tenant.timezone),
  }));

  return (
    <>
      <PageHeader
        back={
          service.kind === "workshop"
            ? { href: `${base}/services/${session.service_id}`, label: service.name }
            : { href: base, label: "Bookings" }
        }
        title={formatWhen(session.starts_at, session.ends_at, tenant.timezone)}
        description={
          <>
            {service.name}
            {service.location ? ` · ${service.location}` : ""} ·{" "}
            {live
              ? `${taken} of ${session.capacity} places booked${here ? ` · ${here} checked in` : ""}${sharedWords(mine) ? ` · ${sharedWords(mine)}` : ""}`
              : "This date was cancelled."}
          </>
        }
      >
        {session.private && <Badge tone="waiting">Private</Badge>}
        {live && session.bookings_closed && <Badge>Not taking bookings</Badge>}
        {live && taken > session.capacity && <Badge tone="bad">Over its limit</Badge>}
        {live && overShared(mine) && <Badge tone="bad">Over the shared limit</Badge>}
        {shown.length > 0 && (
          <>
            <PrintButton />
            <Button asChild variant="outline" size="sm" className="print:hidden">
              <a href={`${base}/sessions/${session.id}/roster-pdf`} target="_blank" rel="noopener">
                <FileText /> PDF
              </a>
            </Button>
            <Button asChild variant="outline" size="sm" className="print:hidden">
              <a href={`${base}/sessions/${session.id}/roster`}>
                <Download /> Spreadsheet
              </a>
            </Button>
          </>
        )}
      </PageHeader>

      {session.notes && (
        <p className="bg-note font-read rounded-md px-4 py-3 text-sm whitespace-pre-wrap">
          {session.notes}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{live ? "Who's coming" : "Who had booked"}</CardTitle>
        </CardHeader>
        <CardContent>
          {people.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nobody yet.{" "}
              {live && upcoming && manager && "You can add someone yourself further down."}
            </p>
          ) : (
            <Roster
              slug={tenant.slug}
              people={people}
              canWrite={canWrite}
              canManage={manager}
              showCheckIn={nearOrPast}
              otherDates={otherDates}
            />
          )}
        </CardContent>
      </Card>

      {service.kind === "workshop" &&
        (eventbriteRow || service.eventbrite_on) &&
        entitlements.can("eventbrite") && (
          <Card className="print:hidden">
            <CardHeader>
              <CardTitle>Eventbrite</CardTitle>
              <CardDescription>
                {eventbrite
                  ? `Also sold as “${eventbrite.event_name || `event ${eventbrite.event_id}`}”. Eventbrite can sell only the places still free here. Changing this date's day or time here doesn't change the event there.`
                  : "This workshop is sold on Eventbrite too, but this date isn't linked to an event yet."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              {eventbriteState && (
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone={eventbriteState.tone}>{eventbriteState.label}</Badge>
                  {eventbrite?.status === "done" && eventbrite.eb_total !== null && (
                    <span className="text-muted-foreground">
                      {eventbrite.eb_sold ?? 0} sold there, {eventbrite.eb_total} for sale in all
                    </span>
                  )}
                </p>
              )}
              {eventbriteState?.detail && <p className="text-brick">{eventbriteState.detail}</p>}
              {manager && entitlements.canWrite && eventbriteState?.retry && eventbrite && (
                <RetryLinkForm slug={tenant.slug} listingId={eventbrite.id} />
              )}
              <Link href={`${base}/eventbrite`} className="w-fit underline">
                {manager ? "Link or change the event" : "See every date on Eventbrite"}
              </Link>
            </CardContent>
          </Card>
        )}

      {(waiting ?? []).length > 0 && (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>Waitlist</CardTitle>
            <CardDescription>
              They&apos;re emailed when someone cancels or moves to another date.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="font-read flex flex-col gap-1 text-sm">
              {(waiting ?? []).map((w) => (
                <li key={w.id}>
                  {w.customer_name} · {w.customer_email}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {manager && canWrite && (
        <div className="grid gap-6 lg:grid-cols-2 print:hidden">
          <Card>
            <CardHeader>
              <CardTitle>Add someone yourself</CardTitle>
              <CardDescription>
                For a phone booking, a guest or a gift. They aren&apos;t charged here.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AddPersonForm slug={tenant.slug} sessionId={session.id} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>This date</CardTitle>
            </CardHeader>
            <CardContent>
              <SessionSettingsForm
                slug={tenant.slug}
                sessionId={session.id}
                capacity={session.capacity}
                closed={session.bookings_closed}
                isPrivate={session.private}
                notes={session.notes}
              />
            </CardContent>
          </Card>

          {service.kind === "workshop" && upcoming && (groupId || candidates.length > 0) && (
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Shared places</CardTitle>
                <CardDescription>
                  {groupId
                    ? `Shares one room with ${sharing.map((s) => s.services?.name ?? "another class").join(", ") || "no other class"}. Bookings on any of them count towards the same number; each class still keeps its own limit too.`
                    : "Running another class at the same time in the same room? Share one number of places between them, so the two together can't take more than the room holds."}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {groupId && mine?.shared_capacity != null ? (
                  <>
                    <ul className="text-sm">
                      {sharing.map((s) => (
                        <li key={s.id}>
                          <Link href={`${base}/sessions/${s.id}`} className="underline">
                            {sharedDate(s).label}
                          </Link>{" "}
                          · {sharedDate(s).taken} of {s.capacity} booked
                        </li>
                      ))}
                    </ul>
                    <p className="text-sm font-semibold">{sharedWords(mine)}</p>
                    <SharedLimitForms
                      slug={tenant.slug}
                      groupId={groupId}
                      capacity={mine.shared_capacity}
                    />
                  </>
                ) : (
                  <ShareSeatsForm
                    slug={tenant.slug}
                    sessionId={session.id}
                    candidates={candidates.map(sharedDate)}
                    suggested={session.capacity}
                  />
                )}
              </CardContent>
            </Card>
          )}

          {service.kind === "workshop" && Boolean(shopWorkshops) && (
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Add an order from your shop</CardTitle>
                <CardDescription>
                  For someone who paid in your shop but isn&apos;t on a date: type the order number
                  and add them here. A refund in your shop will then free their place.{" "}
                  <Link href={`${base}/needs-date`} className="underline">
                    See orders waiting for a date
                  </Link>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AddShopOrderForm slug={tenant.slug} sessionId={session.id} />
              </CardContent>
            </Card>
          )}

          {coming.length > 0 && (
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Email everyone on this date</CardTitle>
                <CardDescription>A change of room, what to bring, where to park.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <EmailEveryoneForm
                  slug={tenant.slug}
                  sessionId={session.id}
                  count={
                    new Set(coming.filter((b) => b.email_opt_in).map((b) => b.customer_email)).size
                  }
                />
                {(sent ?? []).length > 0 && (
                  <div className="border-border border-t pt-3">
                    <p className="text-xs font-semibold">Already sent</p>
                    <ul className="text-muted-foreground mt-1 flex flex-col gap-1 text-sm">
                      {(sent ?? []).map((m) => (
                        <li key={m.id}>
                          <span className="text-foreground font-read">{m.subject}</span> · to{" "}
                          {m.recipients} ·{" "}
                          {new Intl.DateTimeFormat("en-US", {
                            timeZone: tenant.timezone,
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          }).format(new Date(m.created_at as string))}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {manager && canWrite && fit && (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>More people are booked than there are places</CardTitle>
            <CardDescription>
              {fit.capacity !== null
                ? `${taken} places are taken on a date set for ${session.capacity}. `
                : ""}
              {fit.shared !== null && mine?.shared_capacity != null
                ? `The shared room has ${mine.shared_taken} taken of ${mine.shared_capacity}. `
                : ""}
              If you can fit everyone in, raise the limit to match and they&apos;re no longer marked
              as over it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RaiseToFitForm
              slug={tenant.slug}
              sessionId={session.id}
              label={[
                fit.capacity !== null ? `Raise this date to ${fit.capacity}` : "",
                fit.shared !== null ? `the shared room to ${fit.shared}` : "",
              ]
                .filter(Boolean)
                .join(" and ")
                .replace(/^the/, "Raise the")}
            />
          </CardContent>
        </Card>
      )}

      {manager && canWrite && upcoming && service.kind === "workshop" && (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>Change the day or time</CardTitle>
            <CardDescription>
              Everyone booked keeps their place, and the date keeps its length.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MoveDateForm
              slug={tenant.slug}
              sessionId={session.id}
              day={startClock.day}
              time={`${String(Math.floor(startClock.minute / 60)).padStart(2, "0")}:${String(startClock.minute % 60).padStart(2, "0")}`}
              timezone={tenant.timezone}
              people={coming.length}
            />
          </CardContent>
        </Card>
      )}

      {manager && canWrite && service.kind === "workshop" && bookings.length === 0 && (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>Delete this date</CardTitle>
            <CardDescription>
              For a date added by mistake. Nobody has booked it, so nothing else changes. If someone
              has it in their cart, their order will show under Needs a date.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DeleteDateForm
              slug={tenant.slug}
              sessionId={session.id}
              serviceId={session.service_id as string}
            />
          </CardContent>
        </Card>
      )}

      {manager && canWrite && upcoming && (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>Cancel this date</CardTitle>
            <CardDescription>
              Everyone booked gets an email. Refunds aren&apos;t automatic: send those from your
              Stripe account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CancelSessionForm slug={tenant.slug} sessionId={session.id} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
