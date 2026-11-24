import type { UpsTracking } from "../shipping/sources/ups";

/**
 * What a carrier has told us about a parcel on its way in, and how that is
 * said. Pure. The facts are stored as they were observed
 * (`purchase_order_shipments.carrier_*`, with the time we asked); everything
 * here is worked out from them on read.
 *
 * Only UPS is asked, and only where the workspace has connected its own UPS
 * account. Every other number stays exactly as a person recorded it.
 */

export const CARRIER_STATUSES = [
  "label",
  "on_the_way",
  "out_for_delivery",
  "delivered",
  "problem",
  "not_found",
] as const;
export type CarrierStatus = (typeof CARRIER_STATUSES)[number];

type Tone = "open" | "waiting" | "good" | "bad" | "closed";

/** Each status in words, with the badge colour that goes with it. */
export const CARRIER_WORDS: Record<CarrierStatus, { label: string; tone: Tone }> = {
  label: { label: "Label made, not picked up yet", tone: "closed" },
  on_the_way: { label: "On the way", tone: "open" },
  out_for_delivery: { label: "Out for delivery", tone: "waiting" },
  delivered: { label: "Delivered", tone: "good" },
  problem: { label: "Held up", tone: "bad" },
  not_found: { label: "UPS doesn't know this number yet", tone: "closed" },
};

export const isCarrierStatus = (value: unknown): value is CarrierStatus =>
  typeof value === "string" && (CARRIER_STATUSES as readonly string[]).includes(value);

/** A parcel as stored: what a person recorded, and what the carrier said. */
export type TrackedParcel = {
  carrier: string;
  tracking: string;
  /** Typed in by a person. */
  expectedOn: string | null;
  arrivedOn: string | null;
  /** Told to us by the carrier. */
  carrierStatus: CarrierStatus | null;
  carrierDetail: string | null;
  carrierExpectedOn: string | null;
  carrierDeliveredOn: string | null;
  carrierScanPlace: string | null;
  carrierScanAt: string | null;
  carrierCheckedAt: string | null;
  carrierError: string | null;
};

/**
 * The dates to go by. A person's "it's here" always stands; without one, the
 * carrier's delivery counts as arrived. For the due date the carrier's own
 * estimate beats one typed in earlier, as in TuftStock: a typed date is kept
 * only until the carrier gives one.
 */
export function parcelDates(
  parcel: Pick<
    TrackedParcel,
    "expectedOn" | "arrivedOn" | "carrierStatus" | "carrierExpectedOn" | "carrierDeliveredOn"
  >,
): { expectedOn: string | null; arrivedOn: string | null } {
  return {
    expectedOn: parcel.carrierExpectedOn ?? parcel.expectedOn,
    arrivedOn:
      parcel.arrivedOn ?? (parcel.carrierStatus === "delivered" ? parcel.carrierDeliveredOn : null),
  };
}

/** What to write down after asking UPS: the payload of `finish_po_shipment_check`. */
export function carrierResult(answer: UpsTracking): Record<string, string | null> {
  if (!answer.found) return { status: "not_found" };
  return {
    status: answer.status,
    detail: answer.detail,
    expected_on: answer.expectedOn,
    delivered_on: answer.deliveredOn,
    scan_place: answer.scanPlace,
    scan_at: answer.scanAt,
  };
}

const shortDay = (day: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
    new Date(`${day}T12:00:00Z`),
  );

/** "…6784": enough of a number to tell parcels apart in a line of text. */
export const numberTail = (tracking: string) =>
  tracking.length > 6 ? `…${tracking.slice(-4)}` : tracking;

/**
 * One parcel in a few words, for a tooltip or a list:
 * "UPS …6784: out for delivery, due Nov 26".
 */
export function parcelWords(parcel: TrackedParcel, today: string): string {
  const { expectedOn, arrivedOn } = parcelDates(parcel);
  const name = `${parcel.carrier || "Parcel"} ${numberTail(parcel.tracking)}`;
  if (arrivedOn) return `${name}: arrived ${shortDay(arrivedOn)}`;
  const status =
    parcel.carrierStatus && parcel.carrierStatus !== "not_found"
      ? CARRIER_WORDS[parcel.carrierStatus].label.toLowerCase()
      : "on its way";
  if (!expectedOn) return `${name}: ${status}`;
  return `${name}: ${status}, ${expectedOn < today ? "was due" : "due"} ${shortDay(expectedOn)}`;
}

/** Whether "Check now" makes sense for a parcel: UPS's own number, not yet here. */
export const canAskCarrier = (parcel: Pick<TrackedParcel, "tracking" | "arrivedOn">) =>
  /^1Z[0-9A-Z]{16}$/.test(parcel.tracking) && !parcel.arrivedOn;
