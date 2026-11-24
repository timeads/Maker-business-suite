/**
 * What became of telling the shop about something, in words for the page.
 * The telling itself is the worker's (see `shopify-fulfil.ts`); these are
 * only the statuses it leaves behind.
 */

/** `shipments.shop_undo_status`: undoing a voided parcel in the shop. */
export type UndoStatus =
  "none" | "pending" | "sending" | "done" | "not_found" | "not_allowed" | "failed";

export type StepWords = {
  tone: "good" | "waiting" | "bad";
  text: string;
  /** More, for whoever wants to know why. */
  detail: string | null;
};

/** What to say on a voided parcel about the shop. Null: the shop was never told it went. */
export function undoWords(status: unknown, error?: string | null): StepWords | null {
  switch (status) {
    case "pending":
    case "sending":
      return { tone: "waiting", text: "Marking it unfulfilled in your shop…", detail: null };
    case "done":
      return { tone: "good", text: "Marked unfulfilled in your shop", detail: null };
    case "not_found":
      return {
        tone: "bad",
        text: "Couldn't undo it in your shop: do that there",
        detail: "Your shop has no fulfilment with this parcel's tracking number.",
      };
    case "not_allowed":
      return {
        tone: "bad",
        text: "Couldn't undo it in your shop: do that there",
        detail: "Your shop is connected without permission to change orders.",
      };
    case "failed":
      return {
        tone: "bad",
        text: "Couldn't undo it in your shop: do that there",
        detail: error ? `Your shop said: ${error}` : null,
      };
    default:
      return null;
  }
}

/**
 * Whether the next pickup step will reach the shop: "yes", "no_permission"
 * (the workspace wants it, the shop won't take it) or "off" (the workspace
 * keeps pickups to itself, or the order isn't from a shop we can tell).
 */
export function pickupTells(facts: {
  /** The workspace's "Tell my shop about pickups". */
  wanted: boolean;
  /** The shop is connected with permission to change fulfilments. */
  canSend: boolean;
  /** A shop is connected at all. */
  connected: boolean;
}): "yes" | "no_permission" | "off" {
  if (!facts.wanted || !facts.connected) return "off";
  return facts.canSend ? "yes" : "no_permission";
}
