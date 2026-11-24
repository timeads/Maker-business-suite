import { michaelsPrice, michaelsQuantity, type MatchProblem } from "./mapping";

/**
 * What's wrong with one Michaels SKU, compared with the item it is matched to
 * (ported from TuftStock's listing checks). Pure: the page reads the rows and
 * asks here. This stage can't fix anything on Michaels, so every issue says
 * where a person fixes it instead.
 */

export interface ListingIssue {
  level: "error" | "warn" | "info";
  text: string;
  /** Where it gets fixed. `pair`: here, by pairing by hand. `later`: when sending is switched on. */
  fix?: "pair" | "seller-center" | "shop" | "later";
}

export type IssueRow = {
  sellerSku: string | null;
  michaelsSkuNumber: string;
  listingStatus: string | null;
  problem: MatchProblem | null;
  problemDetail: string | null;
  michaelsQty: number | null;
  michaelsPrice: string | null;
  /** When Michaels last changed the listing. */
  updatedAt: Date | null;
  item: { on_hand: number; tracked: boolean; price: number | string | null } | null;
};

const PENDING_REVIEW_MAX_MS = 72 * 60 * 60 * 1000;

export const PROBLEM_WORDS: Record<MatchProblem, string> = {
  no_match: "Not in your shop",
  ambiguous: "More than one match",
  duplicate: "On Michaels twice",
  no_seller_sku: "No seller SKU",
  pairing_missing: "Paired item is gone",
};

export function listingIssues(
  row: IssueRow,
  unitsHeldBack: number,
  now: Date = new Date(),
): ListingIssue[] {
  const out: ListingIssue[] = [];
  const status = (row.listingStatus ?? "").toUpperCase();
  const name = row.sellerSku ?? `Michaels SKU ${row.michaelsSkuNumber}`;

  if (status === "SUSPENDED") {
    out.push({
      level: "error",
      text: "Michaels suspended this listing for a content problem. The seller center says why.",
      fix: "seller-center",
    });
  } else if (status === "FORBIDDEN") {
    out.push({
      level: "error",
      text: "Michaels doesn't allow this product to be sold.",
      fix: "seller-center",
    });
  } else if (status === "PENDING_REVIEW") {
    if (row.updatedAt && now.getTime() - row.updatedAt.getTime() > PENDING_REVIEW_MAX_MS) {
      out.push({
        level: "warn",
        text: "Waiting on Michaels review for over 72 hours. Ask Michaels seller support.",
        fix: "seller-center",
      });
    } else {
      out.push({
        level: "info",
        text: "Michaels is reviewing it. It goes live by itself, usually within 72 hours.",
      });
    }
  } else if (status === "DRAFT") {
    out.push({
      level: "info",
      text: "Draft, so not for sale yet. Check it, then submit it in the seller center.",
      fix: "seller-center",
    });
  } else if (status === "INACTIVE") {
    out.push({
      level: "warn",
      text: "Turned off on Michaels, so it's not for sale.",
      fix: "seller-center",
    });
  } else if (status === "EXPIRED") {
    out.push({ level: "warn", text: "Expired (its end date passed).", fix: "seller-center" });
  } else if (status === "ARCHIVED") {
    out.push({
      level: "info",
      text: "Archived on Michaels. Stock and prices wouldn't be sent for it.",
    });
  }

  if (row.problem) {
    const text: Record<MatchProblem, string> = {
      no_match: `${name} doesn't match any SKU in your shop, so stock, prices and orders couldn't flow.`,
      ambiguous: `${name} matches more than one item in your shop, and we won't guess which one sells.`,
      duplicate: `${name} is the seller SKU of more than one Michaels listing. Only the first is matched.`,
      no_seller_sku: `Michaels SKU ${row.michaelsSkuNumber} has no seller SKU, so there's nothing to match it by.`,
      pairing_missing: `${name} was paired by hand with an item that is no longer in your shop.`,
    };
    out.push({
      level: "error",
      text: text[row.problem],
      fix:
        row.problem === "no_seller_sku" || row.problem === "duplicate"
          ? "seller-center"
          : row.problem === "ambiguous"
            ? "shop"
            : "pair",
    });
    return out;
  }
  if (!row.item) return out;

  const price = michaelsPrice(row.item.price);
  const there = row.michaelsPrice === null ? null : michaelsPrice(row.michaelsPrice);
  if (price && row.michaelsPrice !== null && price !== there) {
    out.push({
      level: "warn",
      text: `${name}: $${row.michaelsPrice} on Michaels, $${price} in your shop.`,
      fix: "later",
    });
  }
  if (row.item.tracked && row.michaelsQty !== null) {
    const expected = michaelsQuantity(row.item.on_hand, unitsHeldBack);
    if (expected !== row.michaelsQty) {
      out.push({
        level: "warn",
        text: `${name}: ${row.michaelsQty} available on Michaels, should be ${expected}.`,
        fix: "later",
      });
    }
  }
  return out;
}

/** The worst level among some issues, for a row's badge. */
export function worstLevel(issues: ListingIssue[]): ListingIssue["level"] | null {
  if (issues.some((i) => i.level === "error")) return "error";
  if (issues.some((i) => i.level === "warn")) return "warn";
  return issues.length ? "info" : null;
}
