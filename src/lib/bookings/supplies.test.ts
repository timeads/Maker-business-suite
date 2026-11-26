import { describe, expect, it } from "vitest";
import {
  estimateOrderDays,
  onHand,
  project,
  suggestQty,
  weeklyRate,
  type ClassRun,
  type Entry,
  type Supply,
} from "./supplies";

const NOW = new Date("2027-03-01T15:00:00Z");
const day = (n: number, hour = 15) => new Date(Date.UTC(2027, 2, 1 + n, hour)).toISOString();
const supply: Supply = {
  id: "s1",
  per_student: 2,
  lead_time_days: 5,
  safety_stock: 4,
  coverage_days: 30,
  active: true,
  counts_from: day(-30),
};
const linked = new Set(["w1"]);
const run = (n: number, seats: number, over: Partial<ClassRun> = {}): ClassRun => ({
  service_id: "w1",
  starts_at: day(n),
  seats,
  cancelled: false,
  ...over,
});
const entry = (n: number, kind: Entry["kind"], qty: number): Entry => ({
  supply_id: "s1",
  kind,
  qty,
  at: day(n, 9),
});

describe("what's on hand", () => {
  it("starts from the last count, adds deliveries and takes off what classes used since", () => {
    const got = onHand(
      supply,
      [
        entry(-20, "count", 100),
        entry(-10, "count", 50),
        entry(-5, "received", 20),
        entry(-3, "adjustment", -2),
      ],
      [
        run(-15, 10),
        run(-8, 3),
        run(-2, 4, { cancelled: true }),
        run(-1, 5, { service_id: "w2" }),
        run(2, 6),
      ],
      linked,
      NOW,
    );
    // 50 counted, a class of 3 used 6, 20 came, 2 corrected off. The class before
    // the count, the cancelled one, another workshop's and the coming one don't count.
    expect(got).toEqual({ qty: 62, used: 6, short: 0, countedAt: day(-10, 9) });
  });

  it("never goes below nothing, and says how much was short", () => {
    const got = onHand(supply, [entry(-10, "count", 5)], [run(-5, 4)], linked, NOW);
    expect(got).toMatchObject({ qty: 0, used: 5, short: 3 });
  });

  it("ignores classes before the supply was added, and uses nothing for no linked workshop", () => {
    const fresh = { ...supply, counts_from: day(-6) };
    expect(onHand(fresh, [entry(-6, "count", 10)], [run(-7, 3)], linked, NOW).qty).toBe(10);
    expect(onHand(supply, [entry(-10, "count", 10)], [run(-5, 3)], new Set(), NOW).qty).toBe(10);
  });
});

describe("when it runs out", () => {
  it("finds the class that would dip into the buffer, and the order-by date before it", () => {
    const got = project(supply, 20, [run(3, 3), run(10, 4)], [], linked, NOW, "America/New_York");
    // 20 − 4 buffer = 16; −6 → 10; −8 → 2: fine. Add one more class:
    expect(got).toEqual({ status: "ok" });
    const short = project(supply, 20, [run(3, 3), run(10, 4), run(20, 2)], [], linked, NOW, "UTC");
    expect(short).toMatchObject({ status: "order_by", shortBy: 2 });
    if (short.status !== "ok") {
      expect(short.dipOn.toISOString()).toBe(day(20));
      expect(short.orderBy.toISOString()).toBe(day(15));
    }
  });

  it("counts an order from the end of its expected day, so one landing that day may be late", () => {
    const orders = [
      { supply_id: "s1", qty: 50, expected_on: "2027-03-21", status: "open" as const },
    ];
    const got = project(
      supply,
      20,
      [run(3, 3), run(10, 4), run(20, 2)],
      orders,
      linked,
      NOW,
      "UTC",
    );
    expect(got.status).toBe("order_by");
    const early = [{ ...orders[0], expected_on: "2027-03-20" }];
    // Expected the day before the class (it is on the 21st): it counts in time.
    expect(
      project(supply, 20, [run(3, 3), run(10, 4), run(20, 2)], early, linked, NOW, "UTC").status,
    ).toBe("ok");
  });

  it("says order now when the buffer is already gone, or the date has passed", () => {
    expect(project(supply, 3, [], [], linked, NOW, "UTC")).toMatchObject({
      status: "order_now",
      shortBy: 1,
    });
    expect(project(supply, 10, [run(2, 4)], [], linked, NOW, "UTC").status).toBe("order_now");
  });
});

describe("what to order", () => {
  it("covers the lead time and the coverage window at the usual rate, plus the buffer", () => {
    const rate = weeklyRate(
      [run(-7, 7), run(-14, 7), run(-60, 50), run(-3, 2, { cancelled: true })],
      linked,
      NOW,
    );
    expect(rate).toBe(14 / 8);
    // 1.75 a week = 0.25 a day; 35 days × 0.25 × 2 = 17.5, + 4 = 21.5, less 10 = 11.5 → 12
    expect(suggestQty(supply, rate, 10, 0)).toBe(12);
    expect(suggestQty(supply, rate, 10, 20)).toBe(0);
    expect(suggestQty({ ...supply, per_student: 0 }, rate, 0, 0)).toBe(0);
  });

  it("estimates the order-by from the usual rate when nothing booked runs it short", () => {
    // 0.5 used a day; (30 − 4) / 0.5 = 52 days, less 5 days' lead time.
    expect(estimateOrderDays(supply, 1.75, 30, 0)).toBe(47);
    expect(estimateOrderDays(supply, 0, 30, 0)).toBeNull();
  });
});
