import { describe, it, expect } from "vitest";
import {
  monthlyIndex,
  blendIndex,
  forecastUnits,
  deseasonalise,
  seasonalRunoutDate,
  FLAT_INDEX,
  SEASONAL_MAX,
} from "./seasonality";

// Build daily sales: `perMonth[m]` units spread as one row on the 15th of month m,
// for each year given.
function sales(perMonth: number[], years: number[]) {
  const out: { date: string; unitsSold: number }[] = [];
  for (const y of years) {
    for (let m = 0; m < 12; m++) {
      if (perMonth[m]! > 0)
        out.push({ date: `${y}-${String(m + 1).padStart(2, "0")}-15`, unitsSold: perMonth[m]! });
    }
  }
  return out;
}

describe("monthlyIndex", () => {
  it("keeps a November peak that repeats across years", () => {
    // Flat 100/month except Nov (index 10) = 150, consistent both years.
    const perMonth = Array(12).fill(100);
    perMonth[10] = 150;
    const idx = monthlyIndex(sales(perMonth, [2024, 2025]))!;
    expect(idx).not.toBeNull();
    const mean = idx.reduce((a, b) => a + b, 0) / 12;
    expect(mean).toBeGreaterThan(0.9);
    expect(mean).toBeLessThan(1.2);
    expect(idx[10]).toBeGreaterThan(1.35); // Nov elevated (~1.44×)
    expect(idx[10]).toBeLessThan(1.6);
    expect(idx[10]).toBeGreaterThan(idx[9]!);
  });

  it("dampens a month that spiked in only one year (fluke, not a season)", () => {
    // May (index 4) is normal one year, triple the next → years disagree → shrink to ~1.
    // November is consistently high both years → kept.
    const y1 = Array(12).fill(100);
    y1[4] = 100;
    y1[10] = 150;
    const y2 = Array(12).fill(100);
    y2[4] = 250;
    y2[10] = 150;
    const out: { date: string; unitsSold: number }[] = [];
    for (let m = 0; m < 12; m++) {
      out.push({ date: `2024-${String(m + 1).padStart(2, "0")}-15`, unitsSold: y1[m]! });
      out.push({ date: `2025-${String(m + 1).padStart(2, "0")}-15`, unitsSold: y2[m]! });
    }
    const idx = monthlyIndex(out)!;
    expect(idx[4]).toBeLessThan(1.15); // May pulled back to ~neutral despite the spike
    expect(idx[10]).toBeGreaterThan(1.25); // Nov (consistent) still elevated
    expect(idx[10]! - idx[4]!).toBeGreaterThan(0.2); // the consistent season clearly outranks the fluke
  });

  it("clamps a one-off spike so it can't distort the curve", () => {
    const perMonth = Array(12).fill(100);
    perMonth[4] = 100000; // absurd May spike
    const idx = monthlyIndex(sales(perMonth, [2024, 2025]))!;
    expect(idx[4]).toBeLessThanOrEqual(SEASONAL_MAX + 1e-9);
  });

  it("returns null when history is too thin", () => {
    expect(monthlyIndex([{ date: "2025-11-15", unitsSold: 5 }])).toBeNull();
  });
});

describe("blendIndex", () => {
  const store = (() => {
    const p = Array(12).fill(100);
    p[10] = 200;
    return monthlyIndex(sales(p, [2024, 2025]))!;
  })();
  const flatSku = monthlyIndex(sales(Array(12).fill(50), [2024, 2025]))!; // no seasonality

  it("a high-volume flat SKU stays near 1.0 in November (not over-ordered)", () => {
    const blended = blendIndex(flatSku, store, 100000); // lots of own data → trust itself
    expect(blended[10]).toBeCloseTo(1, 1);
  });

  it("a thin SKU leans on the store curve", () => {
    const blended = blendIndex(flatSku, store, 1); // almost no own data
    expect(blended[10]).toBeGreaterThan(1.3); // pulled toward store's Nov peak
  });

  it("falls back to flat when nothing is available", () => {
    expect(blendIndex(null, null, 0)).toEqual(FLAT_INDEX);
  });
});

describe("forecast + runout", () => {
  const idx = Array(12).fill(1);
  idx[10] = 2; // November is 2× (using a raw index for arithmetic clarity)

  it("forecastUnits applies the month multiplier", () => {
    // 10 days in October (1×) then into November — first 10 days = 10 units at 1/day baseline
    const oct1 = new Date(Date.UTC(2026, 9, 1));
    expect(forecastUnits(1, idx, oct1, 10)).toBeCloseTo(10, 5);
    // 5 days starting Nov 1 at 2× = 10 units
    const nov1 = new Date(Date.UTC(2026, 10, 1));
    expect(forecastUnits(1, idx, nov1, 5)).toBeCloseTo(10, 5);
  });

  it("deseasonalise divides out the current month's factor", () => {
    const nov = new Date(Date.UTC(2026, 10, 15));
    expect(deseasonalise(2, idx, nov)).toBeCloseTo(1, 5); // 2/day in Nov (2×) = 1/day baseline
  });

  it("seasonalRunoutDate consumes stock faster in a peak month", () => {
    const nov1 = new Date(Date.UTC(2026, 10, 1));
    // 10 units at baseline 1/day × 2 (Nov) = 5 days → runout ~Nov 6
    const out = seasonalRunoutDate(10, 1, idx, nov1)!;
    expect(out).not.toBeNull();
    const days = Math.round((out.getTime() - nov1.getTime()) / 86400000);
    expect(days).toBe(5);
  });
});
