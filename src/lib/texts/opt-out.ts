import type { SupabaseClient } from "@supabase/supabase-js";
import { withTenant } from "../supabase/admin";
import { toE164, type CountryKey } from "./phone";
import { readTextSettings } from "./read";

/**
 * Replies of STOP. Twilio's webhook (`/api/webhooks/twilio`) checks the
 * signature, keeps only a STOP and queues it; the worker takes the number
 * off here: every booking in that workspace with the same number stops
 * getting texts, and the number is noted so a text already waiting isn't
 * sent.
 *
 * START and other words do nothing here, as with the business's earlier
 * booking app: Twilio itself lets a number that texts START hear from the
 * sender again, but nobody is opted back in to booking texts until they tick
 * the box on a new booking.
 */

/** Twilio's standard opt-out words. The whole message must be one of them. */
const STOP_WORDS = new Set([
  "STOP",
  "STOPALL",
  "STOP ALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "OPTOUT",
  "OPT OUT",
  "REVOKE",
]);

/** Whether a reply means "no more texts". */
export function isStopWord(body: string | null | undefined): boolean {
  const word = (body ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
  return STOP_WORDS.has(word);
}

/** The bookings whose number is this one, read the way their number would be texted. */
export function matchingBookings(
  rows: { id: string; customer_phone: string }[],
  phone: string,
  country: CountryKey,
): string[] {
  return rows.filter((row) => toE164(row.customer_phone, country) === phone).map((row) => row.id);
}

type Inbound = { id: string; tenant_id: string; from_phone: string };

/** Takes off every STOP waiting. Returns how many were handled. */
export async function drainTextOptOuts(admin: SupabaseClient): Promise<number> {
  const { data, error } = await admin.rpc("claim_twilio_inbound", { p_limit: 50 });
  if (error) throw new Error(`Could not claim text replies: ${error.message}`);
  let handled = 0;
  for (const reply of (data ?? []) as Inbound[]) {
    try {
      const settings = await readTextSettings(reply.tenant_id, admin);
      // Supabase hands back at most a thousand rows, so read page by page.
      const rows: { id: string; customer_phone: string }[] = [];
      for (let from = 0; ; from += 1000) {
        const page = await withTenant(
          reply.tenant_id,
          async (scope) =>
            (
              await scope
                .select("bookings", "id, customer_phone")
                .eq("text_opt_in", true)
                .neq("customer_phone", "")
                .order("id")
                .range(from, from + 999)
            ).data as { id: string; customer_phone: string }[] | null,
          admin,
        );
        rows.push(...(page ?? []));
        if (!page || page.length < 1000) break;
      }
      const ids = matchingBookings(rows, reply.from_phone, settings.default_country);
      const { error: applyError } = await admin.rpc("apply_text_opt_out", {
        p_inbound_id: reply.id,
        p_booking_ids: ids,
      });
      if (applyError) throw new Error(applyError.message);
      handled += 1;
    } catch (err) {
      // Left as it is: the database hands it out again, and taking a number off twice changes nothing.
      console.error(`text opt-out ${reply.id}: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }
  return handled;
}
