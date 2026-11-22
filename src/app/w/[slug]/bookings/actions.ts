"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  BOOKINGS_MODULE,
  FORM_KEY,
  bookingFormSchema,
  questionsFromText,
} from "@/lib/bookings/config";
import { sessionCancelledEmail, type BookingDetails } from "@/lib/bookings/emails";
import { parseClock, zonedTimeToUtc } from "@/lib/bookings/slots";
import { sendEmail } from "@/lib/email";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type BookingsState = { error?: string; message?: string };

const NO_ACCESS = "Bookings aren't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can change bookings.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/bookings`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.bookings")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (!canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "").trim();

/** Creates a service, or saves changes to one. */
export async function saveService(
  slug: string,
  serviceId: string | null,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };

  const name = text(formData, "name");
  const kind = text(formData, "kind");
  const duration = Number.parseInt(text(formData, "duration"), 10);
  const price = Math.round(Number.parseFloat(text(formData, "price") || "0") * 100);
  const capacity = Number.parseInt(text(formData, "capacity") || "1", 10);
  if (!name || name.length > 80) return { error: "Give it a name (up to 80 characters)." };
  if (kind !== "workshop" && kind !== "appointment") return { error: "Pick what kind it is." };
  if (!(duration >= 5 && duration <= 1440)) return { error: "How long does it run, in minutes?" };
  if (!(price >= 0 && price <= 1_000_000)) return { error: "That price doesn't look right." };
  if (!(capacity >= 1 && capacity <= 500)) return { error: "How many places does it have?" };

  const { data, error } = await ctx.supabase.rpc("save_service", {
    p_tenant_id: ctx.tenant.id,
    p_service_id: serviceId,
    p_kind: kind,
    p_name: name,
    p_description: text(formData, "description").slice(0, 2000),
    p_duration_minutes: duration,
    p_price_cents: price,
    p_capacity: kind === "appointment" ? 1 : capacity,
    p_active: serviceId ? formData.get("active") === "on" : true,
  });
  if (error) return { error: OOPS };
  revalidatePath(`/w/${slug}/bookings`, "layout");
  if (!serviceId) redirect(`/w/${slug}/bookings/services/${data as string}`);
  return { message: "Saved." };
}

/** Puts a workshop date on the calendar. The time typed is in the workspace's timezone. */
export async function addSession(
  slug: string,
  serviceId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };

  const day = text(formData, "day");
  const minutes = parseClock(text(formData, "time"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || minutes === null) {
    return { error: "Pick a date and a start time." };
  }
  const startsAt = zonedTimeToUtc(day, minutes, ctx.tenant.timezone);
  if (!startsAt) {
    return { error: "That time doesn't exist on that day (the clocks change). Pick another." };
  }
  if (startsAt.getTime() <= Date.now()) return { error: "Pick a time in the future." };
  const capacityText = text(formData, "capacity");
  const capacity = capacityText ? Number.parseInt(capacityText, 10) : null;
  if (capacity !== null && !(capacity >= 1 && capacity <= 500)) {
    return { error: "How many places does this date have?" };
  }

  const { error } = await ctx.supabase.rpc("add_session", {
    p_service_id: serviceId,
    p_starts_at: startsAt.toISOString(),
    p_capacity: capacity,
  });
  if (error) {
    return { error: error.code === "23505" ? "That date and time is already scheduled." : OOPS };
  }
  revalidatePath(`/w/${slug}/bookings`, "layout");
  return { message: "Date added." };
}

/** Calls a date off and emails everyone who was booked on it. */
export async function cancelSession(
  slug: string,
  sessionId: string,
  _prev: BookingsState,
  _formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };

  const { data: session } = await ctx.supabase
    .from("sessions")
    .select("id, starts_at, ends_at, service_id, services(name, kind)")
    .eq("id", sessionId)
    .eq("tenant_id", ctx.tenant.id)
    .maybeSingle();
  if (!session) return { error: "That date couldn't be found." };

  const { data, error } = await ctx.supabase.rpc("cancel_session", { p_session_id: sessionId });
  if (error) return { error: OOPS };

  const service = session.services as unknown as { name: string; kind: "workshop" | "appointment" };
  const cancelled = (data ?? []) as {
    id: string;
    status: string;
    seats: number;
    amount_cents: number;
    currency: string;
    customer_name: string;
    customer_email: string;
    confirmed_at: string | null;
  }[];
  let told = 0;
  for (const booking of cancelled) {
    // People who never finished paying don't need to hear about it.
    if (!booking.confirmed_at) continue;
    const details: BookingDetails = {
      booking_id: booking.id,
      tenant_id: ctx.tenant.id,
      status: "cancelled",
      seats: booking.seats,
      amount_cents: booking.amount_cents,
      currency: booking.currency,
      customer_name: booking.customer_name,
      customer_email: booking.customer_email,
      oversold: false,
      session_id: sessionId,
      starts_at: session.starts_at as string,
      ends_at: session.ends_at as string,
      session_cancelled: true,
      service_id: session.service_id as string,
      service_name: service.name,
      service_kind: service.kind,
      workspace_name: ctx.tenant.name,
      workspace_slug: ctx.tenant.slug,
      timezone: ctx.tenant.timezone,
    };
    if (await sendEmail(sessionCancelledEmail(details))) told += 1;
  }
  const booked = cancelled.filter((b) => b.confirmed_at).length;
  revalidatePath(`/w/${slug}/bookings`, "layout");
  return {
    message:
      booked === 0
        ? "Cancelled. Nobody was booked on it."
        : told === booked
          ? `Cancelled. We emailed ${booked === 1 ? "the person" : `all ${booked} people`} who had booked.`
          : "Cancelled. Email isn't switched on here, so please let the people below know yourself.",
  };
}

/** Saves the weekly hours an appointment can be booked in. */
export async function saveAvailability(
  slug: string,
  serviceId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };

  const rules: { weekday: number; start_minute: number; end_minute: number }[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    const from = text(formData, `from_${weekday}`);
    const to = text(formData, `to_${weekday}`);
    if (!from && !to) continue;
    const start = parseClock(from);
    const end = parseClock(to);
    if (start === null || end === null || end <= start) {
      return { error: "Each open day needs a start time and a later end time." };
    }
    rules.push({ weekday, start_minute: start, end_minute: end });
  }
  const { error } = await ctx.supabase.rpc("set_availability", {
    p_service_id: serviceId,
    p_rules: rules,
  });
  if (error) return { error: OOPS };
  revalidatePath(`/w/${slug}/bookings`, "layout");
  return { message: "Hours saved." };
}

/** Saves the extra questions asked on the booking form. */
export async function saveBookingForm(
  slug: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const parsed = bookingFormSchema.safeParse(
    questionsFromText(String(formData.get("questions") ?? "")),
  );
  if (!parsed.success) {
    return { error: "Keep it to 8 questions, each under 120 characters." };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: BOOKINGS_MODULE,
    p_key: FORM_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  revalidatePath(`/w/${slug}/bookings`, "layout");
  return { message: "Saved." };
}
