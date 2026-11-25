"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import {
  BOOKINGS_MODULE,
  EMAILS_KEY,
  bookingEmailsSchema,
  tagsFromText,
} from "@/lib/bookings/config";
import {
  bookingCancelledEmail,
  broadcastEmail,
  confirmationEmail,
  manageUrl,
  movedEmail,
  waitlistEmail,
  type BookingDetails,
} from "@/lib/bookings/emails";
import { sendEmail } from "@/lib/email";
import { getEntitlements } from "@/lib/entitlements";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import type { BookingsState } from "./actions";

const NO_ACCESS = "Bookings aren't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can do that.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function context(slug: string, managersOnly: boolean) {
  const user = await requireUser(`/w/${slug}/bookings`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.bookings")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (managersOnly && !canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}
type Ctx = Exclude<Awaited<ReturnType<typeof context>>, { error: string }>;

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "").trim();
const done = (slug: string) => {
  revalidatePath(`/w/${slug}/bookings`, "layout");
  // This tool's settings screens live under workspace Settings.
  revalidatePath(`/w/${slug}/settings`, "layout");
};

/** What the emails need to know about one booking, read as the signed-in member. */
async function detailsFor(ctx: Ctx, bookingId: string): Promise<BookingDetails | null> {
  const { data } = await ctx.supabase
    .from("bookings")
    .select(
      "id, status, seats, amount_cents, currency, customer_name, customer_email, oversold, email_opt_in, session_id, sessions(starts_at, ends_at, cancelled_at, service_id, services(name, kind))",
    )
    .eq("id", bookingId)
    .eq("tenant_id", ctx.tenant.id)
    .maybeSingle();
  if (!data) return null;
  const session = data.sessions as unknown as {
    starts_at: string;
    ends_at: string;
    cancelled_at: string | null;
    service_id: string;
    services: { name: string; kind: "workshop" | "appointment" };
  };
  return {
    booking_id: data.id as string,
    tenant_id: ctx.tenant.id,
    status: data.status as BookingDetails["status"],
    seats: data.seats as number,
    amount_cents: data.amount_cents as number,
    currency: data.currency as string,
    customer_name: data.customer_name as string,
    customer_email: data.customer_email as string,
    oversold: data.oversold as boolean,
    session_id: data.session_id as string,
    starts_at: session.starts_at,
    ends_at: session.ends_at,
    session_cancelled: session.cancelled_at !== null,
    service_id: session.service_id,
    service_name: session.services.name,
    service_kind: session.services.kind,
    workspace_name: ctx.tenant.name,
    workspace_slug: ctx.tenant.slug,
    timezone: ctx.tenant.timezone,
  };
}

async function tellWaitlist(
  waiting: unknown,
  about: BookingDetails,
  slug: string,
): Promise<number> {
  const link = `${await getSiteUrl()}/book/${slug}`;
  let told = 0;
  for (const entry of (waiting ?? []) as { customer_name: string; customer_email: string }[]) {
    if (await sendEmail(waitlistEmail(entry, about, link))) told += 1;
  }
  return told;
}

/** Ticks someone in, marks a no-show, or clears the mark. Anyone on the team can. */
export async function setAttendance(
  slug: string,
  bookingId: string,
  attendance: "attended" | "no_show" | null,
): Promise<BookingsState> {
  const ctx = await context(slug, false);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("set_booking_attendance", {
    p_booking_id: bookingId,
    p_attendance: attendance,
  });
  if (error) return { error: OOPS };
  done(slug);
  return {};
}

export async function saveBookingNotes(
  slug: string,
  bookingId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug, false);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("set_booking_notes", {
    p_booking_id: bookingId,
    p_notes: text(formData, "notes").slice(0, 2000),
    p_tags: tagsFromText(text(formData, "tags")),
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Saved." };
}

export async function saveBookingContact(
  slug: string,
  bookingId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  const name = text(formData, "name");
  const email = text(formData, "email");
  if (!name || name.length > 120) return { error: "Add their name." };
  if (!EMAIL.test(email) || email.length > 200) return { error: "That email doesn't look right." };
  const { error } = await ctx.supabase.rpc("update_booking_contact", {
    p_booking_id: bookingId,
    p_name: name,
    p_email: email,
    p_email_opt_in: formData.get("emails") === "on",
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Saved." };
}

/** Adds someone by hand: a phone booking, a guest, a comp. Never charged. */
export async function addPerson(
  slug: string,
  sessionId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  const name = text(formData, "name");
  const email = text(formData, "email");
  const seats = Number.parseInt(text(formData, "seats") || "1", 10);
  if (!name || name.length > 120) return { error: "Add their name." };
  if (!EMAIL.test(email) || email.length > 200) {
    return { error: "Add an email, so they get the details and a reminder." };
  }
  if (!(seats >= 1 && seats <= 50)) return { error: "How many places?" };

  const token = randomBytes(24).toString("base64url");
  const { data, error } = await ctx.supabase.rpc("add_manual_booking", {
    p_session_id: sessionId,
    p_name: name,
    p_email: email,
    p_seats: seats,
    p_notes: text(formData, "notes").slice(0, 2000),
    p_manage_token: token,
    p_allow_over: formData.get("over") === "on",
  });
  if (error) {
    return {
      error: error.message.includes("full")
        ? "There isn't room for that many. Tick “go over the limit” to add them anyway."
        : error.message.includes("cancelled")
          ? "This date was cancelled."
          : OOPS,
    };
  }
  let emailed = false;
  if (formData.get("tell") === "on") {
    const details = await detailsFor(ctx, data as string);
    if (details) {
      emailed = await sendEmail(confirmationEmail(details, manageUrl(await getSiteUrl(), token)));
    }
  }
  done(slug);
  return { message: emailed ? `${name} is added and has been emailed.` : `${name} is added.` };
}

/** Moves one booking to another date of the same workshop and tells them. */
export async function moveBooking(
  slug: string,
  bookingId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  const target = text(formData, "session");
  if (!/^[0-9a-f-]{36}$/i.test(target)) return { error: "Pick a date to move them to." };
  const before = await detailsFor(ctx, bookingId);
  if (!before) return { error: "That booking couldn't be found." };

  const { data, error } = await ctx.supabase.rpc("admin_move_booking", {
    p_booking_id: bookingId,
    p_new_session_id: target,
  });
  if (error) {
    return {
      error: error.message.includes("full")
        ? "That date doesn't have enough places left."
        : "That date isn't available.",
    };
  }
  const after = await detailsFor(ctx, bookingId);
  const emailed = after ? await sendEmail(movedEmail(after, null)) : false;
  await tellWaitlist(data, before, slug);
  done(slug);
  return {
    message: emailed
      ? `Moved. ${before.customer_name} has been emailed the new time.`
      : `Moved. Email isn't switched on here, so let ${before.customer_name} know yourself.`,
  };
}

/** Cancels one person's booking. Refunds stay in the business's own Stripe. */
export async function cancelBooking(
  slug: string,
  bookingId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  const details = await detailsFor(ctx, bookingId);
  if (!details) return { error: "That booking couldn't be found." };
  const { data, error } = await ctx.supabase.rpc("admin_cancel_booking", {
    p_booking_id: bookingId,
  });
  if (error) return { error: OOPS };
  const emailed =
    formData.get("tell") === "on" ? await sendEmail(bookingCancelledEmail(details)) : false;
  const told = await tellWaitlist(data, details, slug);
  done(slug);
  return {
    message: [
      "Cancelled.",
      emailed ? `${details.customer_name} has been emailed.` : "",
      told
        ? `${told === 1 ? "1 person" : `${told} people`} on the waitlist ${told === 1 ? "was" : "were"} told a place opened up.`
        : "",
      details.amount_cents > 0 ? "If they paid, send the refund from your Stripe account." : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/** Changes a date's places, and whether it's open, private, or has a note for the team. */
export async function saveSessionSettings(
  slug: string,
  sessionId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  const capacity = Number.parseInt(text(formData, "capacity"), 10);
  if (!(capacity >= 1 && capacity <= 500)) return { error: "How many places does this date have?" };
  const { error } = await ctx.supabase.rpc("update_session", {
    p_session_id: sessionId,
    p_capacity: capacity,
    p_bookings_closed: formData.get("closed") === "on",
    p_private: formData.get("private") === "on",
    p_notes: text(formData, "notes").slice(0, 2000),
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Saved." };
}

/** Emails a note to everyone booked on a date, and keeps a record of it. */
export async function emailEveryone(
  slug: string,
  sessionId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  const subject = text(formData, "subject");
  const body = text(formData, "body");
  if (!subject || subject.length > 200) return { error: "Give your message a subject." };
  if (!body || body.length > 5000) return { error: "Write your message (up to 5,000 characters)." };

  const { data: session } = await ctx.supabase
    .from("sessions")
    .select(
      "starts_at, ends_at, services(name), bookings(customer_name, customer_email, status, email_opt_in)",
    )
    .eq("id", sessionId)
    .eq("tenant_id", ctx.tenant.id)
    .maybeSingle();
  if (!session) return { error: "That date couldn't be found." };
  const about = {
    service_name: (session.services as unknown as { name: string }).name,
    workspace_name: ctx.tenant.name,
    starts_at: session.starts_at as string,
    ends_at: session.ends_at as string,
    timezone: ctx.tenant.timezone,
  };
  const people = (
    session.bookings as unknown as {
      customer_name: string;
      customer_email: string;
      status: string;
      email_opt_in: boolean;
    }[]
  ).filter((b) => b.status === "confirmed" && b.email_opt_in);
  // One email per address, however many bookings they made.
  const unique = [...new Map(people.map((p) => [p.customer_email, p])).values()];
  if (unique.length === 0) return { error: "Nobody on this date can be emailed yet." };

  let sent = 0;
  for (const person of unique) {
    if (await sendEmail(broadcastEmail(person, about, subject, body))) sent += 1;
  }
  if (sent === 0) {
    return { error: "Email isn't switched on for this workspace yet, so nothing was sent." };
  }
  await ctx.supabase.rpc("log_booking_message", {
    p_session_id: sessionId,
    p_subject: subject,
    p_body: body,
    p_recipients: sent,
  });
  done(slug);
  return { message: `Sent to ${sent === 1 ? "1 person" : `${sent} people`}.` };
}

/** Saves when reminders and thank-yous go out and what the business adds to them. */
export async function saveBookingEmails(
  slug: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  const parsed = bookingEmailsSchema.safeParse({
    version: 1,
    reminder_hours: Number.parseInt(text(formData, "reminder_hours"), 10),
    day_of_on: formData.get("day_of_on") === "on",
    day_of_hours: Number.parseInt(text(formData, "day_of_hours") || "2", 10),
    day_of_note: text(formData, "day_of_note"),
    shop_cancel_email: formData.get("shop_cancel_email") === "on",
    followup_on: formData.get("followup_on") === "on",
    followup_hours: Number.parseInt(text(formData, "followup_hours") || "24", 10),
    confirmation_note: text(formData, "confirmation_note"),
    reminder_note: text(formData, "reminder_note"),
    followup_message: text(formData, "followup_message"),
  });
  if (!parsed.success) {
    return {
      error:
        "Keep each note under 1,500 characters, timings between 1 hour and 14 days, and the day-of reminder within 24 hours of the start.",
    };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: BOOKINGS_MODULE,
    p_key: EMAILS_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  done(slug);
  return {
    message:
      parsed.data.day_of_on && parsed.data.day_of_hours >= parsed.data.reminder_hours
        ? "Saved. The day-of reminder won't go out until it's set closer to the start than the first reminder."
        : "Saved.",
  };
}
