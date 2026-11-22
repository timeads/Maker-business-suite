/**
 * The two calendar helpers the engine needs. Days are counted on the local
 * calendar of the dates passed in, so callers hand in "today" already set to
 * the workspace's own day.
 */
const DAY = 86_400_000;
const startOfDay = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Whole calendar days from `earlier` to `later` (negative if it is the other way round). */
export function differenceInCalendarDays(later: Date, earlier: Date): number {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / DAY);
}
