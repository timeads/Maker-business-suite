"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { getEventbriteAccess } from "@/lib/eventbrite/access";
import { EventbriteError, createEventbriteClient } from "@/lib/eventbrite/client";
import { pickTicketClass } from "@/lib/eventbrite/events";
import { hookEndpoint, hookTokenHash, newHookToken, tokensAtSite } from "@/lib/eventbrite/hook";
import { ORDER_ACTIONS } from "@/lib/eventbrite/orders";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import type { BookingsState } from "./actions";

const NO_ACCESS = "Eventbrite isn't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can change Eventbrite.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const NOT_CONNECTED = "Connect Eventbrite under Connections first.";
const OOPS = "That didn't save. Please try again.";
const ID = /^[0-9a-f-]{36}$/i;

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/settings/bookings/eventbrite`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.bookings") || !entitlements.can("eventbrite")) {
    return { error: NO_ACCESS } as const;
  }
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (!canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}

function refresh(slug: string) {
  revalidatePath(`/w/${slug}/settings`, "layout");
  revalidatePath(`/w/${slug}/bookings`, "layout");
}

/** What Eventbrite said, in our words, for a person. */
function eventbriteWords(err: unknown): string {
  if (err instanceof EventbriteError) {
    if (err.isAuthError) {
      return "Eventbrite didn't accept your token. Reconnect Eventbrite under Connections.";
    }
    if (err.applied === "unknown") {
      return "We didn't hear back from Eventbrite. Press again in a moment: we look at what it has before asking for anything new.";
    }
    return `Eventbrite said no: ${err.words}`;
  }
  return NOT_CONNECTED;
}

/**
 * Switches order updates on: Eventbrite is given our webhook address with a
 * fresh secret in it. If Eventbrite already has this workspace's current
 * address (an earlier press whose answer we lost), that one is used rather
 * than making a second.
 */
export async function switchOnOrderUpdates(
  slug: string,
  _prev: BookingsState,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const site = await getSiteUrl();
  if (!site.startsWith("https://")) {
    return {
      error: "Order updates need this app's public https address, which this site hasn't got.",
    };
  }
  try {
    const access = await getEventbriteAccess(ctx.tenant.id);
    if (!access.organizationId) return { error: NOT_CONNECTED };
    const client = createEventbriteClient(access);
    const hooks = await client.listWebhooks(access.organizationId);
    const ours = tokensAtSite(
      site,
      hooks.map((h) => h.endpointUrl),
    );
    if (ours.length > 0) {
      const { data: matches, error } = await ctx.supabase.rpc("eventbrite_hook_matches", {
        p_tenant_id: ctx.tenant.id,
        p_token_hashes: ours.map(hookTokenHash),
      });
      if (error) return { error: OOPS };
      if (matches === true) {
        const found = hooks.find((h) => ours.some((t) => h.endpointUrl.endsWith(t)));
        const { error: finishError } = await ctx.supabase.rpc("finish_eventbrite_hook", {
          p_tenant_id: ctx.tenant.id,
          p_webhook_id: found?.id ?? null,
        });
        if (finishError) return { error: OOPS };
        refresh(slug);
        return { message: "Order updates are on." };
      }
    }
    const token = newHookToken();
    const { error: beginError } = await ctx.supabase.rpc("begin_eventbrite_hook", {
      p_tenant_id: ctx.tenant.id,
      p_token_hash: hookTokenHash(token),
    });
    if (beginError) return { error: OOPS };
    const webhookId = await client.createWebhook(
      access.organizationId,
      hookEndpoint(site, token),
      ORDER_ACTIONS,
    );
    const { error: finishError } = await ctx.supabase.rpc("finish_eventbrite_hook", {
      p_tenant_id: ctx.tenant.id,
      p_webhook_id: webhookId || null,
    });
    if (finishError) return { error: OOPS };
  } catch (err) {
    console.error(
      `Eventbrite order updates: ${err instanceof EventbriteError ? err.message : "not connected"}`,
    );
    return { error: eventbriteWords(err) };
  }
  refresh(slug);
  return { message: "Order updates are on. New orders on linked events will arrive as bookings." };
}

/** Which workshops may be sold on Eventbrite: one tick each. */
export async function saveEventbriteWorkshops(
  slug: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const ids = formData
    .getAll("service")
    .map(String)
    .filter((id) => ID.test(id))
    .slice(0, 200);
  const { data: rows } = await ctx.supabase
    .from("services")
    .select("id, eventbrite_on")
    .eq("tenant_id", ctx.tenant.id)
    .eq("kind", "workshop")
    .in("id", ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"]);
  for (const row of (rows ?? []) as { id: string; eventbrite_on: boolean }[]) {
    const on = formData.get(`on_${row.id}`) === "on";
    if (on === row.eventbrite_on) continue;
    const { error } = await ctx.supabase.rpc("set_service_eventbrite", {
      p_service_id: row.id,
      p_on: on,
    });
    if (error) return { error: OOPS };
  }
  refresh(slug);
  return { message: "Saved." };
}

/**
 * Links a date to one of the business's live Eventbrite events, or unlinks
 * it. The event is looked up on Eventbrite again here, so only an event the
 * account really has can be linked, with its own name and ticket types.
 */
export async function linkDateToEvent(
  slug: string,
  sessionId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!ID.test(sessionId)) return { error: OOPS };
  const eventId = String(formData.get("event") ?? "").trim();
  if (!eventId) {
    const { error } = await ctx.supabase.rpc("link_session_eventbrite", {
      p_session_id: sessionId,
      p_event_id: null,
      p_ticket_class_id: null,
      p_event_name: null,
    });
    if (error) return { error: OOPS };
    refresh(slug);
    return { message: "Unlinked. Orders already booked stay on the date." };
  }
  let event;
  try {
    const access = await getEventbriteAccess(ctx.tenant.id);
    if (!access.organizationId) return { error: NOT_CONNECTED };
    event = (await createEventbriteClient(access).listEvents(access.organizationId)).find(
      (e) => e.id === eventId,
    );
  } catch (err) {
    return { error: eventbriteWords(err) };
  }
  if (!event) {
    return { error: "That event isn't on sale on Eventbrite any more. Pick another." };
  }
  const ticket = pickTicketClass(event, String(formData.get("ticket") ?? "") || null);
  const { error } = await ctx.supabase.rpc("link_session_eventbrite", {
    p_session_id: sessionId,
    p_event_id: event.id,
    p_ticket_class_id: ticket,
    p_event_name: event.name,
  });
  if (error) {
    if (error.message.includes("event_taken")) {
      return { error: "That event is already linked to another date. Unlink it there first." };
    }
    if (error.message.includes("switched on")) {
      return { error: "Switch this workshop on for Eventbrite in Settings first." };
    }
    if (error.message.includes("isn't connected")) return { error: NOT_CONNECTED };
    return { error: OOPS };
  }
  refresh(slug);
  return {
    message: ticket
      ? "Linked. Places on Eventbrite are kept in step from now on."
      : "Linked. This event has no ticket type, so orders arrive but places aren't kept in step.",
  };
}

/** A manager's "Try again" for a date whose push failed or that we're unsure of. */
export async function retryEventbriteLink(
  slug: string,
  listingId: string,
  _prev: BookingsState,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!ID.test(listingId)) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("retry_eventbrite_listing", {
    p_listing_id: listingId,
  });
  if (error) {
    return {
      error: error.message.includes("nothing to try again") ? "It's already sorted." : OOPS,
    };
  }
  refresh(slug);
  return {
    message: "We'll look at the tickets on Eventbrite again in a minute and set them from there.",
  };
}
