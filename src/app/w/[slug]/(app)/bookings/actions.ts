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
import type { BookingDetails } from "@/lib/bookings/emails";
import { readEmailSettings } from "@/lib/bookings/email-settings";
import { bookingEmail } from "@/lib/bookings/words";
import { SHOP_PAGE_KEY, shopPageSchema } from "@/lib/bookings/shop-page";
import { SHOP_TAGS_KEY, shopTagsSchema } from "@/lib/bookings/shop-tags";
import { DAILY_KEY, dailyEmailSchema, hourWords } from "@/lib/bookings/daily-config";
import { DEFAULT_UPCOMING, UPCOMING_KEY, upcomingSchema } from "@/lib/bookings/upcoming";
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
  if (kind === "workshop") {
    const { error: placeError } = await ctx.supabase.rpc("set_service_location", {
      p_service_id: data as string,
      p_location: text(formData, "location").slice(0, 200),
    });
    if (placeError) return { error: OOPS };
  }
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
  const weeks = Number.parseInt(text(formData, "weeks") || "1", 10);
  if (!(weeks >= 1 && weeks <= 52)) return { error: "Repeat for between 1 and 52 weeks." };

  const { data, error } = await ctx.supabase.rpc("add_sessions", {
    p_service_id: serviceId,
    p_starts_at: startsAt.toISOString(),
    p_capacity: capacity,
    p_repeat_weeks: weeks,
    p_private: formData.get("private") === "on",
  });
  if (error) return { error: OOPS };
  const added = (data as number) ?? 0;
  revalidatePath(`/w/${slug}/bookings`, "layout");
  if (added === 0) return { error: "That date and time is already scheduled." };
  return {
    message:
      weeks === 1
        ? "Date added."
        : added === weeks
          ? `${added} dates added.`
          : `${added} dates added. The rest were already scheduled.`,
  };
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
  const { words } = await readEmailSettings(ctx.supabase, ctx.tenant.id);
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
    if (await sendEmail(bookingEmail("session_cancelled", details, words))) told += 1;
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
  revalidatePath(`/w/${slug}/settings`, "layout");
  return { message: "Saved." };
}

/** Saves how the date picker on the shop's product pages behaves. */
export async function saveShopPage(
  slug: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const parsed = shopPageSchema.safeParse({
    version: 1,
    product_tag: text(formData, "product_tag"),
    cutoff_hours: Number.parseInt(text(formData, "cutoff_hours") || "0", 10),
    accent: text(formData, "accent"),
    contact_url: text(formData, "contact_url"),
    contact_email: text(formData, "contact_email"),
    fallback_message: text(formData, "fallback_message"),
    hide_selector: text(formData, "hide_selector"),
  });
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    const words: Record<string, string> = {
      product_tag: "The tag can use letters, numbers, spaces, dashes and underscores.",
      cutoff_hours: "The cut-off is a number of hours, from 0 to 336 (two weeks).",
      accent: "The colour is six letters and numbers after a #, like #edc2ff.",
      contact_url: "The contact page needs a full address starting with https://.",
      contact_email: "That email address doesn't look right.",
      fallback_message: "Keep the message under 200 characters.",
      hide_selector: "That doesn't look like a CSS selector we can use.",
    };
    return { error: words[field] ?? OOPS };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: BOOKINGS_MODULE,
    p_key: SHOP_PAGE_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  revalidatePath(`/w/${slug}/bookings`, "layout");
  revalidatePath(`/w/${slug}/settings`, "layout");
  return { message: "Saved." };
}

/** Saves who gets the daily email and when. Only workspace members can be chosen. */
export async function saveDailyEmail(
  slug: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { data: members } = await ctx.supabase.rpc("list_members", { p_tenant_id: ctx.tenant.id });
  const memberIds = new Set(((members ?? []) as { user_id: string }[]).map((m) => m.user_id));
  const chosen = formData
    .getAll("recipient")
    .map(String)
    .filter((id) => memberIds.has(id));
  const parsed = dailyEmailSchema.safeParse({
    version: 1,
    on: formData.get("on") === "on",
    hour: Number.parseInt(text(formData, "hour") || "7", 10),
    recipients: [...new Set(chosen)],
  });
  if (!parsed.success) return { error: "Pick an hour, and up to 20 people." };
  if (parsed.data.on && parsed.data.recipients.length === 0) {
    return { error: "Choose at least one person to send it to." };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: BOOKINGS_MODULE,
    p_key: DAILY_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  revalidatePath(`/w/${slug}/settings`, "layout");
  return {
    message: parsed.data.on
      ? `Saved. It goes out each day from ${hourWords(parsed.data.hour)} on your workspace's clock.`
      : "Saved. The daily email is off.",
  };
}

/** Saves the "Upcoming classes" list for the shop's workshops page. */
export async function saveUpcoming(
  slug: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const parsed = upcomingSchema.safeParse({
    version: 1,
    on: formData.get("on") === "on",
    title: text(formData, "title") || "Upcoming classes",
    max_dates: Number.parseInt(text(formData, "max_dates") || "12", 10),
    show_seats_left: formData.get("show_seats_left") === "on",
    button_words: text(formData, "button_words") || "Book a place",
    empty_message: text(formData, "empty_message") || DEFAULT_UPCOMING.empty_message,
  });
  if (!parsed.success) {
    return {
      error:
        "Keep the heading under 80 characters, the button under 40, the message under 200, and show 1 to 50 dates.",
    };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: BOOKINGS_MODULE,
    p_key: UPCOMING_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  revalidatePath(`/w/${slug}/bookings`, "layout");
  revalidatePath(`/w/${slug}/settings`, "layout");
  return {
    message: parsed.data.on
      ? "Saved. Your shop shows the new list within a minute or two."
      : "Saved. The list is switched off; the snippet shows its plain message.",
  };
}

/** Ties a workshop to the shop product that sells it, or unties it. */
export async function setShopProduct(
  slug: string,
  serviceId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  // "product:variant" from the list, or the two numbers typed by hand.
  const [pickedProduct, pickedVariant] = text(formData, "pick").split(":");
  const product = (text(formData, "product_id") || pickedProduct || "").replace(/\D/g, "");
  const variant = (text(formData, "variant_id") || pickedVariant || "").replace(/\D/g, "");
  if (formData.get("intent") !== "remove" && !product) {
    return { error: "Choose the product that sells this workshop." };
  }
  const { error } = await ctx.supabase.rpc("set_service_shop_product", {
    p_service_id: serviceId,
    p_product_id: formData.get("intent") === "remove" ? null : product,
    p_variant_id: formData.get("intent") === "remove" ? null : variant || null,
  });
  if (error) {
    return {
      error: error.message.includes("product_taken")
        ? "Another workshop is already sold by that product."
        : "That didn't save. Check the numbers and try again.",
    };
  }
  revalidatePath(`/w/${slug}/bookings`, "layout");
  return { message: formData.get("intent") === "remove" ? "Removed." : "Saved." };
}

/** Saves whether shop orders that need a person are tagged, and the words. */
export async function saveShopTags(
  slug: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const parsed = shopTagsSchema.safeParse({
    version: 1,
    on: formData.get("on") === "on",
    tags: {
      oversold: text(formData, "oversold"),
      needs_date: text(formData, "needs_date"),
      booking_error: text(formData, "booking_error"),
    },
  });
  if (!parsed.success) {
    return { error: "A tag can be up to 40 characters, with no commas." };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: BOOKINGS_MODULE,
    p_key: SHOP_TAGS_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  revalidatePath(`/w/${slug}/settings`, "layout");
  return {
    message: parsed.data.on
      ? "Saved. New orders that need you are tagged in your shop from now on."
      : "Saved. Orders won't be tagged in your shop.",
  };
}
