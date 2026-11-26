import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeading } from "@/components/settings/section-heading";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { EventbriteWorkshopsForm, OrderUpdatesForm } from "../../../bookings/eventbrite-forms";
import { bookingsAccess } from "../../../bookings/gate";

export const metadata: Metadata = { title: "Eventbrite" };

/**
 * Settings → Bookings → Eventbrite: the connection, order updates, and which
 * workshops may be sold on Eventbrite too. Linking each date to its event is
 * work, so it lives in Bookings → Eventbrite.
 */
export default async function EventbriteSettings({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/settings/bookings/eventbrite`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const heading = (
    <SectionHeading
      back={{ href: `/w/${tenant.slug}/bookings/eventbrite`, label: "Bookings" }}
      title="Eventbrite"
      description="Sell your workshop dates on Eventbrite as well. Places are kept in step both ways, and Eventbrite orders arrive here as bookings."
    />
  );
  if (!entitlements.can("eventbrite")) {
    return (
      <>
        {heading}
        <p className="text-muted-foreground text-sm">
          Eventbrite isn&apos;t part of this workspace&apos;s plan right now.
        </p>
      </>
    );
  }
  const canEdit = canManage(role) && entitlements.canWrite;

  const supabase = await createClient();
  const [{ data: connection }, { data: updates }, { data: services }] = await Promise.all([
    // Name the columns: members can't read the whole row.
    supabase
      .from("connections")
      .select("status, display_name")
      .eq("tenant_id", tenant.id)
      .eq("provider", "eventbrite")
      .maybeSingle(),
    supabase.rpc("eventbrite_order_updates", { p_tenant_id: tenant.id }),
    supabase
      .from("services")
      .select("id, name, eventbrite_on")
      .eq("tenant_id", tenant.id)
      .eq("kind", "workshop")
      .eq("active", true)
      .order("name"),
  ]);
  const connected = connection?.status === "active";
  const since = ((updates ?? []) as { registered_at: string }[])[0]?.registered_at ?? null;
  const workshops = (
    (services ?? []) as { id: string; name: string; eventbrite_on: boolean }[]
  ).map((s) => ({ id: s.id, name: s.name, on: s.eventbrite_on }));
  const when = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: tenant.timezone }).format(
      new Date(iso),
    );

  return (
    <>
      {heading}
      <Card>
        <CardHeader>
          <CardTitle>Your Eventbrite account</CardTitle>
          <CardDescription>
            Make your events on Eventbrite as you always have. Here you tell us which date each one
            is, and we look after the number of places.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {connected ? (
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone="good">Connected</Badge>
              {connection?.display_name ? `To ${connection.display_name}.` : "Connected."}
            </p>
          ) : (
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone="waiting">Not connected</Badge>
              <span>
                Connect Eventbrite under{" "}
                <Link href={`/w/${tenant.slug}/connections`} className="underline">
                  Connections
                </Link>{" "}
                with your private token. Until then nothing is sent to Eventbrite and no orders
                arrive.
              </span>
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Order updates</CardTitle>
          <CardDescription>
            Eventbrite tells us when someone orders, asks for a refund or cancels a ticket, and we
            read the order from Eventbrite to put them on the date.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            {since ? (
              <>
                <Badge tone="good">On</Badge> Since {when(since)}.
              </>
            ) : (
              <>
                <Badge tone="waiting">Off</Badge> Orders on Eventbrite don&apos;t reach your
                bookings yet.
              </>
            )}
          </p>
          <p className="text-muted-foreground">
            Eventbrite doesn&apos;t sign what it sends, so the address we give it carries a secret
            of yours, and we only ever take the order&apos;s number from it: the order itself is
            always read from Eventbrite.
          </p>
          {canEdit && connected && <OrderUpdatesForm slug={tenant.slug} on={Boolean(since)} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workshops on Eventbrite</CardTitle>
          <CardDescription>
            Tick the workshops you also sell on Eventbrite. Only their dates can be linked to an
            event, and nothing is sent to Eventbrite for the others. Then link each date under{" "}
            <Link href={`/w/${tenant.slug}/bookings/eventbrite`} className="underline">
              Bookings → Eventbrite
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {workshops.length === 0 ? (
            <p className="text-muted-foreground text-sm">No workshops yet.</p>
          ) : canEdit ? (
            <EventbriteWorkshopsForm slug={tenant.slug} workshops={workshops} />
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {workshops.map((w) => (
                <li key={w.id} className="flex items-center gap-2">
                  {w.name}
                  <Badge tone={w.on ? "good" : "closed"}>{w.on ? "On Eventbrite" : "Off"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
