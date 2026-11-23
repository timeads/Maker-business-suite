import { describe, expect, it } from "vitest";
import { Money } from "./money";

describe("money as whole cents", () => {
  it("reads amounts exactly and writes two decimals", () => {
    expect(new Money("12.5").toFixed(2)).toBe("12.50");
    expect(new Money("-0.07").toFixed(2)).toBe("-0.07");
    expect(new Money(1200.5).toString()).toBe("1200.50");
    expect(new Money("3").cents).toBe(300);
    expect(new Money(".5").cents).toBe(50);
    expect(new Money("10.005").toFixed(2)).toBe("10.01");
    expect(() => new Money("twelve")).toThrow(/Not an amount/);
    expect(() => new Money("")).toThrow(/Not an amount/);
  });

  it("adds and compares without floating-point drift", () => {
    expect(new Money("0.10").add("0.20").equals("0.30")).toBe(true);
    let total = new Money(0);
    for (let i = 0; i < 1000; i++) total = total.add("0.01");
    expect(total.toFixed(2)).toBe("10.00");
    expect(new Money("5").sub("7.25").toFixed(2)).toBe("-2.25");
    expect(new Money("-4").abs().neg().toFixed(2)).toBe("-4.00");
    expect(new Money("2").gt("1.99")).toBe(true);
    expect(new Money("2").lte(2)).toBe(true);
    expect(Money.min("3", "1.50", 2).toFixed(2)).toBe("1.50");
  });
});
