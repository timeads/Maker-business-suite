import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatWhen, isUpcoming } from "@/lib/bookings/slots";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { CancelSessionForm } from "../../forms";
import { bookingsAccess } from "../../gate";

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
    .select("id, starts_at, ends_at, capacity, cancelled_at, service_id, services(name)")
    .eq("id", id)
    .eq("tenant_id", tenant.id)
    .maybeSingle();
  if (!session) notFound();
  const [{ data: bookingRows }, { data: waiting }] = await Promise.all([
    supabase
      .from("bookings")
      .select("id, customer_name, customer_email, seats, status, oversold, answers, confirmed_at")
      .eq("session_id", id)
      .order("created_at"),
    supabase
      .from("waitlist")
      .select("id, customer_name, customer_email")
      .eq("session_id", id)
      .order("created_at"),
  ]);
  const bookings = (bookingRows ?? []) as BookingRow[];
  const coming = bookings.filter((b) => b.status === "confirmed");
  // After a date is called off, keep showing who had booked.
  const shown = session.cancelled_at ? bookings.filter((b) => b.confirmed_at) : coming;
  const taken = coming.reduce((sum, b) => sum + b.seats, 0);
  const serviceName = (session.services as unknown as { name: string } | null)?.name ?? "";
  const base = `/w/${tenant.slug}/bookings`;

  return (
    <>
      <header className="flex flex-col gap-2">
        <Link
          href={`${base}/services/${session.service_id}`}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← {serviceName}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {formatWhen(session.starts_at, session.ends_at, tenant.timezone)}
        </h1>
        <p className="text-muted-foreground text-sm">
          {session.cancelled_at
            ? "This date was cancelled."
            : `${taken} of ${session.capacity} places booked`}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{session.cancelled_at ? "Who had booked" : "Who's coming"}</CardTitle>
        </CardHeader>
        <CardContent>
          {shown.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nobody yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Email</th>
                    <th className="py-2 pr-4 font-medium">Places</th>
                    <th className="py-2 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {shown.map((b) => (
                    <tr key={b.id} className="align-top">
                      <td className="py-2 pr-4">{b.customer_name}</td>
                      <td className="py-2 pr-4">
                        <a href={`mailto:${b.customer_email}`} className="hover:underline">
                          {b.customer_email}
                        </a>
                      </td>
                      <td className="py-2 pr-4 tabular-nums">{b.seats}</td>
                      <td className="py-2">
                        {b.oversold && (
                          <p className="text-destructive">
                            Paid after this date filled, so it&apos;s over its limit.
                          </p>
                        )}
                        {Object.entries(b.answers ?? {}).map(([question, answer]) => (
                          <p key={question}>
                            <span className="text-muted-foreground">
                              {/[?:]$/.test(question) ? question : `${question}:`}
                            </span>{" "}
                            {answer}
                          </p>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {(waiting ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Waitlist</CardTitle>
            <CardDescription>
              They&apos;re emailed when someone cancels or moves to another date.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              {(waiting ?? []).map((w) => (
                <li key={w.id}>
                  {w.customer_name} · {w.customer_email}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {canManage(role) &&
        entitlements.canWrite &&
        !session.cancelled_at &&
        isUpcoming(session.starts_at) && (
          <Card>
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
