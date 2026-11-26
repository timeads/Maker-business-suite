import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * Tags on shop orders that need a person, added in the shop at the same
 * moments the business's earlier booking app added them:
 *
 *   - oversold: a paid order booked a date that was already full
 *   - needs_date: a workshop was paid for with no date on the cart line
 *   - booking_error: the date on the line can't be found, or was cancelled
 *
 * The words are a config (module "bookings", key "shop_tags"); the standard
 * ones are the earlier app's, and the database holds the same three
 * (`private.shop_tag_for`, kept in step by a test). The tag itself is added
 * by the worker through the once-only queue (`shop_order_tags`), only ever
 * added, and only for a shop connected with permission to change orders.
 */
export const SHOP_TAGS_KEY = "shop_tags";

export type TagReason = "oversold" | "needs_date" | "booking_error";
export const TAG_REASONS: TagReason[] = ["oversold", "needs_date", "booking_error"];

/** The earlier booking app's own words; `private.shop_tag_for` holds the same. */
export const STANDARD_TAGS: Record<TagReason, string> = {
  oversold: "ttw-oversold",
  needs_date: "ttw-needs-date",
  booking_error: "ttw-booking-error",
};

/** What a shop takes as one tag: no commas (they separate tags), 40 characters at most. */
const TAG = z
  .string()
  .trim()
  .max(40)
  .regex(/^[^,<>]*$/, "A tag can't hold a comma");

export const shopTagsSchema = z.object({
  version: z.literal(1),
  /** Add tags at all. On unless switched off; nothing happens without the shop's permission. */
  on: z.boolean().default(true),
  /** A word left empty uses the standard one. */
  tags: z
    .object({
      oversold: TAG.default(""),
      needs_date: TAG.default(""),
      booking_error: TAG.default(""),
    })
    .default({ oversold: "", needs_date: "", booking_error: "" }),
});
export type ShopTags = z.infer<typeof shopTagsSchema>;

export const DEFAULT_SHOP_TAGS: ShopTags = shopTagsSchema.parse({ version: 1 });

export function parseShopTags(body: unknown): ShopTags {
  const parsed = shopTagsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_SHOP_TAGS;
}

/** The word that goes on an order for a reason. */
export function tagFor(settings: ShopTags, reason: TagReason): string {
  return settings.tags[reason].trim() || STANDARD_TAGS[reason];
}

/** Plain words for each reason, for the settings screen and the list. */
export const REASON_WORDS: Record<TagReason, string> = {
  oversold: "Booked into a date that was already full",
  needs_date: "Paid for a workshop with no date on it",
  booking_error: "Named a date we couldn't book (not found, or cancelled)",
};

/** Whether a shop connection may change orders, from the scopes it was granted. */
export const canTagInShopify = (scopes: unknown): boolean =>
  Array.isArray(scopes) && scopes.includes("write_orders");

/**
 * Queues one tag for one order. The database decides (once per order and
 * reason, the workspace's switch, the shop's permission) and nothing here
 * may stop a sync: a failure is logged and the booking stands.
 */
export async function queueOrderTag(
  admin: SupabaseClient,
  tenantId: string,
  order: { id: string; name: string },
  reason: TagReason,
  provider = "shopify",
): Promise<void> {
  try {
    const { error } = await admin.rpc("queue_shop_order_tag", {
      p_tenant_id: tenantId,
      p_provider: provider,
      p_order_id: order.id,
      p_order_name: order.name,
      p_reason: reason,
    });
    if (error) console.error(`Could not queue an order tag: ${error.message}`);
  } catch (err) {
    console.error(
      `Could not queue an order tag: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}
