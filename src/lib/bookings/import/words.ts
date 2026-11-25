import { plural } from "../../stock/import/words";
import type { BookingImportKind } from "./files";

/** What came back from the database for one file. */
export type BookingImportCounts = {
  new: number;
  changed: number;
  same: number;
  /** Rows the database couldn't use, by line and with why. */
  refused: { line: number; reason: string }[];
  ids_not_kept?: number;
  shared_rooms?: number;
  oversold?: number;
  emails_marked?: number;
};

const NOUN: Record<BookingImportKind, [string, string]> = {
  workshops: ["workshop", "workshops"],
  dates: ["date", "dates"],
  bookings: ["booking", "bookings"],
};

/** What the counts mean, in the words on the page. */
export function bookingCountLines(
  kind: BookingImportKind,
  counts: BookingImportCounts,
  done: boolean,
): string[] {
  const [one, many] = NOUN[kind];
  const lines: string[] = [];
  const add = (n: number | undefined, words: (n: number) => string) => {
    if (n && n > 0) lines.push(words(n));
  };
  add(
    counts.new,
    (n) => `${plural(n, `new ${one}`, `new ${many}`)} ${done ? "brought in" : "to bring in"}`,
  );
  add(
    counts.changed,
    (n) => `${plural(n, one, many)} ${done ? "brought up to date" : "to bring up to date"}`,
  );
  add(counts.same, (n) => `${plural(n, one, many)} already here as the file says`);
  add(
    counts.shared_rooms,
    (n) =>
      `${plural(n, "shared room")} ${done ? "set up" : "to set up"} for classes at the same time`,
  );
  add(
    counts.ids_not_kept,
    (n) =>
      `${plural(n, "date was", "dates were")} already here under ${n === 1 ? "its" : "their"} own id: carts carrying the earlier id will show under Needs a date`,
  );
  add(
    counts.oversold,
    (n) =>
      `${plural(n, "booking")} over a limit, kept and marked so you can sort ${n === 1 ? "it" : "them"} out`,
  );
  add(
    counts.emails_marked,
    (n) =>
      `${plural(n, "email")} noted as already sent (or not needed), so ${n === 1 ? "it isn't" : "they aren't"} sent again`,
  );
  add(
    counts.refused?.length,
    (n) => `${plural(n, "row")} left out by the check against what's here`,
  );
  if (lines.length === 0) lines.push("Nothing in this file would change anything.");
  return lines;
}
