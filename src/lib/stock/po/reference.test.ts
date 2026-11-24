import { describe, expect, it } from "vitest";
import {
  formatReference,
  isOwnReference,
  referenceMonth,
  supplierPrefix,
  tidyReference,
} from "./reference";

describe("purchase order references", () => {
  it("takes the first two letters of the supplier's name", () => {
    expect(supplierPrefix("Kestrel Mills")).toBe("KE");
    expect(supplierPrefix("  loom & co")).toBe("LO");
    expect(supplierPrefix("3M")).toBe("MX");
    expect(supplierPrefix("毛线 Q")).toBe("QX");
    expect(supplierPrefix("1234")).toBe("PO");
    expect(supplierPrefix("")).toBe("PO");
  });

  it("stamps the month in UTC", () => {
    expect(referenceMonth(new Date("2026-11-30T23:59:00Z"))).toBe("202611");
    expect(referenceMonth(new Date("2026-12-01T00:00:00Z"))).toBe("202612");
    expect(referenceMonth(new Date("2027-01-05T10:00:00Z"))).toBe("202701");
  });

  it("puts the three parts together", () => {
    const reference = formatReference("Kestrel Mills", new Date("2026-11-17T12:00:00Z"), "a7a950");
    expect(reference).toBe("KE-202611-A7A950");
    expect(isOwnReference(reference)).toBe(true);
    expect(isOwnReference("KE-202611-SEA")).toBe(false);
  });

  it("accepts a reference written elsewhere, tidied", () => {
    expect(tidyReference("  KE-202603-E5A62F-SEA ")).toBe("KE-202603-E5A62F-SEA");
    expect(tidyReference("PO  7")).toBe("PO 7");
    expect(tidyReference("x")).toBeNull();
    expect(tidyReference("a".repeat(41))).toBeNull();
    expect(tidyReference("bad\u0007ref")).toBeNull();
  });
});
