import { priceToCents } from "../easypost";
import type { LabelSourceKey, MergedRate, OtherPrice, SourceRate } from "./types";

/**
 * One price list from every connected source, cheapest first. Ported from
 * the reference help desk's `carriers.ts`. Pure: no network, no database.
 */

/**
 * "UPS 3 Day Select" and "UPS 3day Select" are the same service: the carrier
 * plus the name without spaces or punctuation.
 */
export const serviceKey = (rate: Pick<SourceRate, "carrier" | "name">) =>
  `${rate.carrier.toLowerCase()}|${rate.name
    .replace(/\s·\s.*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")}`;

/** On a tie the most direct connection wins: the business's own account, then EasyPost, then Redo. */
const DIRECTNESS: Record<LabelSourceKey, number> = { ups: 0, easypost: 1, redo: 2 };

const cents = (rate: Pick<SourceRate, "price">) => priceToCents(rate.price) ?? BigInt(0);

/**
 * The rules, in order:
 *  1. USPS through EasyPost costs the same as through Redo, so when Redo
 *     quoted USPS, EasyPost's USPS rows are left out. (They stay when Redo
 *     didn't quote any, for instance because Redo is down.)
 *  2. The same carrier service from several places is one row: the cheapest,
 *     and on a tie the most direct connection.
 *  3. That row remembers what each other source would charge for it.
 *  4. Cheapest first.
 */
export function mergeRates(all: SourceRate[]): MergedRate[] {
  const redoUsps = all.some((rate) => rate.source === "redo" && rate.carrier === "USPS");
  const rates = redoUsps
    ? all.filter((rate) => !(rate.source === "easypost" && rate.carrier === "USPS"))
    : all;

  const best = new Map<string, SourceRate>();
  const every = new Map<string, SourceRate[]>();
  for (const rate of rates) {
    const key = serviceKey(rate);
    every.set(key, [...(every.get(key) ?? []), rate]);
    const held = best.get(key);
    if (
      !held ||
      cents(rate) < cents(held) ||
      (cents(rate) === cents(held) && DIRECTNESS[rate.source] < DIRECTNESS[held.source])
    ) {
      best.set(key, rate);
    }
  }

  return [...best.entries()]
    .map(([key, rate]): MergedRate => {
      // The other connections' prices for this service: one each, their cheapest.
      const others = new Map<LabelSourceKey, OtherPrice & { cents: bigint }>();
      for (const other of every.get(key) ?? []) {
        if (other === rate || other.source === rate.source || other.currency !== rate.currency) {
          continue;
        }
        const held = others.get(other.source);
        if (!held || cents(other) < held.cents) {
          others.set(other.source, {
            source: other.source,
            price: other.price,
            cents: cents(other),
          });
        }
      }
      const list = [...others.values()]
        .sort((a, b) => (a.cents < b.cents ? -1 : a.cents > b.cents ? 1 : 0))
        .map(({ source, price }) => ({ source, price }));
      return list.length > 0 ? { ...rate, others: list } : { ...rate };
    })
    .sort((a, b) =>
      cents(a) < cents(b) ? -1 : cents(a) > cents(b) ? 1 : a.name.localeCompare(b.name),
    );
}

/** What the browser is shown of a rate: never the source's own ids. */
export type SourceRateChoice = {
  id: string;
  carrier: string;
  name: string;
  price: string;
  currency: string;
  days: number | null;
  source: LabelSourceKey;
  note?: string;
  others?: OtherPrice[];
};

export const sourceRateChoice = (rate: MergedRate): SourceRateChoice => ({
  id: rate.id,
  carrier: rate.carrier,
  name: rate.name,
  price: rate.price,
  currency: rate.currency,
  days: rate.days,
  source: rate.source,
  ...(rate.note ? { note: rate.note } : {}),
  ...(rate.others ? { others: rate.others } : {}),
});
