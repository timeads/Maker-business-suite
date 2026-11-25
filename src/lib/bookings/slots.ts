/**
 * Appointment times are worked out from weekly opening hours kept in the
 * workspace's own timezone. Everything here is pure so the daylight-saving
 * edges can be tested.
 */

export type AvailabilityRule = { weekday: number; start_minute: number; end_minute: number };
export type Busy = { starts_at: string; ends_at: string };
export type Slot = { startsAt: string; endsAt: string; day: string };

const partsFormat = new Map<string, Intl.DateTimeFormat>();

function wallClock(instant: Date, timeZone: string) {
  let format = partsFormat.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormat.set(timeZone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts as { year: number; month: number; day: number; hour: number; minute: number };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The calendar date (YYYY-MM-DD) an instant falls on in a timezone. */
export function localDay(instant: Date, timeZone: string): string {
  const p = wallClock(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * What a timezone's clocks read at an instant: the calendar date, the weekday
 * (0 is Sunday) and the minutes past midnight. It follows the clocks through
 * daylight-saving changes, so "inside the opening hours" can be asked of it
 * directly.
 */
export function localClock(
  instant: Date,
  timeZone: string,
): { day: string; weekday: number; minute: number } {
  const p = wallClock(instant, timeZone);
  return {
    day: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    weekday: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(),
    minute: p.hour * 60 + p.minute,
  };
}

/**
 * The instant at which a timezone's clocks read `day` + `minutes` past
 * midnight. Returns null for a time that doesn't exist there (the hour skipped
 * when clocks go forward). When clocks go back and a time happens twice, the
 * first one is returned.
 */
export function zonedTimeToUtc(day: string, minutes: number, timeZone: string): Date | null {
  const [y, m, d] = day.split("-").map(Number);
  const wanted = Date.UTC(y, m - 1, d, 0, minutes);
  const offsetAt = (ms: number) => {
    const p = wallClock(new Date(ms), timeZone);
    return (
      Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000
    );
  };
  const candidates = [
    wanted - offsetAt(wanted - 86_400_000),
    wanted - offsetAt(wanted + 86_400_000),
  ]
    .filter((ms, i, all) => all.indexOf(ms) === i)
    .sort((a, b) => a - b);
  for (const ms of candidates) {
    if (ms + offsetAt(ms) === wanted) return new Date(ms);
  }
  return null;
}

function addDays(day: string, count: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + count)).toISOString().slice(0, 10);
}

const weekdayOf = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/**
 * Open appointment times for the coming days: back to back from each opening
 * time, skipping anything already booked or too soon to arrive for.
 */
export function generateSlots(input: {
  rules: AvailabilityRule[];
  durationMinutes: number;
  timeZone: string;
  now: Date;
  days: number;
  busy: Busy[];
  /** How much notice a booking needs. */
  leadMinutes?: number;
}): Slot[] {
  const earliest = input.now.getTime() + (input.leadMinutes ?? 120) * 60_000;
  const busy = input.busy.map((b) => [Date.parse(b.starts_at), Date.parse(b.ends_at)] as const);
  const today = localDay(input.now, input.timeZone);
  const seen = new Set<number>();
  const slots: Slot[] = [];

  for (let i = 0; i < input.days; i++) {
    const day = addDays(today, i);
    const weekday = weekdayOf(day);
    for (const rule of input.rules) {
      if (rule.weekday !== weekday) continue;
      for (
        let minute = rule.start_minute;
        minute + input.durationMinutes <= rule.end_minute;
        minute += input.durationMinutes
      ) {
        const start = zonedTimeToUtc(day, minute, input.timeZone);
        if (!start) continue;
        const startMs = start.getTime();
        const endMs = startMs + input.durationMinutes * 60_000;
        if (startMs < earliest || seen.has(startMs)) continue;
        if (busy.some(([from, to]) => from < endMs && to > startMs)) continue;
        seen.add(startMs);
        slots.push({ startsAt: start.toISOString(), endsAt: new Date(endMs).toISOString(), day });
      }
    }
  }
  return slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** Whether a start time is one the opening hours really offer. */
export function isOfferedSlot(
  startsAt: string,
  input: Omit<Parameters<typeof generateSlots>[0], "days">,
): boolean {
  const target = Date.parse(startsAt);
  if (Number.isNaN(target)) return false;
  const days = Math.ceil((target - input.now.getTime()) / 86_400_000) + 2;
  if (days < 1 || days > 400) return false;
  return generateSlots({ ...input, days }).some((s) => Date.parse(s.startsAt) === target);
}

/** "Sat, Mar 14, 10:00 AM – 12:00 PM EDT" in the workspace's timezone. */
export function formatWhen(startsAt: string, endsAt: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(startsAt));
  return `${day}, ${formatTime(startsAt, timeZone)} – ${formatTime(endsAt, timeZone, true)}`;
}

export function formatTime(instant: string, timeZone: string, withZone = false): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    ...(withZone ? { timeZoneName: "short" } : {}),
  }).format(new Date(instant));
}

/** "Saturday, March 14" for a YYYY-MM-DD day. */
export function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Minutes past midnight to "9:30 AM". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

/** "09:30" to minutes past midnight, or null. */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[1]) <= 24 && Number(match[2]) < 60 && minutes <= 1440 ? minutes : null;
}

/** Whether an instant is still ahead of us. */
export const isUpcoming = (instant: string) => Date.parse(instant) > Date.now();

/**
 * The weeks of a month ("YYYY-MM") as rows of seven YYYY-MM-DD days, Sunday
 * first, padded with the neighbouring months' days.
 */
export function monthGrid(month: string): { days: string[][]; previous: string; next: string } {
  const [y, m] = month.split("-").map(Number);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const cursor = new Date(first);
  cursor.setUTCDate(1 - first.getUTCDay());
  const days: string[][] = [];
  do {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(iso(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    days.push(week);
  } while (cursor.getUTCMonth() === m - 1);
  return {
    days,
    previous: iso(new Date(Date.UTC(y, m - 2, 1))).slice(0, 7),
    next: iso(new Date(Date.UTC(y, m, 1))).slice(0, 7),
  };
}

/** "December 2026" for "2026-12". */
export function formatMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** An instant some days from now (negative for the past), as an ISO string. */
export const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
