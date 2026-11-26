import type { EventbriteTicketClass, TicketClassChange } from "./client";

/**
 * What to change on an Eventbrite ticket type so it can sell exactly the
 * places still free here. Ported from the business's earlier booking app
 * (`reconcileTicketClass`), as pure arithmetic:
 *
 *   tickets for sale = what Eventbrite has sold + places left here
 *
 * When nothing is left:
 *   - if Eventbrite has sold some, for sale = sold, so it shows "Sold out";
 *   - if it has sold none, that would be 0, which Eventbrite won't take, so
 *     the ticket is hidden instead.
 * When places free up again, a ticket we hid is shown again.
 *
 * `change` is null when Eventbrite already matches.
 */
export type CapacityPlan = {
  change: TicketClassChange | null;
  /** What Eventbrite will show afterwards. */
  total: number;
  hidden: boolean;
  /** A line for the date's status. */
  words: string;
};

export function planTicketClass(tc: EventbriteTicketClass, seatsLeft: number): CapacityPlan {
  const left = Math.max(0, Math.trunc(seatsLeft));
  const sold = Math.max(0, tc.quantitySold);
  if (left === 0) {
    if (sold === 0) {
      return tc.hidden
        ? {
            change: null,
            total: tc.quantityTotal,
            hidden: true,
            words: "Full: the ticket is hidden",
          }
        : {
            change: { hidden: true },
            total: tc.quantityTotal,
            hidden: true,
            words: "Full: the ticket is hidden",
          };
    }
    return {
      change: tc.quantityTotal === sold ? null : { quantity_total: sold },
      total: sold,
      hidden: tc.hidden,
      words: "Sold out on Eventbrite",
    };
  }
  const total = sold + left;
  const change: TicketClassChange = {};
  if (total !== tc.quantityTotal) change.quantity_total = total;
  if (tc.hidden) change.hidden = false;
  return {
    change: Object.keys(change).length > 0 ? change : null,
    total,
    hidden: false,
    words: `${left} ${left === 1 ? "place" : "places"} on sale`,
  };
}
