import { describe, it, expect } from "vitest";
import { daysBetween, median, observedLeadTimeDays } from "./lead-time";

const d = (s: string) => new Date(s);

describe("daysBetween", () => {
  it("counts whole days", () => {
    expect(daysBetween(d("2026-07-01T00:00:00Z"), d("2026-07-15T00:00:00Z"))).toBe(14);
  });
  it("rounds partial days", () => {
    expect(daysBetween(d("2026-07-01T00:00:00Z"), d("2026-07-08T10:00:00Z"))).toBe(7);
  });
});

describe("median", () => {
  it("returns null for empty", () => {
    expect(median([])).toBeNull();
  });
  it("odd length", () => {
    expect(median([10, 2, 6])).toBe(6);
  });
  it("even length averages the middle two (rounded)", () => {
    expect(median([4, 6, 8, 10])).toBe(7);
  });
});

describe("observedLeadTimeDays", () => {
  it("computes median lead time and sample size", () => {
    const samples = [
      { sentAt: d("2026-06-01"), arrivedAt: d("2026-06-11") }, // 10
      { sentAt: d("2026-06-01"), arrivedAt: d("2026-06-15") }, // 14
      { sentAt: d("2026-06-01"), arrivedAt: d("2026-06-13") }, // 12
    ];
    expect(observedLeadTimeDays(samples)).toEqual({ days: 12, sampleSize: 3 });
  });

  it("drops inverted (arrived-before-sent) samples", () => {
    const samples = [
      { sentAt: d("2026-06-10"), arrivedAt: d("2026-06-01") }, // dropped
      { sentAt: d("2026-06-01"), arrivedAt: d("2026-06-09") }, // 8
    ];
    expect(observedLeadTimeDays(samples)).toEqual({ days: 8, sampleSize: 1 });
  });

  it("returns null with no usable samples", () => {
    expect(observedLeadTimeDays([])).toBeNull();
  });
});
