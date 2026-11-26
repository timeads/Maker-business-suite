import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Queues a text something set off (a booking made, cancelled by a shop
 * refund, moved). The database decides whether one is wanted. Never throws.
 */
export async function queueBookingText(
  admin: SupabaseClient,
  tenantId: string,
  bookingId: string,
  kind: "confirmation" | "cancelled" | "moved",
): Promise<void> {
  try {
    const { error } = await admin.rpc("queue_booking_text", {
      p_tenant_id: tenantId,
      p_booking_id: bookingId,
      p_kind: kind,
    });
    if (error) console.error(`Could not queue a booking text: ${error.message}`);
  } catch (err) {
    console.error(
      `Could not queue a booking text: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}

/**
 * The number and tick that came with a booking (the picker's cart line, or
 * our own booking page), put on the booking just made. Only a ticked box
 * with a number is consent; the number alone is kept for the roster. Never
 * throws: the booking stands either way.
 */
export async function saveTextConsent(
  admin: SupabaseClient,
  tenantId: string,
  bookingId: string,
  consent: { phone: string; agreed: boolean },
): Promise<void> {
  const phone = consent.phone.trim().slice(0, 40);
  if (!phone) return;
  try {
    const { error } = await admin.rpc("set_booking_text_consent", {
      p_tenant_id: tenantId,
      p_booking_id: bookingId,
      p_phone: phone,
      p_opt_in: consent.agreed,
    });
    if (error) console.error(`Could not keep the text consent: ${error.message}`);
  } catch (err) {
    console.error(
      `Could not keep the text consent: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}
