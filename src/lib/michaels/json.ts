/**
 * Michaels IDs (orderItemId, skuNumber, …) are long numeric strings that can
 * exceed 2^53. The docs show them quoted, but if any endpoint ever sends one as
 * a bare JSON number, JSON.parse would silently round it and we'd be looking at
 * the wrong line. So before parsing, quote any bare integer of 16+ digits that
 * sits in a value position. Shorter numbers (prices, quantities) parse normally.
 */
const LONG_INT_VALUE = /([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g;

export function parseMichaelsJson(text: string): unknown {
  return JSON.parse(text.replace(LONG_INT_VALUE, '$1"$2"'));
}
