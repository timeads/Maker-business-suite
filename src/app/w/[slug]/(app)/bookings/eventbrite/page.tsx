import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatWhen } from "@/lib/bookings/slots";
import { getEventbriteAccess } from "@/lib/eventbrite/access";
import { createEventbriteClient, type EventbriteEvent } from "@/lib/eventbrite/client";
import { LISTING_COLUMNS, linkState, suggestEvent, type ListingRow } from "@/lib/eventbrite/events";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { LinkDateForm, RetryLinkForm, type EventChoice } from "../eventbrite-forms";
import { bookingsAccess } from "../gate";

export const metadata: Metadata = { title: "Eventbrite" };

type DateRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  cancelled_at: string | null;
  services: { name: string } | null;
};
/**
 * Bookings → Eventbrite: every coming date of the workshops sold on
 * Eventbrite, the event each is linked to, and how its places stand there.
 * The business's live events are read from Eventbrite for the picker (only
 * for an owner or admin, who can change the links).
 */
export default async function EventbritePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/eventbrite`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const base = `/w/${tenant.slug}/bookings`;
  const settings = `/w/${tenant.slug}/settings/bookings/eventbrite`;
  const header = (
    <PageHeader
      title="Eventbrite"
      description="Your workshop dates that are sold on Eventbrite too, and how their places stand there."
    />
  );
  if (!entitlements.can("eventbrite")) {
    return (
      <>
        {header}
        <p className="text-muted-foreground text-sm">
          Eventbrite isn&apos;t part of this workspace&apos;s plan right now.
        </p>
      </>
    );
  }
  const manager = canManage(role) && entitlements.canWrite;

  const supabase = await createClient();
  const [{ data: connection }, { data: services }] = await Promise.all([
    supabase
      .from("connections")
      .select("status")
      .eq("tenant_id", tenant.id)
      .eq("provider", "eventbrite")
      .maybeSingle(),
    supabase
      .from("services")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("kind", "workshop")
      .eq("eventbrite_on", true),
  ]);
  const connected = connection?.status === "active";
  const serviceIds = ((services ?? []) as { id: string }[]).map((s) => s.id);
  const [{ data: dateRows }, { data: listingRows }] = await Promise.all([
    serviceIds.length > 0
      ? supabase
          .from("sessions")
          .select("id, starts_at, ends_at, cancelled_at, services(name)")
          .eq("tenant_id", tenant.id)
          .in("service_id", serviceIds)
          .gte("starts_at", new Date().toISOString())
          .order("starts_at")
          .limit(100)
      : Promise.resolve({ data: [] }),
    supabase.from("eventbrite_listings").select(LISTING_COLUMNS).eq("tenant_id", tenant.id),
  ]);
  const dates = (dateRows ?? []) as unknown as DateRow[];
  const listings = new Map(
    ((listingRows ?? []) as ListingRow[]).map((row) => [row.session_id, row]),
  );

  // The business's events, for the picker. Allowed to fail: the statuses still show.
  let events: EventbriteEvent[] = [];
  let eventsError = false;
  if (manager && connected && dates.length > 0) {
    try {
      const eb = await getEventbriteAccess(tenant.id);
      events = eb.organizationId
        ? await createEventbriteClient(eb).listEvents(eb.organizationId)
        : [];
    } catch {
      eventsError = true;
    }
  }
  const taken = new Set([...listings.values()].map((l) => l.event_id));
  const startFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const choices: EventChoice[] = events.map((e) => ({
    id: e.id,
    label: `${e.name}${e.startUtc ? ` · ${startFormat.format(new Date(e.startUtc))}` : ""}`,
    tickets: e.ticketClasses,
  }));

  return (
    <>
      {header}
      {!connected && (
        <p className="text-muted-foreground text-sm">
          Eventbrite isn&apos;t connected. Set it up in{" "}
          <Link href={settings} className="underline">
            Settings → Bookings → Eventbrite
          </Link>
          .
        </p>
      )}
      {eventsError && (
        <p className="text-brick text-sm">
          We couldn&apos;t read your events from Eventbrite just now, so dates can&apos;t be linked.
          Try again in a moment.
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Coming dates</CardTitle>
          <CardDescription>
            Link each date to the event that sells it on Eventbrite. From then on Eventbrite can
            sell only the places still free here, whoever booked them, and its orders join the
            date&apos;s list. Changing a date&apos;s day or time here doesn&apos;t change the event
            on Eventbrite.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {serviceIds.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No workshop is switched on for Eventbrite yet. Tick them in{" "}
              <Link href={settings} className="underline">
                Settings
              </Link>
              .
            </p>
          ) : dates.length === 0 ? (
            <p className="text-muted-foreground text-sm">No dates coming up.</p>
          ) : (
            <ul className="divide-border flex flex-col divide-y">
              {dates.map((d) => {
                const listing = listings.get(d.id) ?? null;
                const state = listing ? linkState(listing) : null;
                const suggested = listing ? null : suggestEvent(d.starts_at, events, taken);
                return (
                  <li key={d.id} className="flex flex-col gap-2 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`${base}/sessions/${d.id}`} className="font-semibold underline">
                        {d.services?.name ?? "Workshop"},{" "}
                        {formatWhen(d.starts_at, d.ends_at, tenant.timezone)}
                      </Link>
                      {d.cancelled_at && <Badge>Cancelled</Badge>}
                      {state ? (
                        <Badge tone={state.tone}>{state.label}</Badge>
                      ) : (
                        <Badge tone="closed">Not linked</Badge>
                      )}
                    </div>
                    {listing && (
                      <p className="text-muted-foreground text-sm">
                        {listing.event_name || `Event ${listing.event_id}`}
                        {listing.status === "done" && listing.eb_total !== null
                          ? ` · ${listing.eb_sold ?? 0} sold there, ${listing.eb_total} for sale in all${listing.eb_hidden ? " (hidden)" : ""}`
                          : ""}
                      </p>
                    )}
                    {state?.detail && <p className="text-brick text-sm">{state.detail}</p>}
                    {manager && state?.retry && listing && (
                      <RetryLinkForm slug={tenant.slug} listingId={listing.id} />
                    )}
                    {manager && connected && !eventsError && (
                      <LinkDateForm
                        slug={tenant.slug}
                        sessionId={d.id}
                        events={choices}
                        current={
                          listing
                            ? {
                                eventId: listing.event_id,
                                eventName: listing.event_name,
                                ticketId: listing.ticket_class_id,
                              }
                            : null
                        }
                        suggested={suggested?.id ?? null}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
