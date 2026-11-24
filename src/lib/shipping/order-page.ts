/**
 * Small things the order page works out for itself: a box's weight as one
 * pounds figure, which service is the one the shopper picked, and the short
 * mark for a carrier. Pure: no network, no database.
 */

const TENTHS_PER_POUND = 160;

/**
 * What someone typed in the one "Weight lb" box ("12.6") as tenths of an
 * ounce, rounded to the nearest tenth. Null when it's empty or isn't a
 * plain number.
 */
export function poundsToTenthOz(text: string): number | null {
  const typed = text.trim();
  if (!/^(\d{1,5}(\.\d{0,4})?|\.\d{1,4})$/.test(typed)) return null;
  const tenths = Math.round(Number(typed) * TENTHS_PER_POUND);
  return Number.isFinite(tenths) ? tenths : null;
}

/**
 * Tenths of an ounce as the pounds to show in that box: one decimal ("12.6"),
 * or two under a pound so a light parcel doesn't read as nothing.
 */
export function tenthOzToPounds(tenths: number): string {
  const whole = Math.max(0, Math.round(tenths));
  if (whole === 0) return "0";
  const pounds = whole / TENTHS_PER_POUND;
  const text = pounds < 1 ? pounds.toFixed(2) : pounds.toFixed(1);
  const tidy = text.replace(/\.?0+$/, "");
  // Never "0" for a parcel that weighs something.
  return tidy === "0" || tidy === "" ? "0.01" : tidy;
}

/**
 * Whether a carrier's service is the option the shopper picked at checkout.
 * Deliberately cautious, as on the bench this was ported from: a checkout
 * name only means USPS (or FedEx, DHL…) when it says so, and a plain
 * "Standard" means UPS Ground only. When unsure, the answer is no.
 */
export function sameService(chosen: string | null | undefined, carrier: string, name: string) {
  const a = (chosen ?? "").trim().toLowerCase();
  if (!a) return false;
  // "UPS Ground · Redo" and the like: the service itself, with its carrier in front.
  const bare = name.replace(/\s·\s.*$/, "").trim();
  const service = new RegExp(`^${carrier.replace(/[^a-z0-9]/gi, "")}\\b`, "i").test(bare)
    ? bare
    : `${carrier} ${bare}`.trim();
  const lower = service.toLowerCase();
  const other = /^(fedex|ontrac|dhl|amazon)/.exec(lower);
  if (other || /fedex|ontrac|dhl|amazon/.test(a)) {
    if (!other || !a.includes(other[1])) return false;
    const rest = lower
      .replace(/^(fedex|ontrac|dhl ecommerce|dhl express|dhl|amazon shipping|amazon)\s*/, "")
      .trim();
    return (
      !rest || a.includes(rest) || (/ground|home/.test(rest) && /ground|standard|home/.test(a))
    );
  }
  const usps = /^usps\b/.test(lower);
  if (usps !== /usps|postal|ground advantage|priority mail/.test(a)) return false;
  if (usps) {
    const rest = lower
      .replace(/^usps\s+/, "")
      .replace(" mail", "")
      .trim();
    return rest !== "" && a.includes(rest);
  }
  // Anything else we don't know by name is left alone.
  if (!/^ups\b/.test(lower)) return false;
  const b = lower.replace(/^ups\s+/, "").trim();
  if (!b) return false;
  return (
    a.includes(b) ||
    (b.includes("ground") && /ground|standard/.test(a)) ||
    (b.includes("2nd day") && /2.?day|two.?day|express/.test(a)) ||
    (b.includes("next day") && /next.?day|overnight/.test(a))
  );
}

export type CarrierMarkKey = "ups" | "usps" | "fedex" | "dhl" | "ontrac" | "canpost" | "other";

/** The few carriers with a mark of their own; everything else gets a plain one. */
const MARKS: [RegExp, CarrierMarkKey, string][] = [
  [/^ups\b/, "ups", "UPS"],
  [/^(usps|us postal|united states postal)/, "usps", "USPS"],
  [/^fedex/, "fedex", "FedEx"],
  [/^dhl/, "dhl", "DHL"],
  [/^ontrac/, "ontrac", "OnTrac"],
  [/^canada ?post/, "canpost", "CP"],
];

/** The short name and colour key for a carrier's mark. */
export function carrierMark(carrier: string): { key: CarrierMarkKey; label: string } {
  const name = carrier.trim().toLowerCase();
  for (const [pattern, key, label] of MARKS) if (pattern.test(name)) return { key, label };
  return { key: "other", label: carrier.trim().slice(0, 5) || "?" };
}
