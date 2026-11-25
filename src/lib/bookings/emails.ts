import { formatMoney } from "../dashboard/format";
import { formatWhen } from "./slots";

export type BookingDetails = {
  booking_id: string;
  tenant_id: string;
  status: "pending_payment" | "confirmed" | "cancelled";
  seats: number;
  amount_cents: number;
  currency: string;
  customer_name: string;
  customer_email: string;
  oversold: boolean;
  session_id: string;
  starts_at: string;
  ends_at: string;
  session_cancelled: boolean;
  service_id: string;
  service_name: string;
  service_kind: "workshop" | "appointment";
  workspace_name: string;
  workspace_slug: string;
  timezone: string;
};

export type Email = { to: string; subject: string; text: string };

const firstName = (name: string) => name.trim().split(/\s+/)[0] || "there";
const when = (d: BookingDetails) => formatWhen(d.starts_at, d.ends_at, d.timezone);
const seats = (d: BookingDetails) => (d.seats === 1 ? "1 place" : `${d.seats} places`);

export const manageUrl = (site: string, token: string) => `${site}/booking/${token}`;

/** The business's own words, set off from ours. */
const noteLines = (note: string | undefined) => (note?.trim() ? [note.trim(), ""] : []);

export function confirmationEmail(d: BookingDetails, link: string, note?: string): Email {
  return {
    to: d.customer_email,
    subject: `You're booked: ${d.service_name} with ${d.workspace_name}`,
    text: [
      `Hi ${firstName(d.customer_name)},`,
      "",
      `You're booked in for ${d.service_name} with ${d.workspace_name}.`,
      "",
      `When: ${when(d)}`,
      ...(d.service_kind === "workshop" ? [`Places: ${seats(d)}`] : []),
      ...(d.amount_cents > 0 ? [`Paid: ${formatMoney(d.amount_cents / 100, d.currency)}`] : []),
      "",
      ...noteLines(note),
      "Need to change or cancel? Use your booking link:",
      link,
      "",
      "See you then!",
    ].join("\n"),
  };
}

export function reminderEmail(d: BookingDetails, note?: string): Email {
  return {
    to: d.customer_email,
    subject: `Reminder: ${d.service_name} with ${d.workspace_name}`,
    text: [
      `Hi ${firstName(d.customer_name)},`,
      "",
      `A quick reminder that ${d.service_name} with ${d.workspace_name} is coming up.`,
      "",
      `When: ${when(d)}`,
      "",
      ...noteLines(note),
      "If you can't make it, the link in your confirmation email lets you change or cancel.",
    ].join("\n"),
  };
}

/** A short nudge on the day, for workspaces that switched it on. */
export function dayOfEmail(d: BookingDetails, note?: string): Email {
  return {
    to: d.customer_email,
    subject: `Nearly time: ${d.service_name} with ${d.workspace_name}`,
    text: [
      `Hi ${firstName(d.customer_name)},`,
      "",
      `${d.service_name} with ${d.workspace_name} starts soon.`,
      "",
      `When: ${when(d)}`,
      "",
      ...noteLines(note),
      "See you there!",
    ].join("\n"),
  };
}

/** A refund or cancellation in the business's shop took this booking off the list. */
export function shopCancelledEmail(d: BookingDetails): Email {
  return {
    to: d.customer_email,
    subject: `Your booking was cancelled: ${d.service_name} with ${d.workspace_name}`,
    text: [
      `Hi ${firstName(d.customer_name)},`,
      "",
      `Your booking for ${d.service_name} on ${when(d)} has been cancelled.`,
      "",
      `If that wasn't expected, or you'd like to book another date, just reply to ${d.workspace_name} and they'll help.`,
    ].join("\n"),
  };
}

export function sessionCancelledEmail(d: BookingDetails): Email {
  return {
    to: d.customer_email,
    subject: `Cancelled: ${d.service_name} with ${d.workspace_name}`,
    text: [
      `Hi ${firstName(d.customer_name)},`,
      "",
      `We're sorry: ${d.service_name} on ${when(d)} has been cancelled by ${d.workspace_name}.`,
      "",
      d.amount_cents > 0
        ? `${d.workspace_name} will be in touch about your payment.`
        : "There's nothing you need to do.",
    ].join("\n"),
  };
}

export function waitlistEmail(
  entry: { customer_name: string; customer_email: string },
  d: Pick<BookingDetails, "service_name" | "workspace_name" | "starts_at" | "ends_at" | "timezone">,
  link: string,
): Email {
  return {
    to: entry.customer_email,
    subject: `A place opened up: ${d.service_name} with ${d.workspace_name}`,
    text: [
      `Hi ${firstName(entry.customer_name)},`,
      "",
      `A place has opened up in ${d.service_name} on ${formatWhen(d.starts_at, d.ends_at, d.timezone)}.`,
      "",
      "It's first come, first served. Book here:",
      link,
    ].join("\n"),
  };
}

export function ownerNoticeEmail(d: BookingDetails, to: string, link: string): Email {
  return {
    to,
    subject: `New booking: ${d.service_name}, ${when(d)}`,
    text: [
      `${d.customer_name} (${d.customer_email}) booked ${d.service_name}.`,
      "",
      `When: ${when(d)}`,
      `Places: ${d.seats}`,
      ...(d.oversold
        ? [
            "",
            "Heads up: this payment arrived after the session had filled, so it is now over its limit. The booking has been kept; you may want to get in touch.",
          ]
        : []),
      "",
      `See who's coming: ${link}`,
    ].join("\n"),
  };
}

export function followupEmail(d: BookingDetails, message?: string): Email {
  return {
    to: d.customer_email,
    subject: `Thanks for coming to ${d.service_name}`,
    text: [
      `Hi ${firstName(d.customer_name)},`,
      "",
      message?.trim() ||
        `Thank you for joining ${d.service_name} with ${d.workspace_name}. We hope you enjoyed it and we'd love to see you again.`,
      "",
      d.workspace_name,
    ].join("\n"),
  };
}

/** The business moved someone to another date. `d` is the booking after the move. */
export function movedEmail(d: BookingDetails, link: string | null): Email {
  return {
    to: d.customer_email,
    subject: `Your booking has moved: ${d.service_name} with ${d.workspace_name}`,
    text: [
      `Hi ${firstName(d.customer_name)},`,
      "",
      `${d.workspace_name} has moved your booking for ${d.service_name}.`,
      "",
      `New time: ${when(d)}`,
      ...(link ? ["", "Your booking link:", link] : []),
      "",
      `If that doesn't work for you, reply to ${d.workspace_name} and they'll sort it out.`,
    ].join("\n"),
  };
}

/** The business cancelled one person's booking (not the whole date). */
export function bookingCancelledEmail(d: BookingDetails): Email {
  return {
    to: d.customer_email,
    subject: `Your booking was cancelled: ${d.service_name} with ${d.workspace_name}`,
    text: [
      `Hi ${firstName(d.customer_name)},`,
      "",
      `${d.workspace_name} has cancelled your booking for ${d.service_name} on ${when(d)}.`,
      "",
      d.amount_cents > 0
        ? `${d.workspace_name} will be in touch about your payment.`
        : "There's nothing you need to do.",
    ].join("\n"),
  };
}

/** A note from the business to everyone on a date. */
export function broadcastEmail(
  to: { customer_name: string; customer_email: string },
  d: Pick<BookingDetails, "service_name" | "workspace_name" | "starts_at" | "ends_at" | "timezone">,
  subject: string,
  body: string,
): Email {
  return {
    to: to.customer_email,
    subject,
    text: [
      `Hi ${firstName(to.customer_name)},`,
      "",
      body.trim(),
      "",
      `${d.workspace_name}`,
      `About: ${d.service_name}, ${formatWhen(d.starts_at, d.ends_at, d.timezone)}`,
    ].join("\n"),
  };
}

/** Plain CSV: quotes doubled, and cells that a spreadsheet would run as a formula defused. */
export function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
