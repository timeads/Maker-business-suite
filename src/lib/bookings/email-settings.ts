import type { SupabaseClient } from "@supabase/supabase-js";
import { BOOKINGS_MODULE, EMAILS_KEY, parseBookingEmails, type BookingEmails } from "./config";
import { WORDS_KEY, parseEmailWords, type EmailWords } from "./words";

/**
 * The two booking email configs, read as the signed-in member: when the
 * emails go and the notes added to them (`emails`), and the business's own
 * words and reply-to address (`email_words`). Anything unreadable reads as
 * our defaults, so an email is never held up by its settings.
 */
export async function readEmailSettings(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<{ timing: BookingEmails; words: EmailWords }> {
  const { data } = await supabase
    .from("configs")
    .select("key, body")
    .eq("tenant_id", tenantId)
    .eq("module", BOOKINGS_MODULE)
    .in("key", [EMAILS_KEY, WORDS_KEY]);
  const body = (key: string) =>
    ((data ?? []) as { key: string; body: unknown }[]).find((row) => row.key === key)?.body;
  return { timing: parseBookingEmails(body(EMAILS_KEY)), words: parseEmailWords(body(WORDS_KEY)) };
}
