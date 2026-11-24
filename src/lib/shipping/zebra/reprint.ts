/**
 * "These were printed before": what to ask before packing slips go to the
 * printer a second time. Ported from the single-tenant help desk
 * (`printSlipsToZebra` in `public/js/printing.js`). Pure.
 */

/** One slip about to be printed, and the orders it stands for (several when they go out together). */
export type SlipUnit = { orderIds: string[] };

/** An order whose slip was printed before, and when, in words. */
export type PrintedBefore = { id: string; name: string; when: string };

export type ReprintQuestion<T extends SlipUnit> = {
  title: string;
  /** "#1042: printed Nov 24, 2:10 PM", eight at most, then how many more. */
  lines: string[];
  /** How many orders have a slip that hasn't been printed yet. */
  freshOrders: number;
  /** The slips for those orders: what "only the new ones" prints. */
  fresh: T[];
};

/**
 * The question to ask, or null when nothing here was printed before. An
 * order split over several boxes has several slips and still counts once; a
 * slip for orders going together is new only when none of them was printed.
 */
export function reprintQuestion<T extends SlipUnit>(
  slips: T[],
  printed: PrintedBefore[],
): ReprintQuestion<T> | null {
  const seen = new Set(printed.map((order) => order.id));
  const wasPrinted = (slip: SlipUnit) => slip.orderIds.some((id) => seen.has(id));
  const unit = (slip: SlipUnit) => slip.orderIds.join("+");
  const all = new Set(slips.map(unit));
  const fresh = slips.filter((slip) => !wasPrinted(slip));
  const freshOrders = new Set(fresh.map(unit)).size;
  const done = all.size - freshOrders;
  if (done === 0) return null;
  const shown = printed.filter((order) => slips.some((slip) => slip.orderIds.includes(order.id)));
  return {
    title:
      freshOrders === 0
        ? all.size === 1
          ? `This order's packing slip${slips.length > 1 ? "s were" : " was"} already printed`
          : `All ${all.size} orders' packing slips were already printed`
        : `${done} of ${all.size} orders' packing slips were already printed`,
    lines: [
      ...shown.slice(0, 8).map((order) => `${order.name}: printed ${order.when}`),
      ...(shown.length > 8 ? [`…and ${shown.length - 8} more`] : []),
    ],
    freshOrders,
    fresh,
  };
}
