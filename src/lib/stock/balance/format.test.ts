import { describe, it, expect } from "vitest";
import { describeBalance, describeAdjustment, describeDrift, formatAmount } from "./format";

describe("vendor balance display", () => {
  it("spells out a positive balance as owed", () => {
    expect(describeBalance("6211.25")).toEqual({
      direction: "owed",
      amount: "$6,211.25",
      text: "$6,211.25 owed",
    });
  });

  it("spells out a negative balance as a credit, with no minus sign", () => {
    const b = describeBalance("-2764.15");
    expect(b).toEqual({ direction: "credit", amount: "$2,764.15", text: "$2,764.15 credit" });
    expect(b.text).not.toMatch(/[-−]/);
  });

  it("treats zero and sub-cent noise as settled", () => {
    expect(describeBalance("0.00").direction).toBe("settled");
    expect(describeBalance("-0.00").text).toBe("$0.00");
    expect(describeBalance(-0.004).direction).toBe("settled");
  });

  it("formats unsigned amounts", () => {
    expect(formatAmount("-15000")).toBe("$15,000.00");
    expect(formatAmount(1234.5)).toBe("$1,234.50");
  });

  it("labels a negative adjustment as a credit note", () => {
    expect(describeAdjustment("-2366.56")).toEqual({ isCredit: true, text: "$2,366.56 credit" });
    expect(describeAdjustment("150")).toEqual({ isCredit: false, text: "$150.00" });
  });

  it("describes statement drift in words", () => {
    expect(describeDrift("41.40")).toBe("the vendor's figure is $41.40 higher");
    expect(describeDrift("-103.65")).toBe("the vendor's figure is $103.65 lower");
    expect(describeDrift("0")).toBe("matches");
  });
});
