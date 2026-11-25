"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
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
