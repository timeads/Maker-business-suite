import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/lib/dashboard/format";
import { createClient } from "@/lib/supabase/server";
import { bookingsAccess } from "../gate";

export const metadata: Metadata = { title: "Booking customers" };

type Row = {
  customer_name: string;
  customer_email: string;
  seats: number;
  amount_cents: number;
  attendance: string | null;
  tags: string[];
  sessions: { starts_at: string; cancelled_at: string | null; services: { name: string } | null };
};

type Customer = {
  email: string;
  name: string;
  bookings: number;
  spent: number;
  noShows: number;
  tags: Set<string>;
  last: string;
  next: string | null;
  lastWhat: string;
};

export default async function BookingCustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/customers`);
  if (!access.ok) return access.upsell;
  const { tenant } = access;
  const q = ((await searchParams).q ?? "").trim().toLowerCase().slice(0, 80);

  const supabase = await createClient();
  const { data } = await supabase
    .from("bookings")
    .select(
      "customer_name, customer_email, seats, amount_cents, attendance, tags, sessions(starts_at, cancelled_at, services(name))",
    )
    .eq("tenant_id", tenant.id)
    .eq("status", "confirmed")
    .order("created_at", { ascending: false })
    .limit(3000);
  const now = new Date().toISOString();
  const people = new Map<string, Customer>();
  for (const row of (data ?? []) as unknown as Row[]) {
    if (row.sessions.cancelled_at) continue;
    const when = row.sessions.starts_at;
    const person = people.get(row.customer_email) ?? {
      email: row.customer_email,
      name: row.customer_name,
      bookings: 0,
      spent: 0,
      noShows: 0,
      tags: new Set<string>(),
      last: "",
      next: null,
      lastWhat: "",
    };
    person.bookings += 1;
    person.spent += row.amount_cents;
    if (row.attendance === "no_show") person.noShows += 1;
    for (const tag of row.tags ?? []) person.tags.add(tag);
    if (when > now) {
      if (!person.next || when < person.next) person.next = when;
    } else if (when > person.last) {
      person.last = when;
      person.lastWhat = row.sessions.services?.name ?? "";
    }
    people.set(row.customer_email, person);
  }
  const all = [...people.values()].sort(
    (a, b) => b.bookings - a.bookings || a.name.localeCompare(b.name),
  );
  const shown = q
    ? all.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.email.includes(q) ||
          [...p.tags].some((tag) => tag.includes(q)),
      )
    : all;
  const day = (instant: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tenant.timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(instant));

  return (
    <>
      <PageHeader
        title="Customers"
        description="Everyone who has booked with you, with the regulars at the top."
      />
      <form className="flex max-w-sm gap-2" role="search">
        <Input
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Search by name, email or tag"
          aria-label="Search customers"
        />
      </form>
      <Card>
        <CardContent className="pt-5">
          {shown.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {q
                ? "Nobody matches that search."
                : "Nobody has booked yet. They'll appear here after their first booking."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr>
                    <th className="py-2 pr-4 font-semibold">Customer</th>
                    <th className="py-2 pr-4 text-right font-semibold">Bookings</th>
                    <th className="py-2 pr-4 text-right font-semibold">Paid</th>
                    <th className="py-2 pr-4 font-semibold">Last came</th>
                    <th className="py-2 font-semibold">Coming next</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {shown.slice(0, 500).map((p) => (
                    <tr key={p.email} className="align-top">
                      <td className="py-2.5 pr-4">
                        <p className="font-read flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
                          {p.name}
                          {p.bookings >= 3 && <Badge tone="good">Regular</Badge>}
                          {p.noShows > 0 && (
                            <Badge tone="bad">
                              {p.noShows === 1 ? "1 no-show" : `${p.noShows} no-shows`}
                            </Badge>
                          )}
                          {[...p.tags].map((tag) => (
                            <Badge key={tag} tone="waiting">
                              {tag}
                            </Badge>
                          ))}
                        </p>
                        <a
                          href={`mailto:${p.email}`}
                          className="text-muted-foreground hover:underline"
                        >
                          {p.email}
                        </a>
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">{p.bookings}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">
                        {p.spent ? formatMoney(p.spent / 100, tenant.currency) : "–"}
                      </td>
                      <td className="py-2.5 pr-4">
                        {p.last ? (
                          <>
                            {day(p.last)}
                            <span className="text-muted-foreground block text-xs">
                              {p.lastWhat}
                            </span>
                          </>
                        ) : (
                          "–"
                        )}
                      </td>
                      <td className="py-2.5">{p.next ? day(p.next) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
