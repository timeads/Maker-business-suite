"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { dateChangedEmail } from "@/lib/bookings/emails";
import { parseClock, zonedTimeToUtc } from "@/lib/bookings/slots";
import { sendEmail } from "@/lib/email";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import type { BookingsState } from "./actions";

const NO_ACCESS = "Bookings aren't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can do that.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Everything here changes how many places a date has: owners and admins only. */
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

const done = (slug: string) => {
  revalidatePath(`/w/${slug}/bookings`, "layout");
  revalidatePath(`/w/${slug}/settings`, "layout");
};

/** Our words for what the database said no to. */
function sharedRefusal(message: string): string {
  const below = /below_booked:(\d+)/.exec(message);
  if (below) {
    return `${below[1]} places are already taken across these classes, so the shared limit can't be lower than that.`;
  }
  if (message.includes("not_same_time")) {
    return "Those classes don't run at the same time, so they can't share places.";
  }
  if (message.includes("already_shared")) {
    return "One of those dates already shares its places with another class.";
  }
  if (message.includes("date_over")) {
    return "That date has already happened or was cancelled.";
  }
  if (message.includes("bad_limit")) return "How many places do they share? Between 1 and 1,000.";
  return OOPS;
}

const limitFrom = (formData: FormData) =>
  Number.parseInt(String(formData.get("limit") ?? "").trim(), 10);

/** Ties this date to one that runs at the same time, under one combined limit. */
export async function shareSeats(
  slug: string,
  sessionId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const others = formData
    .getAll("with")
    .map(String)
    .filter((id) => ID.test(id));
  if (others.length === 0) return { error: "Pick the class that shares the room." };
  const limit = limitFrom(formData);
  if (!(limit >= 1 && limit <= 1000)) return { error: "How many places do they share?" };
  const { error } = await ctx.supabase.rpc("share_session_seats", {
    p_session_ids: [sessionId, ...others],
    p_capacity: limit,
  });
  if (error) return { error: sharedRefusal(error.message) };
  done(slug);
  return { message: `They now share ${limit} places between them.` };
}

/** Changes how many places the classes share. */
export async function saveSharedLimit(
  slug: string,
  groupId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const limit = limitFrom(formData);
  if (!(limit >= 1 && limit <= 1000)) return { error: "How many places do they share?" };
  const { error } = await ctx.supabase.rpc("set_shared_limit", {
    p_group_id: groupId,
    p_capacity: limit,
  });
  if (error) return { error: sharedRefusal(error.message) };
  done(slug);
  return { message: "Saved." };
}

/** Unties the classes: each goes back to its own limit alone. */
export async function unshareSeats(
  slug: string,
  groupId: string,
  _prev: BookingsState,
  _formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("unshare_session_seats", { p_group_id: groupId });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Done. Each class has its own places again." };
}

const MOVE_REFUSALS: Record<string, string> = {
  in_the_past: "Pick a time in the future.",
  already_started: "This date has already started, so its time can't be changed.",
  date_cancelled: "This date was cancelled.",
  date_taken: "This workshop already has a date at that time.",
  shared_apart:
    "This date shares its places with a class at the same time. Stop sharing first, or pick a time that still overlaps.",
  not_a_workshop: "Only workshop dates can be moved here.",
};
const refusal = (message: string, words: Record<string, string>) =>
  Object.entries(words).find(([code]) => message.includes(code))?.[1] ?? OOPS;

/**
 * Moves the whole date to a new day or time. Everyone keeps their place. A
 * reminder already sent for this date isn't sent again for the new time;
 * one not sent yet goes out before the new start. With the box ticked,
 * everyone booked is emailed the new time, once per address.
 */
export async function moveDate(
  slug: string,
  sessionId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const day = String(formData.get("day") ?? "").trim();
  const minutes = parseClock(String(formData.get("time") ?? "").trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || minutes === null) {
    return { error: "Pick the new date and start time." };
  }
  const startsAt = zonedTimeToUtc(day, minutes, ctx.tenant.timezone);
  if (!startsAt) {
    return { error: "That time doesn't exist on that day (the clocks change). Pick another." };
  }

  const { data: before } = await ctx.supabase
    .from("sessions")
    .select("starts_at, ends_at, services(name, location)")
    .eq("id", sessionId)
    .eq("tenant_id", ctx.tenant.id)
    .maybeSingle();
  if (!before) return { error: "That date couldn't be found." };

  const { data, error } = await ctx.supabase.rpc("move_session", {
    p_session_id: sessionId,
    p_starts_at: startsAt.toISOString(),
  });
  if (error) return { error: refusal(error.message, MOVE_REFUSALS) };
  const result = (data ?? {}) as { moved?: boolean; people?: number };
  done(slug);
  if (!result.moved) return { message: "That's the time it already has." };

  let told = 0;
  if (formData.get("tell") === "on") {
    const { data: after } = await ctx.supabase
      .from("sessions")
      .select("starts_at, ends_at, bookings(customer_name, customer_email, status, email_opt_in)")
      .eq("id", sessionId)
      .eq("tenant_id", ctx.tenant.id)
      .maybeSingle();
    const service = before.services as unknown as { name: string; location: string };
    const people = (
      (after?.bookings ?? []) as {
        customer_name: string;
        customer_email: string;
        status: string;
        email_opt_in: boolean;
      }[]
    ).filter((b) => b.status === "confirmed" && b.email_opt_in && b.customer_email);
    const unique = [...new Map(people.map((p) => [p.customer_email, p])).values()];
    for (const person of unique) {
      const sent = await sendEmail(
        dateChangedEmail(
          person,
          {
            service_name: service.name,
            workspace_name: ctx.tenant.name,
            starts_at: (after?.starts_at as string) ?? startsAt.toISOString(),
            ends_at: (after?.ends_at as string) ?? startsAt.toISOString(),
            timezone: ctx.tenant.timezone,
            location: service.location,
          },
          { starts_at: before.starts_at as string, ends_at: before.ends_at as string },
        ),
      );
      if (sent) told += 1;
    }
  }
  const people = result.people ?? 0;
  return {
    message: [
      "Moved. Everyone booked keeps their place.",
      people === 0
        ? ""
        : told > 0
          ? `${told === 1 ? "1 person was" : `${told} people were`} emailed the new time.`
          : formData.get("tell") === "on"
            ? "Email isn't switched on here, so please let them know yourself."
            : "Nobody was emailed, so let them know yourself.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/** Removes a date made by mistake. Only while nobody has ever booked it. */
export async function deleteDate(
  slug: string,
  sessionId: string,
  serviceId: string,
  _prev: BookingsState,
  _formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("delete_session", { p_session_id: sessionId });
  if (error) {
    return {
      error: error.message.includes("has_bookings")
        ? "Someone has booked this date (even if they cancelled since), so it can't be deleted. You can cancel it instead."
        : OOPS,
    };
  }
  done(slug);
  redirect(`/w/${slug}/bookings/services/${serviceId}`);
}

/** Raises the date's limit, and its shared room's, so everyone booked fits. */
export async function raiseToFit(
  slug: string,
  sessionId: string,
  _prev: BookingsState,
  _formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { data, error } = await ctx.supabase.rpc("raise_limit_to_fit", {
    p_session_id: sessionId,
  });
  if (error) return { error: OOPS };
  const result = (data ?? {}) as { capacity?: number; shared_capacity?: number | null };
  done(slug);
  return {
    message:
      result.shared_capacity != null
        ? `Done: this date now has ${result.capacity} places, and the shared room ${result.shared_capacity}.`
        : `Done: this date now has ${result.capacity} places.`,
  };
}
