import type { KeyExpiry } from "./mapping";

/**
 * The heads-ups the connector posts into Messages. Pure: this decides what is
 * worth saying and under which key; the worker asks the database whether that
 * key has been said before (`note_michaels_alert`) and posts only what's new.
 */
export type MichaelsAlert = { key: string; text: string };

/** Days-to-replace bands for the key warning: one heads-up as each band is entered. */
const KEY_BANDS = [1, 3, 7, 14] as const;

const HOW =
  "Make a new key in the Michaels Developer Account Center, then open Connections, disconnect Michaels Marketplace and connect it again with the new key.";

export function keyAlert(key: KeyExpiry): MichaelsAlert | null {
  if (!key.expiresOn || !key.replaceOn || key.daysLeft === null || key.daysToReplace === null) {
    return null;
  }
  if (key.daysLeft <= 0) {
    return {
      key: `key:${key.expiresOn}:expired`,
      text: `Your Michaels API key has run out, so Michaels has stopped answering. ${HOW}`,
    };
  }
  if (key.daysToReplace <= 0) {
    return {
      key: `replace:${key.replaceOn}:due`,
      text: `It's time to replace your Michaels API key: it is past 60 days, when keys start misbehaving (Michaels ends it on ${key.expiresOn}). ${HOW}`,
    };
  }
  const band = KEY_BANDS.find((b) => key.daysToReplace! <= b);
  if (!band) return null;
  return {
    key: `replace:${key.replaceOn}:${band}`,
    text: `Replace your Michaels API key in ${key.daysToReplace} day${key.daysToReplace === 1 ? "" : "s"}, by ${key.replaceOn} (Michaels ends it on ${key.expiresOn}). ${HOW}`,
  };
}

export function runAlerts(input: {
  key: KeyExpiry;
  /** Michaels said the key is no good. */
  keyRejected: boolean;
  /** The connection this key belongs to, so a new key can be told about again. */
  connectionId: string;
  /** More than a tenth of the listings have no item. */
  blocked: boolean;
  unmatched: number;
  skus: number;
  /** How many looks in a row have failed, this one included. */
  failedInRow: number;
  error: string | null;
  /** The workspace's month, YYYY-MM: the safety stop is mentioned once a month at most. */
  month: string;
}): MichaelsAlert[] {
  const out: MichaelsAlert[] = [];
  const key = keyAlert(input.key);
  if (key) out.push(key);
  if (input.keyRejected) {
    out.push({
      key: `rejected:${input.connectionId}:${input.month}`,
      text: `Michaels didn't accept your API key, so nothing can be read. It may have run out: keys last 90 days. ${HOW}`,
    });
  }
  if (input.blocked) {
    out.push({
      key: `unmatched:${input.month}`,
      text: `${input.unmatched} of your ${input.skus} Michaels listings don't match anything in your shop. That is more than one in ten, so nothing could be sent to Michaels until they are sorted out. Open Stock, then Michaels, then Listings, and pair them by hand.`,
    });
  }
  if (input.failedInRow === 3) {
    out.push({
      key: `failing:${input.month}:${(input.error ?? "").slice(0, 60)}`,
      text: `The last three looks at Michaels didn't finish${input.error ? `: ${input.error.slice(0, 300)}` : "."} We'll keep trying every hour.`,
    });
  }
  return out;
}
