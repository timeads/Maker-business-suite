import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatWhen } from "@/lib/bookings/slots";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { AddSessionForm, AvailabilityForm, ServiceForm, type ServiceValues } from "../../forms";
import { bookingsAccess } from "../../gate";

export const metadata: Metadata = { title: "Bookings" };

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export default async function ServicePage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/services/${id}`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createClient();
  const { data } = await supabase
    .from("services")
    .select("id, kind, name, description, duration_minutes, price_cents, capacity, active")
    .eq("id", id)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  const service = data as ServiceValues | null;
  if (!service) notFound();

  const [{ data: sessions }, { data: rules }] = await Promise.all([
    supabase
      .from("sessions")
      .select("id, starts_at, ends_at, capacity, private, bookings_closed, bookings(seats, status)")
      .eq("service_id", service.id)
      .is("cancelled_at", null)
      .gte("starts_at", new Date().toISOString())
      .order("starts_at"),
    supabase
      .from("availability_rules")
      .select("weekday, start_minute, end_minute")
      .eq("service_id", service.id),
  ]);
  const hours: Record<number, [string, string]> = {};
  for (const rule of rules ?? []) {
    hours[rule.weekday as number] = [clock(rule.start_minute), clock(rule.end_minute)];
  }
  const base = `/w/${tenant.slug}/bookings`;

  return (
    <>
      <PageHeader
        back={{ href: base, label: "Bookings" }}
        title={service.name}
        description={
          service.kind === "workshop"
            ? "A workshop: set dates, several places on each."
            : "An appointment: one person at a time, from your open hours."
        }
      >
        {!service.active && <Badge>Hidden from your booking page</Badge>}
      </PageHeader>

      {service.kind === "workshop" ? (
        <Card>
          <CardHeader>
            <CardTitle>Dates</CardTitle>
            <CardDescription>Each date can be booked until its places run out.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {(sessions ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">No dates scheduled yet.</p>
            ) : (
              <ul className="divide-border flex flex-col divide-y">
                {(sessions ?? []).map((s) => (
                  <li key={s.id}>
                    <Link
                      href={`${base}/sessions/${s.id}`}
                      className="hover:bg-hover -mx-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm px-2 py-2 text-sm"
                    >
                      <span className="flex-1">
                        {formatWhen(s.starts_at, s.ends_at, tenant.timezone)}
                      </span>
                      {s.private && <Badge tone="waiting">Private</Badge>}
                      {s.bookings_closed && <Badge>Not taking bookings</Badge>}
                      <span className="text-muted-foreground tabular-nums">
                        {(s.bookings as { seats: number; status: string }[])
                          .filter((b) => b.status === "confirmed")
                          .reduce((n, b) => n + b.seats, 0)}{" "}
                        of {s.capacity} booked
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <AddSessionForm
                slug={tenant.slug}
                serviceId={service.id}
                capacity={service.capacity}
                timezone={tenant.timezone}
              />
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Open hours</CardTitle>
            <CardDescription>
              People can book any free time inside these hours, one after another, up to four weeks
              ahead. A time booked for one kind of appointment is taken for all of them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canEdit ? (
              <AvailabilityForm slug={tenant.slug} serviceId={service.id} hours={hours} />
            ) : (
              <p className="text-muted-foreground text-sm">
                An owner or admin can change the open hours.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <ServiceForm slug={tenant.slug} service={service} currency={tenant.currency} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
