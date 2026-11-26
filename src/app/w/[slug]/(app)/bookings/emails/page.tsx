import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import {
  KIND_NAMES,
  LOG_KINDS,
  LOG_STATES,
  STATE_NAMES,
  STATE_TONES,
  logHref,
  logState,
  parseLogFilters,
  statusesFor,
  type LogKind,
  type LogRow,
} from "@/lib/bookings/email-log";
import { formatWhen, isUpcoming } from "@/lib/bookings/slots";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { bookingsAccess } from "../gate";
import { ResendButton } from "../resend-button";

export const metadata: Metadata = { title: "Emails sent" };

type Row = LogRow & {
  id: string;
  kind: LogKind;
  tries: number;
  detail: string;
  created_at: string;
  finished_at: string | null;
  booking_id: string;
  session_id: string;
  bookings: { customer_name: string; customer_email: string; status: string } | null;
  sessions: {
    starts_at: string;
    ends_at: string;
    cancelled_at: string | null;
    services: { name: string } | null;
  } | null;
};

/**
 * Every email that went out by itself (reminders, day-of reminders,
 * thank-yous, shop-refund notices), read from the once-only record: when,
 * to whom, about which date, and how it went, with the mail service's words
 * beside any that didn't go. Filters live in the address.
 */
export default async function BookingEmailLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/emails`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const filters = parseLogFilters(await searchParams);
  const base = `/w/${tenant.slug}/bookings/emails`;
  const manager = canManage(role) && entitlements.canWrite;

  const supabase = await createClient();
  let query = supabase
    .from("booking_emails")
    .select(
      "id, kind, status, tries, detail, next_try_at, created_at, finished_at, booking_id, session_id, bookings(customer_name, customer_email, status), sessions(starts_at, ends_at, cancelled_at, services(name))",
    )
    .eq("tenant_id", tenant.id)
    .order("created_at", { ascending: false })
    .limit(filters.q ? 1000 : 200);
  if (filters.kind) query = query.eq("kind", filters.kind);
  if (filters.state) {
    query = query.in("status", statusesFor(filters.state));
    if (filters.state === "trying") query = query.not("next_try_at", "is", null);
    if (filters.state === "failed") query = query.is("next_try_at", null);
  }
  const { data, error } = await query;
  const rows = ((data ?? []) as unknown as Row[]).filter(
    (row) =>
      !filters.q ||
      row.bookings?.customer_name.toLowerCase().includes(filters.q) ||
      row.bookings?.customer_email.toLowerCase().includes(filters.q),
  );
  const at = (instant: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tenant.timezone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(instant));

  const chip = (href: string, on: boolean, label: string) => (
    <Link
      key={label}
      href={href}
      aria-current={on ? "true" : undefined}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-semibold transition-colors duration-150",
        on ? "border-teal bg-teal text-on-teal" : "border-input bg-card hover:bg-hover",
      )}
    >
      {label}
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Emails sent"
        description="Reminders, thank-yous and the other emails that go out by themselves, and how each one went."
      />
      <div className="flex flex-col gap-3">
        <form className="flex max-w-sm gap-2" role="search">
          {filters.kind && <input type="hidden" name="kind" value={filters.kind} />}
          {filters.state && <input type="hidden" name="state" value={filters.state} />}
          <Input
            name="q"
            type="search"
            defaultValue={filters.q}
            placeholder="Search by name or email"
            aria-label="Search emails"
          />
        </form>
        <nav aria-label="Which emails" className="flex flex-wrap gap-1.5">
          {chip(logHref(base, filters, { kind: null }), !filters.kind, "Every kind")}
          {LOG_KINDS.map((kind) =>
            chip(logHref(base, filters, { kind }), filters.kind === kind, KIND_NAMES[kind]),
          )}
        </nav>
        <nav aria-label="How they went" className="flex flex-wrap gap-1.5">
          {chip(logHref(base, filters, { state: null }), !filters.state, "However it went")}
          {LOG_STATES.map((state) =>
            chip(logHref(base, filters, { state }), filters.state === state, STATE_NAMES[state]),
          )}
        </nav>
      </div>
      <Card>
        <CardContent className="pt-5">
          {error ? (
            <p className="text-muted-foreground text-sm">
              The list couldn&apos;t be read just now. Try again in a minute.
            </p>
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {filters.kind || filters.state || filters.q
                ? "No emails match those filters."
                : "Nothing has gone out by itself yet. Reminders appear here as they're sent."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr>
                    <th className="py-2 pr-4 font-semibold">When</th>
                    <th className="py-2 pr-4 font-semibold">Email</th>
                    <th className="py-2 pr-4 font-semibold">To</th>
                    <th className="py-2 pr-4 font-semibold">About</th>
                    <th className="py-2 font-semibold">How it went</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {rows.map((row) => {
                    const state = logState(row);
                    const session = row.sessions;
                    const upcoming =
                      session && !session.cancelled_at && isUpcoming(session.starts_at);
                    const canResend =
                      manager &&
                      (state === "failed" || state === "unsure") &&
                      upcoming &&
                      row.bookings?.status === "confirmed";
                    return (
                      <tr key={row.id} className="align-top">
                        <td className="py-2.5 pr-4 whitespace-nowrap">
                          {at(row.finished_at ?? row.created_at)}
                        </td>
                        <td className="py-2.5 pr-4">{KIND_NAMES[row.kind]}</td>
                        <td className="py-2.5 pr-4">
                          <p className="font-read font-semibold">
                            {row.bookings?.customer_name ?? "—"}
                          </p>
                          <p className="text-muted-foreground font-read">
                            {row.bookings?.customer_email}
                          </p>
                        </td>
                        <td className="py-2.5 pr-4">
                          {session ? (
                            <Link
                              href={`/w/${tenant.slug}/bookings/sessions/${row.session_id}`}
                              className="hover:underline"
                            >
                              {session.services?.name ?? "A date"}
                              <span className="text-muted-foreground block text-xs">
                                {formatWhen(session.starts_at, session.ends_at, tenant.timezone)}
                              </span>
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-2.5">
                          <div className="flex flex-col items-start gap-1.5">
                            <Badge tone={STATE_TONES[state]}>{STATE_NAMES[state]}</Badge>
                            {state !== "sent" && row.detail && (
                              <p className="text-muted-foreground max-w-xs text-xs">{row.detail}</p>
                            )}
                            {row.tries > 1 && (
                              <p className="text-muted-foreground text-xs">
                                Tried {row.tries} times
                              </p>
                            )}
                            {canResend && (
                              <ResendButton slug={tenant.slug} bookingId={row.booking_id} />
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-muted-foreground mt-4 text-xs">
            Confirmations and the emails you send by hand (moving, cancelling, a note to everyone)
            go straight away and aren&apos;t listed here; a person&apos;s own page has &ldquo;Send
            the confirmation again&rdquo;.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
