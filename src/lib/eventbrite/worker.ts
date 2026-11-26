import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { announceBooking, getBookingDetails } from "../bookings/server";
import { queueCancelEmails } from "../bookings/shop";
import type { TokenDeps } from "../connections/tokens";
import { postAlert } from "../messages/alerts";
import { featureOpen } from "../module-access";
import { getEventbriteAccess } from "./access";
import { planTicketClass } from "./capacity";
import {
  EventbriteError,
  createEventbriteClient,
  type EventbriteAccess,
  type EventbriteClient,
} from "./client";
import { isReleaseOrder, orderToBooking } from "./orders";

/**
 * The worker's two Eventbrite jobs:
 *
 *   - pushing places left to each linked date's ticket type (claimed once,
 *     tried once, written down with `finish_eventbrite_push`);
 *   - reading orders Eventbrite told us about and booking them with
 *     `book_from_eventbrite`.
 *
 * Nothing here is sent to a customer except the usual booking emails, which
 * go the way a shop order's do.
 */

export type ClaimedPush = {
  id: string;
  tenant_id: string;
  session_id: string;
  event_id: string;
  ticket_class_id: string;
  event_name: string;
  tries: number;
  seats_left: number;
};

export type PushResult = {
  outcome: "done" | "refused" | "unsure";
  detail: string;
  total?: number;
  sold?: number;
  hidden?: boolean;
};

/** Tries a refusal gets by itself before it waits for a manager (the database's number). */
export const PUSH_TRIES = 3;

function reading(err: unknown): string {
  if (err instanceof EventbriteError) {
    if (err.isAuthError) {
      return "Eventbrite didn't accept your token. Reconnect Eventbrite under Connections.";
    }
    if (err.isNotFound) {
      return "Eventbrite has no such ticket type on that event any more. Link the date again.";
    }
    return `We couldn't read the ticket type from Eventbrite: ${err.words}`;
  }
  return "We couldn't read the ticket type from Eventbrite.";
}

/**
 * One push: read the ticket type afresh, work out what it should say, and
 * change it only when it differs. A failed read changes nothing (refused);
 * a write Eventbrite said no to changed nothing (refused); a write with no
 * clear answer may have gone through (unsure).
 */
export async function pushSeats(push: ClaimedPush, client: EventbriteClient): Promise<PushResult> {
  let tc;
  try {
    tc = await client.getTicketClass(push.event_id, push.ticket_class_id);
  } catch (err) {
    return { outcome: "refused", detail: reading(err) };
  }
  const plan = planTicketClass(tc, push.seats_left);
  const figures = { total: plan.total, sold: tc.quantitySold, hidden: plan.hidden };
  if (!plan.change) return { outcome: "done", detail: "", ...figures };
  try {
    await client.updateTicketClass(push.event_id, push.ticket_class_id, plan.change);
  } catch (err) {
    if (err instanceof EventbriteError && err.applied === "no") {
      return {
        outcome: "refused",
        detail: err.isAuthError
          ? "Eventbrite didn't accept your token. Reconnect Eventbrite under Connections."
          : `Eventbrite said no: ${err.words}`,
        total: tc.quantityTotal,
        sold: tc.quantitySold,
        hidden: tc.hidden,
      };
    }
    return {
      outcome: "unsure",
      detail:
        err instanceof EventbriteError
          ? `We asked Eventbrite to change the tickets and didn't get a clear answer (${err.words}).`
          : "We asked Eventbrite to change the tickets and didn't get a clear answer.",
    };
  }
  return { outcome: "done", detail: "", ...figures };
}

export type WorkerDeps = {
  tokenDeps?: TokenDeps;
  access?: (tenantId: string) => Promise<EventbriteAccess>;
  client?: (access: EventbriteAccess) => EventbriteClient;
  open?: (tenantId: string) => Promise<boolean>;
  alert?: typeof postAlert;
  announce?: typeof announceBooking;
  details?: typeof getBookingDetails;
  cancelEmails?: typeof queueCancelEmails;
};

function clientsFor(admin: SupabaseClient, deps: WorkerDeps) {
  const cache = new Map<string, Promise<EventbriteClient>>();
  return (tenantId: string) => {
    let found = cache.get(tenantId);
    if (!found) {
      found = (deps.access ?? ((id) => getEventbriteAccess(id, deps.tokenDeps)))(tenantId).then(
        (access) => (deps.client ?? ((a) => createEventbriteClient(a)))(access),
      );
      // A failed lookup isn't kept: the next item asks again.
      found.catch(() => cache.delete(tenantId));
      cache.set(tenantId, found);
    }
    return found;
  };
}

/** Pushes places left for every date due one. Returns how many were handled. */
export async function drainEventbritePushes(
  admin: SupabaseClient,
  deps: WorkerDeps = {},
): Promise<number> {
  const { data, error } = await admin.rpc("claim_eventbrite_pushes", { p_limit: 20 });
  if (error) throw new Error(`Could not claim Eventbrite pushes: ${error.message}`);
  const pushes = (data ?? []) as ClaimedPush[];
  if (pushes.length === 0) return 0;
  const clientFor = clientsFor(admin, deps);
  const open = deps.open ?? ((id: string) => featureOpen(id, "eventbrite", admin));
  const alert = deps.alert ?? postAlert;
  for (const push of pushes) {
    let result: PushResult;
    if (!(await open(push.tenant_id))) {
      result = {
        outcome: "refused",
        detail: "Eventbrite isn't part of this workspace's plan right now.",
      };
    } else {
      try {
        result = await pushSeats(push, await clientFor(push.tenant_id));
      } catch {
        // No token to read with: nothing was asked of Eventbrite.
        result = {
          outcome: "refused",
          detail: "Eventbrite isn't connected right now. Reconnect it under Connections.",
        };
      }
    }
    const { error: finishError } = await admin.rpc("finish_eventbrite_push", {
      p_id: push.id,
      p_outcome: result.outcome,
      p_detail: result.detail,
      p_total: result.total ?? null,
      p_sold: result.sold ?? null,
      p_hidden: result.hidden ?? null,
      p_seats_left: push.seats_left,
    });
    if (finishError)
      console.error(`could not finish Eventbrite push ${push.id}: ${finishError.message}`);
    const event = push.event_name ? `“${push.event_name}”` : "a linked event";
    if (result.outcome === "unsure") {
      await alert(
        admin,
        push.tenant_id,
        "bookings",
        `We may not have kept the places on Eventbrite in step for ${event}: ${result.detail} Check the tickets there, then press “Try again” on the date.`,
      );
    } else if (result.outcome === "refused" && push.tries >= PUSH_TRIES) {
      await alert(
        admin,
        push.tenant_id,
        "bookings",
        `We couldn't keep the places on Eventbrite in step for ${event}: ${result.detail} Press “Try again” on the date once it's sorted.`,
      );
    }
  }
  return pushes.length;
}

export type ClaimedOrder = {
  id: string;
  tenant_id: string;
  order_id: string;
  refunded: boolean;
  tries: number;
};

type BookResult = {
  result: "booked" | "resized" | "cancelled" | "unchanged" | "nothing" | "no_listing";
  booking_id?: string;
  oversold?: boolean;
  date_cancelled?: boolean;
  cancelled?: string[];
};

/** Past this many reads, an order is given up on and the team is told. */
export const ORDER_TRIES = 6;

/** Reads the orders Eventbrite told us about and books them. Returns how many were handled. */
export async function drainEventbriteOrders(
  admin: SupabaseClient,
  deps: WorkerDeps = {},
): Promise<number> {
  const { data, error } = await admin.rpc("claim_eventbrite_events", { p_limit: 20 });
  if (error) throw new Error(`Could not claim Eventbrite orders: ${error.message}`);
  const orders = (data ?? []) as ClaimedOrder[];
  if (orders.length === 0) return 0;
  const clientFor = clientsFor(admin, deps);
  const alert = deps.alert ?? postAlert;
  const finish = async (id: string, outcome: "done" | "retry" | "failed", detail: string) => {
    const { error: finishError } = await admin.rpc("finish_eventbrite_event", {
      p_id: id,
      p_outcome: outcome,
      p_detail: detail,
    });
    if (finishError)
      console.error(`could not finish Eventbrite order ${id}: ${finishError.message}`);
  };

  for (const each of orders) {
    if (each.tries > ORDER_TRIES) {
      await finish(each.id, "failed", "Too many tries");
      await alert(
        admin,
        each.tenant_id,
        "bookings",
        `We couldn't read Eventbrite order ${each.order_id}, so it isn't on a date here yet. Look it up in Eventbrite and add the person to the date yourself.`,
      );
      continue;
    }
    let order;
    try {
      order = await (await clientFor(each.tenant_id)).getOrder(each.order_id);
    } catch (err) {
      // An order Eventbrite no longer has can never be read: nothing to book.
      if (err instanceof EventbriteError && err.isNotFound) {
        await finish(each.id, "done", "gone");
      } else {
        await finish(
          each.id,
          "retry",
          err instanceof EventbriteError ? err.words : "Couldn't reach Eventbrite",
        );
      }
      continue;
    }
    const input = orderToBooking(order);
    if (input.orderId !== each.order_id) {
      await finish(each.id, "failed", "Eventbrite answered with a different order");
      continue;
    }
    const token = randomBytes(24).toString("base64url");
    const { data: booked, error: bookError } = await admin.rpc("book_from_eventbrite", {
      p_tenant_id: each.tenant_id,
      p_event_id: input.eventId ?? "",
      p_order_id: input.orderId,
      p_name: input.name,
      p_email: input.email,
      p_phone: input.phone,
      p_seats: isReleaseOrder(order, each.refunded) ? 0 : input.seats,
      p_manage_token: token,
    });
    if (bookError) {
      console.error(`book_from_eventbrite failed: ${bookError.message}`);
      await finish(each.id, "retry", "Couldn't save the booking");
      continue;
    }
    const outcome = booked as BookResult;
    await finish(each.id, "done", outcome.result);
    await afterBooking(admin, each, outcome, token, input.email, deps, alert);
  }
  return orders.length;
}

async function afterBooking(
  admin: SupabaseClient,
  each: ClaimedOrder,
  outcome: BookResult,
  token: string,
  email: string,
  deps: WorkerDeps,
  alert: typeof postAlert,
) {
  const open = await (deps.open ?? ((id: string) => featureOpen(id, "eventbrite", admin)))(
    each.tenant_id,
  );
  if (outcome.result === "no_listing") {
    await alert(
      admin,
      each.tenant_id,
      "bookings",
      `Eventbrite order ${each.order_id} is for an event that isn't linked to a date here, so nobody was added. Link the event to its date, or add the person yourself.`,
    );
    return;
  }
  if (outcome.result === "nothing") {
    // A refund or cancellation for an order that is on no date here (one
    // brought across from the earlier app, say): the team gives the place back.
    await alert(
      admin,
      each.tenant_id,
      "bookings",
      `Eventbrite order ${each.order_id} was refunded or cancelled, but it isn't on any date here. If you added the person yourself, take them off the date.`,
    );
    return;
  }
  if (outcome.result === "cancelled" && open) {
    await (deps.cancelEmails ?? queueCancelEmails)(admin, each.tenant_id, outcome.cancelled ?? []);
    return;
  }
  if (outcome.result !== "booked" || !outcome.booking_id) return;
  if (outcome.date_cancelled) {
    await alert(
      admin,
      each.tenant_id,
      "bookings",
      `Eventbrite order ${each.order_id} booked a date that had been cancelled. The person is on the list; move them or refund the order on Eventbrite.`,
    );
  }
  if (!open) return;
  try {
    const details = await (deps.details ?? getBookingDetails)(
      { tenantId: each.tenant_id, bookingId: outcome.booking_id },
      admin,
    );
    // The confirmation and the team's heads-up, as for a shop order. No email
    // on the order means nobody to write to; the team still hears.
    if (details) await (deps.announce ?? announceBooking)(details, email ? token : "", admin);
  } catch (err) {
    // The booking stands; an email that didn't go must not undo it.
    console.error(
      `Could not announce Eventbrite booking: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}
