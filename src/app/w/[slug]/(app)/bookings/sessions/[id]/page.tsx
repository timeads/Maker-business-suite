import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatWhen, isUpcoming } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/dashboard/format";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
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

export const metadata: Metadata = { title: "Who's coming" };

type BookingRow = {
  id: string;
  customer_name: string;
  customer_email: string;
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
  source: "online" | "manual";
  email_opt_in: boolean;
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
      "id, starts_at, ends_at, capacity, cancelled_at, bookings_closed, private, notes, service_id, services(name, kind)",
    )
    .eq("id", id)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!session) notFound();
  const service = session.services as unknown as { name: string; kind: string };
  const [{ data: bookingRows }, { data: waiting }, { data: siblings }, { data: sent }] =
    await Promise.all([
      supabase
        .from("bookings")
        .select(
          "id, customer_name, customer_email, seats, status, oversold, answers, confirmed_at, amount_cents, currency, attendance, notes, tags, source, email_opt_in",
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
    ]);
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

  const people: RosterPerson[] = shown.map((b) => ({
    id: b.id,
    name: b.customer_name,
    email: b.customer_email,
    seats: b.seats,
    attendance: b.attendance,
    notes: b.notes,
    tags: b.tags ?? [],
    manual: b.source === "manual",
    oversold: b.oversold,
    emails: b.email_opt_in,
    paid: b.amount_cents > 0 ? formatMoney(b.amount_cents / 100, b.currency) : null,
    answers: Object.entries(b.answers ?? {}),
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
            {service.name} ·{" "}
            {live
              ? `${taken} of ${session.capacity} places booked${here ? ` · ${here} checked in` : ""}`
              : "This date was cancelled."}
          </>
        }
      >
        {session.private && <Badge tone="waiting">Private</Badge>}
        {live && session.bookings_closed && <Badge>Not taking bookings</Badge>}
        {live && taken > session.capacity && <Badge tone="bad">Over its limit</Badge>}
        {shown.length > 0 && (
          <>
            <PrintButton />
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
