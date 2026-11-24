import { describe, expect, it } from "vitest";
import { listingIssues, worstLevel, type IssueRow } from "./issues";

const now = new Date("2026-10-21T14:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

const row = (over: Partial<IssueRow> = {}): IssueRow => ({
  sellerSku: "KIT-BLUE",
  michaelsSkuNumber: "S1",
  listingStatus: "ACTIVE",
  problem: null,
  problemDetail: null,
  michaelsQty: 4,
  michaelsPrice: "25.00",
  updatedAt: hoursAgo(1),
  item: { on_hand: 5, tracked: true, price: 25 },
  ...over,
});

describe("listingIssues", () => {
  it("finds nothing wrong when stock and price are in step", () => {
    expect(listingIssues(row(), 1, now)).toEqual([]);
    expect(worstLevel([])).toBeNull();
  });

  it("flags price and stock that have drifted", () => {
    const issues = listingIssues(row({ michaelsQty: 2, michaelsPrice: "23.00" }), 1, now);
    expect(issues).toEqual([
      { level: "warn", text: "KIT-BLUE: $23.00 on Michaels, $25.00 in your shop.", fix: "later" },
      { level: "warn", text: "KIT-BLUE: 2 available on Michaels, should be 4.", fix: "later" },
    ]);
    expect(worstLevel(issues)).toBe("warn");
  });

  it("holds the units back before comparing stock", () => {
    expect(listingIssues(row({ michaelsQty: 5 }), 0, now)).toEqual([]);
    expect(listingIssues(row({ michaelsQty: 5 }), 1, now)).toHaveLength(1);
    expect(
      listingIssues(
        row({ item: { on_hand: 0, tracked: true, price: 25 }, michaelsQty: 0 }),
        3,
        now,
      ),
    ).toEqual([]);
  });

  it("doesn't compare what it can't: no count kept, no price, or Michaels' figure unknown", () => {
    expect(
      listingIssues(
        row({ item: { on_hand: 0, tracked: false, price: null }, michaelsQty: 9 }),
        1,
        now,
      ),
    ).toEqual([]);
    expect(listingIssues(row({ michaelsQty: null, michaelsPrice: null }), 1, now)).toEqual([]);
  });

  it("reads 25 and 25.00 as the same price", () => {
    expect(listingIssues(row({ michaelsPrice: "25" }), 1, now)).toEqual([]);
  });

  it("flags a suspended listing as an error", () => {
    const issues = listingIssues(row({ listingStatus: "SUSPENDED" }), 1, now);
    expect(issues[0]).toMatchObject({ level: "error", fix: "seller-center" });
    expect(worstLevel(issues)).toBe("error");
  });

  it("only escalates a review that has dragged past 72 hours", () => {
    const young = listingIssues(
      row({ listingStatus: "PENDING_REVIEW", updatedAt: hoursAgo(10) }),
      1,
      now,
    );
    expect(young[0]).toMatchObject({ level: "info" });
    const old = listingIssues(
      row({ listingStatus: "PENDING_REVIEW", updatedAt: hoursAgo(73) }),
      1,
      now,
    );
    expect(old[0]).toMatchObject({ level: "warn", fix: "seller-center" });
    const undated = listingIssues(
      row({ listingStatus: "PENDING_REVIEW", updatedAt: null }),
      1,
      now,
    );
    expect(undated[0]).toMatchObject({ level: "info" });
  });

  it("has words for drafts, switched-off, expired and archived listings", () => {
    const first = (status: string) => listingIssues(row({ listingStatus: status }), 1, now)[0];
    expect(first("DRAFT")).toMatchObject({ level: "info", fix: "seller-center" });
    expect(first("inactive")).toMatchObject({ level: "warn" });
    expect(first("EXPIRED")).toMatchObject({ level: "warn" });
    expect(first("ARCHIVED")).toMatchObject({ level: "info" });
    expect(first("FORBIDDEN")).toMatchObject({ level: "error" });
  });

  it("says where each kind of unmatched SKU gets fixed, and stops there", () => {
    const of = (problem: IssueRow["problem"], sellerSku: string | null = "KIT-BLUE") =>
      listingIssues(row({ problem, sellerSku, item: null, michaelsQty: 1 }), 1, now);
    expect(of("no_match")).toEqual([
      {
        level: "error",
        text: "KIT-BLUE doesn't match any SKU in your shop, so stock, prices and orders couldn't flow.",
        fix: "pair",
      },
    ]);
    expect(of("pairing_missing")[0]!.fix).toBe("pair");
    expect(of("ambiguous")[0]!.fix).toBe("shop");
    expect(of("duplicate")[0]!.fix).toBe("seller-center");
    expect(of("no_seller_sku", null)[0]).toMatchObject({
      fix: "seller-center",
      text: "Michaels SKU S1 has no seller SKU, so there's nothing to match it by.",
    });
  });
});
