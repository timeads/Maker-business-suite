import { describe, expect, it } from "vitest";
import { caseLabel, casePackOf, casesFor, roundUpToCase, startingQty } from "./case-pack";
import { computeDraftPo } from "./draft-po";
import { addDays } from "./days";

describe("case packs", () => {
  it("rounds a suggestion up to whole cases, never down", () => {
    expect(roundUpToCase(38, 36)).toBe(72);
    expect(roundUpToCase(36, 36)).toBe(36);
    expect(roundUpToCase(1, 36)).toBe(36);
    expect(roundUpToCase(37, 12)).toBe(48);
  });

  it("leaves zero at zero, and items without a case pack alone", () => {
    expect(roundUpToCase(0, 36)).toBe(0);
    expect(roundUpToCase(38, null)).toBe(38);
    expect(roundUpToCase(38, 1)).toBe(38);
    expect(roundUpToCase(38, undefined)).toBe(38);
    expect(casePackOf(0)).toBeNull();
    expect(casePackOf(2.5)).toBeNull();
    expect(casePackOf(24)).toBe(24);
  });

  it("counts cases the way the order editor shows them", () => {
    expect(casesFor(72, 36)).toBe(2);
    expect(casesFor(54, 36)).toBe(1.5);
    expect(casesFor(40, 36)).toBe(1.11);
  });

  it("says it in words", () => {
    expect(caseLabel(72, 36)).toBe("2 cases of 36");
    expect(caseLabel(36, 36)).toBe("1 case of 36");
    expect(caseLabel(54, 36)).toBe("1.5 cases of 36");
    expect(caseLabel(10, null)).toBeNull();
    expect(caseLabel(0, 36)).toBeNull();
  });

  it("a hand-added line starts at the suggestion, else one case, else one unit", () => {
    expect(startingQty(48, 24)).toBe(48);
    expect(startingQty(0, 24)).toBe(24);
    expect(startingQty(0, null)).toBe(1);
    // ...and never below the item's own smallest order.
    expect(startingQty(0, null, 10)).toBe(10);
    expect(startingQty(0, 24, 30)).toBe(48);
  });

  it("an order raised to the supplier's minimum still comes out in whole cases", () => {
    const today = new Date(2026, 6, 1);
    // 30 + 30 scaled to the order minimum of 100 gives 50 / 50 (docs/04 §5)...
    const draft = computeDraftPo(
      [
        { variantId: "a", suggestedQty: 30, unitCost: "5.00", effectiveLeadTimeDays: 45 },
        { variantId: "b", suggestedQty: 30, unitCost: "5.00", effectiveLeadTimeDays: 30 },
      ],
      100,
      "ORDER",
      today,
    );
    expect(draft.lines.map((l) => l.qty)).toEqual([50, 50]);
    expect(draft.estDeliveryDate).toEqual(addDays(today, 45));
    // ...then a case of 36 takes its line up to two cases; the total only grows.
    const cased = draft.lines.map((l, i) => roundUpToCase(l.qty, i === 0 ? 36 : null));
    expect(cased).toEqual([72, 50]);
    expect(cased.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(100);
  });
});
