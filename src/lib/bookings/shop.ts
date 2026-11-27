import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ShopBookingOrder } from "../connections/types";
import { postAlert } from "../messages/alerts";
import { moduleOpen } from "../module-access";
import { announceBooking, getBookingDetails } from "./server";
import { queueOrderTag } from "./shop-tags";
import { queueBookingText, saveTextConsent } from "../texts/queue";

/**
 * Bookings that come in as shop orders. The shop owns the price and the
 * payment; an order whose lines name workshop dates becomes bookings here.
 * Everything is safe to run again for the same order, because the shop tells
 * us about an order many times over its life.
 */

type Result = {
  result:
    | "booked"
    /**
     * From the shop's history (a class already started, or an order placed
     * before the workshop or its date was here): written down for the
     * roster, and nothing is ever sent to its customer by itself.
     */
    | "recorded"
    | "resized"
    | "cancelled"
    | "unchanged"
    | "nothing"
    | "no_session"
    /** A new line names a date where this order's moved booking already sits. */
    | "clash";
  booking_id?: string;
  oversold?: boolean;
  date_cancelled?: boolean;
};

/**
 * Queues the "your booking was cancelled" email for bookings the shop just
 * cancelled. The database decides whether one is wanted (the workspace's
 * switch, a date still to come, emails on for that person) and the worker
 * sends it with the reminders. Never throws: the cancellation stands.
 */
export async function queueCancelEmails(
  admin: SupabaseClient,
  tenantId: string,
  bookingIds: string[],
): Promise<void> {
  for (const id of bookingIds) {
    try {
      const { error } = await admin.rpc("queue_booking_cancel_email", {
        p_tenant_id: tenantId,
        p_booking_id: id,
      });
      if (error) console.error(`Could not queue cancellation email: ${error.message}`);
      await queueBookingText(admin, tenantId, id, "cancelled");
    } catch (err) {
      console.error(
        `Could not queue cancellation email: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
  }
}

export async function applyShopOrders(
  admin: SupabaseClient,
  tenantId: string,
  orders: ShopBookingOrder[],
  deps: {
    open?: (tenantId: string) => Promise<boolean>;
    announce?: typeof announceBooking;
    details?: typeof getBookingDetails;
    tag?: typeof queueOrderTag;
  } = {},
): Promise<void> {
  if (orders.length === 0) return;
  // A paid booking is never dropped, plan or no plan; only the emails wait.
  const open = await (deps.open ?? ((id) => moduleOpen(id, "bookings")))(tenantId);
  const tag = deps.tag ?? queueOrderTag;
  for (const order of orders) {
    if (order.cancelled) {
      const { data, error } = await admin.rpc("cancel_shop_order_bookings", {
        p_tenant_id: tenantId,
        p_order_id: order.external_id,
      });
      if (error) throw new Error(`cancel_shop_order_bookings failed: ${error.message}`);
      if (open) await queueCancelEmails(admin, tenantId, (data ?? []) as string[]);
      continue;
    }
    for (const line of order.lines) {
      const token = randomBytes(24).toString("base64url");
      const { data, error } = await admin.rpc("book_from_shop", {
        p_tenant_id: tenantId,
        p_session_id: line.session_id,
        p_order_id: order.external_id,
        p_order_name: order.name,
        p_name: order.customer_name,
        p_email: order.email ?? "",
        p_seats: line.seats,
        p_amount_cents: line.amount_cents,
        p_manage_token: token,
      });
      if (error) throw new Error(`book_from_shop failed: ${error.message}`);
      const outcome = data as Result;
      // A date we can't find is not dropped: the sync hands every line to
      // `noteShopOrderLines` next, which writes it down under "Needs a date"
      // and tells the team once. In the shop it is tagged, as before.
      if (outcome.result === "no_session") {
        await tag(admin, tenantId, { id: order.external_id, name: order.name }, "booking_error");
        continue;
      }
      // A booking is known by the order's lines, wherever it was moved to. A
      // new line for a date the order's moved booking already sits on can't
      // be a second booking there, and a paid place is never dropped: a
      // person is told, and the order tagged as a booking problem.
      if (outcome.result === "clash") {
        await tag(admin, tenantId, { id: order.external_id, name: order.name }, "booking_error");
        await postAlert(
          admin,
          tenantId,
          "bookings",
          `Order ${order.name} in your shop has a new line for a date where its booking (moved there earlier) already sits, so the new places aren't booked yet. Open that date's roster and add them, or refund the line.`,
        );
        continue;
      }
      // A refund took the last place: the customer is told, where that is switched on.
      if (outcome.result === "cancelled" && outcome.booking_id && open) {
        await queueCancelEmails(admin, tenantId, [outcome.booking_id]);
      }
      if (outcome.result !== "booked" || !outcome.booking_id) continue;
      // The number and tick from the picker travel with the booking, before
      // the confirmation (and its text) goes.
      if (line.text) await saveTextConsent(admin, tenantId, outcome.booking_id, line.text);
      // The shop's order carries a tag for a person to sort it out, like the
      // earlier app did. Queued once; added only where the shop allows it.
      if (outcome.oversold && !outcome.date_cancelled) {
        await tag(admin, tenantId, { id: order.external_id, name: order.name }, "oversold");
      }
      if (outcome.date_cancelled) {
        await tag(admin, tenantId, { id: order.external_id, name: order.name }, "booking_error");
        await postAlert(
          admin,
          tenantId,
          "bookings",
          `Order ${order.name} in your shop booked a date that had been cancelled. The person is on the list; move them or refund the order.`,
        );
      }
      if (!open) continue;
      try {
        const details = await (deps.details ?? getBookingDetails)(
          { tenantId, bookingId: outcome.booking_id },
          admin,
        );
        // No email on the order means nobody to write to; the team still hears.
        if (details)
          await (deps.announce ?? announceBooking)(details, order.email ? token : "", admin);
      } catch (err) {
        // The booking stands; an email that didn't go must not undo the sync.
        console.error(
          `Could not announce shop booking: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }
    }
  }
}
