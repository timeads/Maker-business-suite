import { describe, expect, it } from "vitest";
import { agingLabel } from "./data";
import { formatMoney, formatPercent, niceTicks } from "./format";

describe("formatting", () => {
  it("writes money plainly and compactly", () => {
    expect(formatMoney(1284.5, "USD")).toBe("$1,285");
    expect(formatMoney(84.5, "USD")).toBe("$84.50");
    expect(formatMoney(12900, "USD", true)).toBe("$12.9K");
    expect(formatMoney(250, "GBP")).toBe("£250.00");
    expect(formatMoney(10000, "USD", true)).toBe("$10K");
    expect(formatMoney(2500, "USD", true)).toBe("$2.5K");
    expect(formatMoney(0, "USD", true)).toBe("$0");
    expect(formatMoney(560, "USD", false, true)).toBe("$560");
    expect(formatPercent(0.4215)).toBe("42.2%");
  });

  it("picks round axis steps that cover the data", () => {
    expect(niceTicks(0, 4300)).toEqual([0, 2000, 4000, 6000]);
    expect(niceTicks(0, 0.62)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    expect(niceTicks(0, 100)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(-0.1, 0.4)).toEqual([-0.2, 0, 0.2, 0.4]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
  });

  it("describes how overdue an invoice is in plain words", () => {
    expect(agingLabel("Current")).toBe("Not due yet");
    expect(agingLabel("1 - 30")).toBe("1–30 days late");
    expect(agingLabel("91 and over")).toBe("91+ days late");
    expect(agingLabel("Something else")).toBe("Something else");
  });
});
