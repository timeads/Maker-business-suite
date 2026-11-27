import type { BookingEmails } from "./config";
import type { SeatFigures } from "./seats";
import { zoneLabel } from "./slots";

/**
 * "How this is worked out" for Bookings: plain words for the figures people
 * question, built from the same inputs as the figure (the database's seat
 * figures, the emails config, the workspace's clock). Pure, no model.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Places left on a date, in the words of `private.seats_left`: the smaller
 * of what's left under the date's own limit and, when it shares a room,
 * under the shared limit; never below nothing.
 */
export function seatsExplained(
  figures: SeatFigures | undefined,
  date: { capacity: number; closed?: boolean; private?: boolean },
): string[] {
  if (!figures) {
    return [
      `This date takes ${plural(date.capacity, "person", "people")}. The places taken couldn't be read just now.`,
    ];
  }
  const ownLeft = Math.max(0, figures.capacity - figures.taken);
  const lines = [
    `${plural(figures.taken, "place")} taken: everyone booked, and anyone part-way through paying (their place is kept while they pay, then let go if they don't).`,
    `This date's own limit is ${figures.capacity}, so ${ownLeft} ${ownLeft === 1 ? "is" : "are"} left under it.`,
  ];
  if (figures.seat_group_id && figures.shared_capacity !== null && figures.shared_taken !== null) {
    const sharedLeft = Math.max(0, figures.shared_capacity - figures.shared_taken);
    lines.push(
      `It shares a room with classes at the same time: ${figures.shared_taken} of ${figures.shared_capacity} taken across them, so ${sharedLeft} left there.`,
      `A booking needs room under both, so the places left are the smaller of the two: ${figures.seats_left}.`,
    );
  } else {
    lines.push(`Places left: ${figures.seats_left}.`);
  }
  if (date.closed || date.private) {
    lines.push(
      date.closed
        ? "It isn't taking bookings, so nobody can book it online whatever is left. You can still add someone yourself."
        : "It's private, so it isn't offered online. You can still add someone yourself.",
    );
  }
  return lines;
}

/** Why bookings are marked over the limit, and what can be done about it. */
export function oversoldExplained(counts: {
  oversold: number;
  taken: number;
  capacity: number;
}): string[] {
  const lines = [
    "A booking that's been paid for is never turned away. When an order from your shop or Eventbrite, or one added by hand, comes in for a date that's already full, it's booked all the same and marked as over the limit so you can decide what to do.",
  ];
  if (counts.oversold > 0) {
    lines.push(
      `${plural(counts.oversold, "booking is", "bookings are")} marked that way here; ${counts.taken} places are taken on a date set for ${counts.capacity}.`,
    );
  }
  lines.push(
    "If everyone fits, raise the limit to match and the marks go. If not, move someone to another date or cancel their booking.",
  );
  return lines;
}

/**
 * When the automatic emails go for one date, from the workspace's emails
 * config, in the database's own rules (`claim_booking_email_sends`).
 */
export function emailTimingExplained(
  emails: BookingEmails,
  date: { starts_at: string; ends_at: string },
  timeZone: string,
  now: Date = new Date(),
): string[] {
  const at = (ms: number) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(ms));
  const start = Date.parse(date.starts_at);
  const end = Date.parse(date.ends_at);
  const hours = (n: number) => plural(n, "hour");
  const reminder = start - emails.reminder_hours * 3_600_000;
  const lines = [
    `The reminder goes ${hours(emails.reminder_hours)} before it starts: ${at(reminder)}. Someone who books after that gets theirs straight away, alongside their confirmation.`,
  ];
  if (emails.day_of_on && emails.day_of_hours < emails.reminder_hours) {
    lines.push(
      `The day-of reminder goes ${hours(emails.day_of_hours)} before: ${at(start - emails.day_of_hours * 3_600_000)}, except to anyone who booked inside those last hours.`,
    );
  } else if (emails.day_of_on) {
    lines.push(
      "The day-of reminder is switched on, but it only goes when it comes after the first reminder, so with these hours it doesn't.",
    );
  }
  if (emails.followup_on) {
    lines.push(
      `The thank-you goes ${hours(emails.followup_hours)} after it ends: ${at(end + emails.followup_hours * 3_600_000)}, to everyone not marked as a no-show.`,
    );
  } else {
    lines.push("The thank-you is switched off.");
  }
  lines.push(
    "Only people who said yes to emails get them, and each goes once: if you change the date's time after a reminder went, it isn't sent again.",
  );
  if (start < now.getTime())
    lines.push("This date has started, so only the thank-you is still to come.");
  return lines;
}

/** The time zone label shoppers see beside every time. */
export function zoneExplained(timeZone: string, at: Date | string): string[] {
  const label = zoneLabel(timeZone, at);
  return [
    `Every time is on your workspace's clock (${timeZone}).`,
    label
      ? `Shoppers see it with “${label}” after it. The label is worked out for each date, so it stays right when the clocks change.`
      : "We couldn't find a short name for this time zone, so times are shown without one.",
    "Change the time zone under Settings → Workspace.",
  ];
}
