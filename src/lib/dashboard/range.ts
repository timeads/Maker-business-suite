import { RANGE_LABELS, RANGE_PHRASES, RANGE_PRESETS, type RangePreset } from "./schema";

export type Grouping = "day" | "week" | "month";
export type ResolvedRange = { from: Date; to: Date; grouping: Grouping };

type LocalDate = { year: number; month: number; day: number };

/** The calendar date it is at `instant` in `timeZone`. */
export function localDate(instant: Date, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** The instant a calendar day starts in `timeZone`, daylight saving included. */
export function startOfLocalDay(date: LocalDate, timeZone: string): Date {
  const wallClock = Date.UTC(date.year, date.month - 1, date.day);
  // Two passes settle the offset even on the day the clocks change.
  let guess = wallClock;
  for (let pass = 0; pass < 2; pass++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(guess));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const shown = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    guess += wallClock - shown;
  }
  return new Date(guess);
}

const shiftMonths = (date: LocalDate, months: number): LocalDate => {
  const shifted = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: 1 };
};

const shiftDays = (date: LocalDate, days: number): LocalDate => {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
};

/** The first month of the quarter a month is in (1, 4, 7 or 10). */
const quarterStart = (month: number) => month - ((month - 1) % 3);

/**
 * Turns a preset into instants and a sensible bucket size, in the workspace's
 * timezone. Ranges that run "so far" end with today; a finished month,
 * quarter or year ends where the next one starts. Every edge is local
 * midnight, worked out for that day, so a clock change inside the range
 * never moves it.
 */
export function resolveRange(preset: RangePreset, now: Date, timeZone: string): ResolvedRange {
  const today = localDate(now, timeZone);
  // Through the end of today, so today's sales are included.
  const to = startOfLocalDay(shiftDays(today, 1), timeZone);
  const from = (date: LocalDate) => startOfLocalDay(date, timeZone);
  const thisMonth = { year: today.year, month: today.month, day: 1 };
  const thisQuarter = { year: today.year, month: quarterStart(today.month), day: 1 };
  switch (preset) {
    case "this_month":
      return { from: from(thisMonth), to, grouping: "day" };
    case "last_month":
      return { from: from(shiftMonths(thisMonth, -1)), to: from(thisMonth), grouping: "day" };
    case "last_30_days":
      return { from: from(shiftDays(today, -29)), to, grouping: "day" };
    case "last_90_days":
      return { from: from(shiftDays(today, -89)), to, grouping: "week" };
    case "this_quarter":
      return { from: from(thisQuarter), to, grouping: "week" };
    case "last_quarter":
      return { from: from(shiftMonths(thisQuarter, -3)), to: from(thisQuarter), grouping: "week" };
    case "last_6_months":
      return { from: from(shiftMonths(today, -5)), to, grouping: "month" };
    case "this_year":
      return { from: from({ year: today.year, month: 1, day: 1 }), to, grouping: "month" };
    case "last_year":
      return {
        from: from({ year: today.year - 1, month: 1, day: 1 }),
        to: from({ year: today.year, month: 1, day: 1 }),
        grouping: "month",
      };
    case "last_12_months":
    default:
      return { from: from(shiftMonths(today, -11)), to, grouping: "month" };
  }
}

/**
 * The calendar months a range touches, as `YYYY-MM`, in the workspace's
 * timezone: the first is the month `from` falls in, the last the month of
 * the range's final day. The books are kept by calendar month, so this is
 * how a range picks its months from them.
 */
export function rangeMonths(range: { from: Date; to: Date }, timeZone: string): string[] {
  const first = localDate(range.from, timeZone);
  const last = localDate(new Date(range.to.getTime() - 1), timeZone);
  const months: string[] = [];
  let cursor = { year: first.year, month: first.month, day: 1 };
  const end = last.year * 12 + last.month;
  while (cursor.year * 12 + cursor.month <= end && months.length < 240) {
    months.push(`${cursor.year}-${String(cursor.month).padStart(2, "0")}`);
    cursor = shiftMonths(cursor, 1);
  }
  return months;
}

/** The month it is now in the workspace's timezone, `YYYY-MM`. */
export function currentMonth(now: Date, timeZone: string): string {
  const today = localDate(now, timeZone);
  return `${today.year}-${String(today.month).padStart(2, "0")}`;
}

const key = (date: LocalDate) =>
  `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;

/**
 * Every bucket in the range, as the `YYYY-MM-DD` the database reports for it
 * (first of the month, or the Monday that starts the week), so periods with
 * no sales still show as zero.
 */
export function periodKeys(range: ResolvedRange, timeZone: string): string[] {
  let cursor = localDate(range.from, timeZone);
  const last = localDate(new Date(range.to.getTime() - 1), timeZone);
  if (range.grouping === "month") cursor = { ...cursor, day: 1 };
  if (range.grouping === "week") {
    const weekday = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day)).getUTCDay();
    cursor = shiftDays(cursor, -((weekday + 6) % 7));
  }
  const keys: string[] = [];
  while (key(cursor) <= key(last) && keys.length < 400) {
    keys.push(key(cursor));
    cursor =
      range.grouping === "month"
        ? shiftMonths(cursor, 1)
        : shiftDays(cursor, range.grouping === "week" ? 7 : 1);
  }
  return keys;
}

/** A short label for a bucket: "Nov", "Nov 9". */
export function periodLabel(periodKey: string, grouping: Grouping, withYear = false): string {
  const [year, month, day] = periodKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    ...(grouping === "month" ? {} : { day: "numeric" }),
    ...(withYear ? { year: "numeric" } : {}),
  }).format(date);
}

/** The plain day it is at `instant` in `timeZone`, `YYYY-MM-DD`. */
export function dayIn(instant: Date, timeZone: string): string {
  return key(localDate(instant, timeZone));
}

// ---------------------------------------------------------------------------
// One month, quarter or year picked by hand, any way back
// ---------------------------------------------------------------------------

/** A single calendar month, quarter or year, as a person picks one. */
export type PickedPeriod = { kind: "month" | "quarter" | "year"; year: number; n: number };

/**
 * Reads a period from the address: `m-2026-03` (a month), `q-2026-2` (a
 * quarter), `y-2025` (a year). Anything else is null.
 */
export function parsePeriod(value: unknown): PickedPeriod | null {
  if (typeof value !== "string") return null;
  const month = /^m-(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (month) return { kind: "month", year: Number(month[1]), n: Number(month[2]) };
  const quarter = /^q-(\d{4})-([1-4])$/.exec(value);
  if (quarter) return { kind: "quarter", year: Number(quarter[1]), n: Number(quarter[2]) };
  const year = /^y-(\d{4})$/.exec(value);
  if (year) return { kind: "year", year: Number(year[1]), n: 1 };
  return null;
}

/** A period as it is written in the address. */
export function periodValue(period: PickedPeriod): string {
  if (period.kind === "month") return `m-${period.year}-${String(period.n).padStart(2, "0")}`;
  if (period.kind === "quarter") return `q-${period.year}-${period.n}`;
  return `y-${period.year}`;
}

/** The instants a period runs between in `timeZone`, and a sensible bucket size. */
export function periodRange(period: PickedPeriod, timeZone: string): ResolvedRange {
  const firstMonth =
    period.kind === "month" ? period.n : period.kind === "quarter" ? (period.n - 1) * 3 + 1 : 1;
  const months = period.kind === "month" ? 1 : period.kind === "quarter" ? 3 : 12;
  const start = { year: period.year, month: firstMonth, day: 1 };
  return {
    from: startOfLocalDay(start, timeZone),
    to: startOfLocalDay(shiftMonths(start, months), timeZone),
    grouping: period.kind === "month" ? "day" : period.kind === "quarter" ? "week" : "month",
  };
}

const MONTHS = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });
const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const monthName = (month: number, short = false) =>
  (short ? SHORT : MONTHS).format(new Date(Date.UTC(2000, month - 1, 1)));

/** "March 2026", "April to June 2026", "2025". */
export function periodName(period: PickedPeriod): string {
  if (period.kind === "month") return `${monthName(period.n)} ${period.year}`;
  if (period.kind === "quarter") {
    const first = (period.n - 1) * 3 + 1;
    return `${monthName(first)} to ${monthName(first + 2)} ${period.year}`;
  }
  return String(period.year);
}

/** The period in a sentence, like the presets' phrases: "in March 2026". */
export const periodPhrase = (period: PickedPeriod) => `in ${periodName(period)}`;

/**
 * The months, quarters and years a person can pick: from the first of
 * January `years` years back to the month it is now, newest first. A period
 * still running is listed too (it ends today).
 */
export function periodChoices(
  now: Date,
  timeZone: string,
  years = 3,
): { kind: PickedPeriod["kind"]; value: string; label: string }[] {
  const today = localDate(now, timeZone);
  const out: { kind: PickedPeriod["kind"]; value: string; label: string }[] = [];
  for (let year = today.year; year >= today.year - years; year--) {
    const lastMonth = year === today.year ? today.month : 12;
    for (let n = lastMonth; n >= 1; n--) {
      const p: PickedPeriod = { kind: "month", year, n };
      out.push({ kind: "month", value: periodValue(p), label: periodName(p) });
    }
  }
  for (let year = today.year; year >= today.year - years; year--) {
    const lastQuarter = year === today.year ? Math.ceil(today.month / 3) : 4;
    for (let n = lastQuarter; n >= 1; n--) {
      const p: PickedPeriod = { kind: "quarter", year, n };
      const first = (n - 1) * 3 + 1;
      out.push({
        kind: "quarter",
        value: periodValue(p),
        label: `Q${n} ${year} (${monthName(first, true)}–${monthName(first + 2, true)})`,
      });
    }
  }
  for (let year = today.year; year >= today.year - years; year--) {
    out.push({
      kind: "year",
      value: periodValue({ kind: "year", year, n: 1 }),
      label: String(year),
    });
  }
  return out;
}

/** What a Money page shows: a preset range, or a month, quarter or year picked by hand. */
export type PageRange = {
  range: ResolvedRange;
  preset: RangePreset | null;
  period: PickedPeriod | null;
  /** In a sentence: "last month", "in March 2026". */
  phrase: string;
  /** As a heading or a file name: "Last month", "March 2026". */
  label: string;
  /** As it goes back in the address. */
  value: string;
};

export function pageRange(
  value: unknown,
  fallback: RangePreset,
  now: Date,
  timeZone: string,
): PageRange {
  const period = parsePeriod(value);
  if (period) {
    // A period still running ends with today, as "this month" does.
    const picked = periodRange(period, timeZone);
    const endOfToday = resolveRange("this_month", now, timeZone).to;
    return {
      range: picked.to > endOfToday ? { ...picked, to: endOfToday } : picked,
      preset: null,
      period,
      phrase: periodPhrase(period),
      label: periodName(period),
      value: periodValue(period),
    };
  }
  const preset =
    typeof value === "string" && (RANGE_PRESETS as readonly string[]).includes(value)
      ? (value as RangePreset)
      : fallback;
  return {
    range: resolveRange(preset, now, timeZone),
    preset,
    period: null,
    phrase: RANGE_PHRASES[preset],
    label: RANGE_LABELS[preset],
    value: preset,
  };
}
