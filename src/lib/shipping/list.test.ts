import { describe, expect, it } from "vitest";
import { listService, marginOf, marginText, orderAge, updatedAgo } from "./list";

const NY = "America/New_York";
const usd = (amount: number) => `$${amount.toFixed(2)}`;

describe("how old an order is", () => {
  const now = new Date("2026-11-24T17:00:00Z");
  it("counts minutes, hours and days", () => {
    expect(orderAge("2026-11-24T16:59:30Z", now, NY)).toBe("just now");
    expect(orderAge("2026-11-24T16:48:00Z", now, NY)).toBe("12m ago");
    expect(orderAge("2026-11-24T13:00:00Z", now, NY)).toBe("4h ago");
    expect(orderAge("2026-11-24T11:00:01Z", now, NY)).toBe("5h ago");
    expect(orderAge("2026-11-23T17:00:00Z", now, NY)).toBe("1d ago");
    expect(orderAge("2026-11-19T09:00:00Z", now, NY)).toBe("5d ago");
  });

  it("becomes the date after six days, in the workspace's own time", () => {
    // 03:30 UTC on the 13th is still the evening of the 12th in New York.
    expect(orderAge("2026-11-13T03:30:00Z", now, NY)).toBe("Nov 12");
    expect(orderAge("2026-11-13T03:30:00Z", now, "UTC")).toBe("Nov 13");
    expect(orderAge("2025-12-31T20:00:00Z", now, NY)).toBe("Dec 31, 2025");
  });

  it("is steady across a clock change, and says nothing for nonsense", () => {
    // Clocks went back on Nov 1, 2026: 25 real hours is still one day.
    expect(orderAge("2026-10-31T12:00:00Z", new Date("2026-11-01T13:00:00Z"), NY)).toBe("1d ago");
    expect(orderAge("not a date", now, NY)).toBe("");
    // A clock that is a little behind never says "-1m ago".
    expect(orderAge("2026-11-24T17:00:20Z", now, NY)).toBe("just now");
  });
});

describe("when the list was read", () => {
  it("says now, minutes, then hours", () => {
    expect(updatedAgo(0)).toBe("Updated now");
    expect(updatedAgo(-500)).toBe("Updated now");
    expect(updatedAgo(59_000)).toBe("Updated now");
    expect(updatedAgo(3 * 60_000 + 10)).toBe("Updated 3 min ago");
    expect(updatedAgo(2 * 3_600_000 + 5)).toBe("Updated 2 hr ago");
  });
});

describe("margin", () => {
  it("is what the shopper paid less the label, to the cent", () => {
    expect(marginOf(1400, 943)).toEqual({ cents: 457, short: false });
    expect(marginText(marginOf(1400, 943)!, usd)).toBe("+$4.57 margin");
    expect(marginOf(1400, 1400)).toEqual({ cents: 0, short: false });
  });

  it("is short when the label costs more, free shipping included", () => {
    expect(marginOf(800, 920)).toEqual({ cents: 120, short: true });
    expect(marginText(marginOf(800, 920)!, usd)).toBe("−$1.20 margin");
    expect(marginOf(0, 500)).toEqual({ cents: 500, short: true });
  });

  it("is nothing when either side isn't known", () => {
    expect(marginOf(null, 500)).toBeNull();
    expect(marginOf(500, null)).toBeNull();
    expect(marginOf(Number.NaN, 500)).toBeNull();
  });
});

describe("a service's name in the list", () => {
  it("puts the carrier in front once and drops the source's tag", () => {
    expect(listService("UPS", "Ground")).toBe("UPS Ground");
    expect(listService("UPS", "UPS Ground")).toBe("UPS Ground");
    expect(listService("UPS", "UPS Ground · Redo")).toBe("UPS Ground");
    expect(listService("USPS", "Ground Advantage")).toBe("USPS Ground Advantage");
  });

  it("shortens the long USPS names", () => {
    expect(listService("USPS", "Priority Mail")).toBe("USPS Priority");
    expect(listService("USPS", "USPS Priority Mail Express")).toBe("USPS Express");
  });
});
