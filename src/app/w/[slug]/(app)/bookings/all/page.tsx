import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import {
  BOOKING_STATUSES,
  PAGE_SIZE,
  SOURCES,
  SOURCE_NAMES,
  STATUS_NAMES,
  WHENS,
  WHEN_NAMES,
  bookingsHref,
  parseBookingFilters,
  searchFilter,
  sourceOf,
  type BookingStatus,
} from "@/lib/bookings/all-bookings";
import { loadReturning } from "@/lib/bookings/runsheet-data";
import { formatWhen } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/dashboard/format";
import { shopLinks } from "@/lib/helpdesk/customer";
import { createClient } from "@/lib/supabase/server";
import { bookingsAccess } from "../gate";

export const metadata: Metadata = { title: "All bookings" };

type Row = {
  id: string;
  created_at: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  seats: number;
  status: BookingStatus;
  amount_cents: number;
  currency: string;
  source: string;
  oversold: boolean;
  shop_order_id: string | null;
  shop_order_name: string | null;
  session_id: string;
  sessions: {
    starts_at: string;
    ends_at: string;
    service_id: string;
    services: { name: string } | null;
  };
};

const STATUS_TONES: Record<BookingStatus, "good" | "closed" | "waiting"> = {
  confirmed: "good",
  cancelled: "closed",
  pending_payment: "waiting",
};

/**
 * Every booking in one list, searched by name, email or order number and
 * narrowed by workshop, status, when and where it came from. Everything the
 * list shows is in its address.
 */
export default async function AllBookingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/all`);
  if (!access.ok) return access.upsell;
  const { tenant } = access;
  const filters = parseBookingFilters(await searchParams);
  const base = `/w/${tenant.slug}/bookings`;
  const here = `${base}/all`;
  const now = new Date().toISOString();

  const supabase = await createClient();
  let query = supabase
    .from("bookings")
    .select(
      "id, created_at, customer_name, customer_email, customer_phone, seats, status, amount_cents, currency, source, oversold, shop_order_id, shop_order_name, session_id, sessions!inner(starts_at, ends_at, service_id, services(name))",
      { count: "exact" },
    )
    .eq("tenant_id", tenant.id);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.service) query = query.eq("sessions.service_id", filters.service);
  if (filters.when === "upcoming") query = query.gte("sessions.starts_at", now);
  if (filters.when === "past") query = query.lt("sessions.starts_at", now);
  if (filters.source === "shop") query = query.not("shop_order_id", "is", null);
  if (filters.source === "online") query = query.eq("source", "online").is("shop_order_id", null);
  if (filters.source === "manual") query = query.eq("source", "manual");
  const search = searchFilter(filters.q);
  if (search) query = query.or(search);
  const first = (filters.page - 1) * PAGE_SIZE;
  const [{ data, count, error }, { data: services }, { data: shop }] = await Promise.all([
    query
      // Ordered by the date itself (a to-one join), soonest first for what's to come.
      .order("sessions(starts_at)", { ascending: filters.when === "upcoming" })
      .order("created_at", { ascending: false })
      .range(first, first + PAGE_SIZE - 1),
    supabase
      .from("services")
      .select("id, name")
      .eq("tenant_id", tenant.id)
      .order("name")
      .limit(200),
    supabase
      .from("connections")
      .select("provider, external_account_id")
      .eq("tenant_id", tenant.id)
      .eq("provider", "shopify")
      .maybeSingle(),
  ]);
  const rows = (data ?? []) as unknown as Row[];
  const returning = await loadReturning(
    supabase,
    tenant.id,
    rows
      .filter((r) => r.status === "confirmed")
      .map((r) => ({ id: r.id, email: r.customer_email, starts_at: r.sessions.starts_at })),
  );
  const total = count ?? rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const shopAccount = shop as { provider: string; external_account_id: string | null } | null;
  const booked = (instant: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tenant.timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(instant));
  const filtered =
    filters.q || filters.status || filters.source || filters.service || filters.when !== "upcoming";

  return (
    <>
      <PageHeader
        title="All bookings"
        description="Every booking in one place. Search by name, email or order number."
      />
      <form className="flex flex-wrap items-end gap-3" role="search">
        <div className="flex min-w-48 flex-1 flex-col gap-1 sm:max-w-xs">
          <Label htmlFor="all-q">Search</Label>
          <Input
            id="all-q"
            name="q"
            type="search"
            defaultValue={filters.q}
            placeholder="Name, email or order number"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="all-service">Workshop</Label>
          <Select
            id="all-service"
            name="service"
            defaultValue={filters.service ?? ""}
            className="w-48"
          >
            <option value="">Every workshop</option>
            {((services ?? []) as { id: string; name: string }[]).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="all-when">When</Label>
          <Select id="all-when" name="when" defaultValue={filters.when} className="w-40">
            {WHENS.map((w) => (
              <option key={w} value={w}>
                {WHEN_NAMES[w]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="all-status">Status</Label>
          <Select
            id="all-status"
            name="status"
            defaultValue={filters.status ?? ""}
            className="w-44"
          >
            <option value="">Any status</option>
            {BOOKING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_NAMES[s]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="all-source">Came from</Label>
          <Select
            id="all-source"
            name="source"
            defaultValue={filters.source ?? ""}
            className="w-40"
          >
            <option value="">Anywhere</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_NAMES[s]}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline">
          Show
        </Button>
        {filtered && (
          <Button asChild variant="ghost">
            <Link href={here}>Clear</Link>
          </Button>
        )}
      </form>
      <Card>
        <CardContent className="pt-5">
          {error ? (
            <p className="text-muted-foreground text-sm">
              The list couldn&apos;t be read just now. Try again in a minute.
            </p>
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {filtered ? "No bookings match that." : "Nobody has booked a date that's coming up."}
            </p>
          ) : (
            <>
              <p className="text-muted-foreground mb-3 text-xs">
                {total === 1 ? "1 booking" : `${total.toLocaleString("en-US")} bookings`}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead className="text-muted-foreground text-xs">
                    <tr>
                      <th className="py-2 pr-4 font-semibold">Who</th>
                      <th className="py-2 pr-4 font-semibold">Phone</th>
                      <th className="py-2 pr-4 font-semibold">Workshop and date</th>
                      <th className="py-2 pr-4 text-right font-semibold">Places</th>
                      <th className="py-2 pr-4 text-right font-semibold">Paid</th>
                      <th className="py-2 pr-4 font-semibold">Status</th>
                      <th className="py-2 font-semibold">Came from</th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {rows.map((row) => {
                      const source = sourceOf(row);
                      const order = row.shop_order_id
                        ? shopLinks(
                            shopAccount?.provider ?? null,
                            shopAccount?.external_account_id ?? null,
                            { order: row.shop_order_id },
                          ).order
                        : null;
                      return (
                        <tr key={row.id} className="align-top">
                          <td className="py-2.5 pr-4">
                            <p className="font-read flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
                              {row.customer_name}
                              {returning.has(row.id) && <Badge tone="good">Returning</Badge>}
                              {row.oversold && row.status === "confirmed" && (
                                <Badge tone="bad">Over the limit</Badge>
                              )}
                            </p>
                            <a
                              href={`mailto:${row.customer_email}`}
                              className="text-muted-foreground font-read hover:underline"
                            >
                              {row.customer_email}
                            </a>
                          </td>
                          <td className="font-read py-2.5 pr-4 whitespace-nowrap">
                            {row.customer_phone ? (
                              <a
                                href={`tel:${row.customer_phone.replace(/[^0-9+]/g, "")}`}
                                className="hover:underline"
                              >
                                {row.customer_phone}
                              </a>
                            ) : (
                              "–"
                            )}
                          </td>
                          <td className="py-2.5 pr-4">
                            <Link
                              href={`${base}/sessions/${row.session_id}`}
                              className="hover:underline"
                            >
                              {row.sessions.services?.name ?? "A date"}
                              <span className="text-muted-foreground block text-xs">
                                {formatWhen(
                                  row.sessions.starts_at,
                                  row.sessions.ends_at,
                                  tenant.timezone,
                                )}
                              </span>
                            </Link>
                          </td>
                          <td className="py-2.5 pr-4 text-right tabular-nums">{row.seats}</td>
                          <td className="py-2.5 pr-4 text-right tabular-nums">
                            {row.amount_cents > 0
                              ? formatMoney(row.amount_cents / 100, row.currency)
                              : "–"}
                          </td>
                          <td className="py-2.5 pr-4">
                            <Badge tone={STATUS_TONES[row.status]}>
                              {STATUS_NAMES[row.status]}
                            </Badge>
                          </td>
                          <td className="py-2.5">
                            {SOURCE_NAMES[source]}
                            {row.shop_order_id && (
                              <span className="block text-xs">
                                {order ? (
                                  <a
                                    href={order}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-ochre-text hover:underline"
                                  >
                                    Order {row.shop_order_name || ""} in your shop
                                  </a>
                                ) : (
                                  <span className="text-muted-foreground">
                                    Order {row.shop_order_name}
                                  </span>
                                )}
                              </span>
                            )}
                            <span className="text-muted-foreground block text-xs">
                              {booked(row.created_at)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {pages > 1 && (
                <nav aria-label="Pages" className="mt-4 flex items-center gap-2 text-sm">
                  {filters.page > 1 && (
                    <Button asChild variant="outline" size="sm">
                      <Link href={bookingsHref(here, filters, { page: filters.page - 1 })}>
                        Newer
                      </Link>
                    </Button>
                  )}
                  <span className="text-muted-foreground">
                    Page {filters.page} of {pages}
                  </span>
                  {filters.page < pages && (
                    <Button asChild variant="outline" size="sm">
                      <Link href={bookingsHref(here, filters, { page: filters.page + 1 })}>
                        More
                      </Link>
                    </Button>
                  )}
                </nav>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
