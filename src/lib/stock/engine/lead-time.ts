/**
 * Observed lead time = the actual elapsed days from when a PO was sent to the
 * supplier (sentAt) to when its goods arrived (first receipt, or a shipment's
 * delivered date). Pure functions only — the DB loader lives in
 * the Suppliers page. Surfaced next to each supplier's
 * configured leadTimeDays so the owner can adopt reality; never auto-applied
 * (no silent changes to the reorder math).
 */

export interface LeadTimeSample {
  sentAt: Date;
  arrivedAt: Date;
}

export interface ObservedLeadTime {
  days: number; // median observed lead time
  sampleSize: number;
}

/** Whole-day difference (rounded) between two instants. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Median observed lead time from a set of order→arrival samples. Non-positive or
 * inverted spans (arrived before sent — bad data) are dropped. Returns null when
 * there are no usable samples.
 */
export function observedLeadTimeDays(samples: LeadTimeSample[]): ObservedLeadTime | null {
  const diffs = samples
    .filter((s) => s.arrivedAt.getTime() >= s.sentAt.getTime())
    .map((s) => daysBetween(s.sentAt, s.arrivedAt));
  const m = median(diffs);
  return m === null ? null : { days: m, sampleSize: diffs.length };
}
