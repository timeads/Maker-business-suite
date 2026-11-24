import { randomUUID } from "node:crypto";
import { priceToCents, verifyAddress, type LabelAddress } from "./easypost";
import { getLabelAccess, withLabelSource, type Held } from "./label-access";
import { addressChecker } from "./plan";
import { labelSource } from "./sources";
import { mergeRates } from "./sources/rates";
import type { LabelRequest, LabelSourceKey, SourceRate } from "./sources/types";
import { validateUpsAddress } from "./sources/ups";

/**
 * Asking the carriers for the To ship list: the best price for an order's
 * plan, and whether its address is known. Server-only: sign-ins come from
 * Vault through `getLabelAccess` and never leave this file.
 *
 * These answers are for looking at. Nothing here writes a
 * `shipping_label_quotes` row, and the rates' own ids are thrown away with
 * the answer, so a price from here can never be bought.
 */

/** How long one account gets before the list goes on without it. */
const LIST_QUOTE_MS = 12_000;

const within = <T>(ms: number, work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("no answer in time")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

export type ListQuote =
  | {
      status: "ok";
      source: LabelSourceKey;
      carrier: string;
      service: string;
      cents: number;
      currency: string;
    }
  | { status: "none" };

/** The cheapest of the merged list, as the few words the list keeps. */
export function bestListQuote(rates: SourceRate[]): ListQuote {
  for (const rate of mergeRates(rates)) {
    const cents = priceToCents(rate.price);
    if (cents === null || cents > BigInt(100_000_000)) continue;
    return {
      status: "ok",
      source: rate.source,
      carrier: rate.carrier,
      service: rate.name,
      cents: Number(cents),
      currency: rate.currency,
    };
  }
  return { status: "none" };
}

/** One account's prices, or none when it errors, is slow or needs reconnecting. */
async function ask<K extends LabelSourceKey>(
  tenantId: string,
  key: K,
  request: LabelRequest,
  ref: string,
): Promise<SourceRate[]> {
  try {
    const source = labelSource(key);
    const held = await getLabelAccess(tenantId, key);
    const quote = await within(
      LIST_QUOTE_MS,
      withLabelSource(tenantId, key, (access) => source.quote(access, request, ref), held),
    );
    return quote.rates;
  } catch {
    return [];
  }
}

/**
 * Asks every connected account what this plan would cost and keeps the
 * cheapest. An account in trouble is simply left out. Never throws.
 */
export async function listQuote(
  tenantId: string,
  sources: LabelSourceKey[],
  request: LabelRequest,
): Promise<ListQuote> {
  // Ours, and thrown away: it only keeps the sources' rate ids apart while they're merged.
  const ref = `list_${randomUUID().replace(/-/g, "")}`;
  const answers = await Promise.all(sources.map((key) => ask(tenantId, key, request, ref)));
  return bestListQuote(answers.flat());
}

export type ListAddress = {
  status: "found" | "not_found" | "not_checked";
  residential: boolean | null;
};

/**
 * Asks the carriers' address book about one address, as the order page does:
 * EasyPost when it is connected, else UPS for US addresses. "not_checked"
 * when nobody could be asked or the check failed. Never throws.
 */
export async function listAddressCheck(
  tenantId: string,
  sources: LabelSourceKey[],
  to: LabelAddress,
): Promise<ListAddress> {
  const checker = addressChecker(sources, to.country);
  if (!checker) return { status: "not_checked", residential: null };
  try {
    const held = await getLabelAccess(tenantId, checker);
    const check = await within(
      LIST_QUOTE_MS,
      checker === "easypost"
        ? verifyAddress((held as Held<"easypost">).access.key, to)
        : withLabelSource(
            tenantId,
            "ups",
            (access) => validateUpsAddress(access, to),
            held as Held<"ups">,
          ),
    );
    return { status: check.found ? "found" : "not_found", residential: check.residential };
  } catch {
    return { status: "not_checked", residential: null };
  }
}
