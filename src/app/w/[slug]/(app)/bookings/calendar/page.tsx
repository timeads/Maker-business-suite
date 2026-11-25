import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import {
  formatDay,
  formatMonth,
  formatTime,
  localDay,
  monthGrid,
  zonedTimeToUtc,
} from "@/lib/bookings/slots";
import { createClient } from "@/lib/supabase/server";
import { loadSeatFigures } from "@/lib/bookings/seats";
import { cn } from "@/lib/utils";
import { bookingsAccess } from "../gate";

export const metadata: Metadata = { title: "Bookings calendar" };

type Row = {
  id: string;
  starts_at: string;
  capacity: number;
  private: boolean;
  cancelled_at: string | null;
  services: { name: string } | null;
  bookings: { seats: number; status: string }[];
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function BookingsCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/calendar`);
  if (!access.ok) return access.upsell;
  const { tenant } = access;
  const today = localDay(new Date(), tenant.timezone);
  const asked = (await searchParams).month ?? "";
  const month = /^20\d{2}-(0[1-9]|1[0-2])$/.test(asked) ? asked : today.slice(0, 7);
  const grid = monthGrid(month);
  const first = grid.days[0][0];
  const last = grid.days.at(-1)![6];
  // A day either side covers every timezone's edge of the grid.
  const from = zonedTimeToUtc(first, 0, tenant.timezone) ?? new Date(`${first}T00:00:00Z`);
  const to = new Date(
    (zonedTimeToUtc(last, 0, tenant.timezone) ?? new Date(`${last}T00:00:00Z`)).getTime() +
      2 * 86_400_000,
  );

  const supabase = await createClient();
  const { data } = await supabase
    .from("sessions")
    .select(
      "id, starts_at, capacity, private, cancelled_at, services(name), bookings(seats, status)",
    )
    .eq("tenant_id", tenant.id)
    .gte("starts_at", from.toISOString())
    .lt("starts_at", to.toISOString())
    .order("starts_at")
    .limit(600);
  const byDay = new Map<string, Row[]>();
  for (const row of (data ?? []) as unknown as Row[]) {
    const taken = row.bookings
      .filter((b) => b.status === "confirmed")
      .reduce((n, b) => n + b.seats, 0);
    // An appointment slot only matters once someone has it; a called-off date drops away.
    if (row.cancelled_at || (row.capacity === 1 && taken === 0)) continue;
    const day = localDay(new Date(row.starts_at), tenant.timezone);
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }
  const figures = await loadSeatFigures(
    supabase,
    [...byDay.values()].flat().map((row) => row.id),
  );
  const base = `/w/${tenant.slug}/bookings`;
  const taken = (row: Row) =>
    row.bookings.filter((b) => b.status === "confirmed").reduce((n, b) => n + b.seats, 0);
  const chip = (row: Row) => (
    <Link
      key={row.id}
      href={`${base}/sessions/${row.id}`}
      className={cn(
        "block rounded-[5px] px-1.5 py-1 text-xs leading-tight transition-colors duration-150",
        row.private
          ? "bg-ochre-soft text-ochre-text hover:brightness-95"
          : "bg-teal-soft text-teal-soft-ink hover:brightness-95",
      )}
    >
      <span className="tabular-nums">{formatTime(row.starts_at, tenant.timezone)}</span>{" "}
      <span className="font-semibold">{row.services?.name}</span>
      <span className="block tabular-nums opacity-80">
        {taken(row)} of {row.capacity}
        {row.private && " · private"}
        {figures.get(row.id)?.seat_group_id &&
          ` · room ${figures.get(row.id)?.shared_taken} of ${figures.get(row.id)?.shared_capacity}`}
      </span>
    </Link>
  );
  const busyDays = grid.days.flat().filter((day) => day.startsWith(month) && byDay.has(day));

  return (
    <>
      <PageHeader title="Calendar" description="Everything on your calendar, month by month.">
        <Button asChild variant="outline" size="sm" aria-label="Earlier month">
          <Link href={`${base}/calendar?month=${grid.previous}`}>
            <ChevronLeft />
          </Link>
        </Button>
        <span className="min-w-36 text-center text-sm font-semibold">{formatMonth(month)}</span>
        <Button asChild variant="outline" size="sm" aria-label="Later month">
          <Link href={`${base}/calendar?month=${grid.next}`}>
            <ChevronRight />
          </Link>
        </Button>
      </PageHeader>

      {/* Phones get the month as a list of its busy days. */}
      <div className="flex flex-col gap-4 md:hidden">
        {busyDays.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing booked in {formatMonth(month)}.</p>
        ) : (
          busyDays.map((day) => (
            <section key={day}>
              <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                {formatDay(day)}
              </h2>
              <div className="mt-1 flex flex-col gap-1">{byDay.get(day)!.map(chip)}</div>
            </section>
          ))
        )}
      </div>

      <div className="bg-card border-border hidden overflow-hidden rounded-lg border md:block">
        <div className="border-border text-muted-foreground grid grid-cols-7 border-b text-xs font-semibold">
          {WEEKDAYS.map((name) => (
            <div key={name} className="px-2 py-1.5">
              {name}
            </div>
          ))}
        </div>
        {grid.days.map((week) => (
          <div key={week[0]} className="border-border grid grid-cols-7 border-b last:border-b-0">
            {week.map((day) => (
              <div
                key={day}
                className={cn(
                  "border-border flex min-h-24 min-w-0 flex-col gap-1 border-r p-1.5 last:border-r-0",
                  !day.startsWith(month) && "bg-panel",
                )}
              >
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full text-xs tabular-nums",
                    day === today
                      ? "bg-teal font-bold text-white"
                      : day.startsWith(month)
                        ? "text-foreground"
                        : "text-muted-foreground",
                  )}
                  aria-label={formatDay(day)}
                >
                  {Number(day.slice(8))}
                </span>
                {(byDay.get(day) ?? []).map(chip)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
