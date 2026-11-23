import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ShopBookingOrder } from "../connections/types";
import { postAlert } from "../messages/alerts";
import { moduleOpen } from "../module-access";
import { announceBooking, getBookingDetails } from "./server";

/**
 * Bookings that come in as shop orders. The shop owns the price and the
 * payment; an order whose lines name workshop dates becomes bookings here.
 * Everything is safe to run again for the same order, because the shop tells
 * us about an order many times over its life.
 */

type Result = {
  result: "booked" | "resized" | "cancelled" | "unchanged" | "nothing" | "no_session";
  booking_id?: string;
  oversold?: boolean;
  date_cancelled?: boolean;
};

export async function applyShopOrders(
  admin: SupabaseClient,
  tenantId: string,
  orders: ShopBookingOrder[],
  deps: {
    open?: (tenantId: string) => Promise<boolean>;
    announce?: typeof announceBooking;
    details?: typeof getBookingDetails;
  } = {},
): Promise<void> {
  if (orders.length === 0) return;
  // A paid booking is never dropped, plan or no plan; only the emails wait.
  const open = await (deps.open ?? ((id) => moduleOpen(id, "bookings")))(tenantId);
  for (const order of orders) {
    if (order.cancelled) {
      const { error } = await admin.rpc("cancel_shop_order", {
        p_tenant_id: tenantId,
        p_order_id: order.external_id,
      });
      if (error) throw new Error(`cancel_shop_order failed: ${error.message}`);
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
      if (outcome.result === "no_session" && line.seats > 0) {
        await postAlert(
          admin,
          tenantId,
          "bookings",
          `Order ${order.name} in your shop was for a workshop date we can't find. Check the order and add the person to the right date by hand.`,
        );
        continue;
      }
      if (outcome.result !== "booked" || !outcome.booking_id) continue;
      if (outcome.date_cancelled) {
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
