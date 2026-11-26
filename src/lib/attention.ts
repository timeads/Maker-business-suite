import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModuleKey } from "./modules";

/**
 * How many things are waiting in each tool, for the little counts in the
 * menu. Read as the signed-in member, so nobody is told about something they
 * couldn't open. A count that fails to load is simply left out.
 */
export type Attention = Partial<Record<ModuleKey, number>> & {
  /** Social posts waiting for review, for the Review row in Social's menu. */
  socialReview?: number;
};

export async function loadAttention(
  supabase: SupabaseClient,
  tenantId: string,
  has: (key: ModuleKey) => boolean,
  now: string,
): Promise<Attention> {
  const count = (table: string) =>
    supabase.from(table).select("id", { count: "exact", head: true }).eq("tenant_id", tenantId);
  const none = Promise.resolve({ count: null as number | null, data: null });
  const [tickets, parcels, failed, chat, undated, review] = await Promise.all([
    has("helpdesk")
      ? count("tickets")
          .eq("status", "open")
          .is("merged_into", null)
          .is("folder_id", null)
          .or(`snoozed_until.is.null,snoozed_until.lte.${now}`)
      : none,
    has("shipping")
      ? count("shipping_orders")
          .gt("units_left", 0)
          .eq("cancelled", false)
          .eq("on_hold", false)
          .eq("paid", true)
          .is("picked_up_at", null)
      : none,
    has("social") ? count("social_posts").eq("status", "failed") : none,
    has("messages") ? supabase.rpc("chat_overview", { p_tenant_id: tenantId }) : none,
    // Shop orders that paid for a workshop and are still waiting for a date.
    has("bookings")
      ? count("shop_undated_lines")
          .is("booking_id", null)
          .is("dismissed_at", null)
          .gt("seats", 0)
          .eq("order_cancelled", false)
      : none,
    has("social") ? count("social_posts").eq("status", "draft").eq("review", "waiting") : none,
  ]);
  const unread = ((chat.data ?? []) as { unread?: number }[]).reduce(
    (n, row) => n + Number(row.unread ?? 0),
    0,
  );
  const out: Attention = {};
  if (tickets.count) out.helpdesk = tickets.count;
  if (parcels.count) out.shipping = parcels.count;
  if (failed.count) out.social = failed.count;
  if (unread) out.messages = unread;
  if (undated.count) out.bookings = undated.count;
  if (review.count) out.socialReview = review.count;
  return out;
}
