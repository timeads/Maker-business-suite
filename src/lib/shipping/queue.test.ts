import { describe, expect, it } from "vitest";
import {
  addDays,
  cleanSearch,
  formatHoldDate,
  formatWeight,
  holdChoices,
  holdState,
  inQueueView,
  isHoldDate,
  isInternational,
  isPriority,
  nextWeekday,
  queueCounts,
  queuePlace,
  shipStatus,
  todayIn,
  type QueueFacts,
} from "./queue";

const NY = "America/New_York";
const order = (over: Partial<QueueFacts> = {}): QueueFacts => ({
  units_left: 2,
  cancelled: false,
  paid: true,
  on_hold: false,
  hold_until: null,
  pickup: false,
  pickup_ready_at: null,
  picked_up_at: null,
  shipping_method: "Standard",
  country_code: "US",
  ...over,
});

describe("holds that end on a date", () => {
  it("offers tomorrow, next Monday and no end", () => {
    expect(holdChoices("2026-11-20")).toEqual([
      { label: "Tomorrow", until: "2026-11-21" },
      { label: "Next Monday", until: "2026-11-23" },
      { label: "Until I release it", until: null },
    ]);
    // On a Monday, "next Monday" is a week away, not today.
    expect(nextWeekday("2026-11-23", 1)).toBe("2026-11-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("only takes a real day after today", () => {
    expect(isHoldDate("2026-11-24", "2026-11-23")).toBe(true);
    expect(isHoldDate("2026-11-23", "2026-11-23")).toBe(false);
    expect(isHoldDate("2026-02-30", "2026-01-01")).toBe(false);
    expect(isHoldDate("tomorrow", "2026-01-01")).toBe(false);
  });

  it("is held until its day arrives, then back in the queue and saying so", () => {
    const held = order({ on_hold: true, hold_until: "2026-11-25" });
    expect(holdState(held, "2026-11-24")).toBe("held");
    expect(inQueueView(held, "ready", "2026-11-24", "US")).toBe(false);
    expect(inQueueView(held, "hold", "2026-11-24", "US")).toBe(true);
    expect(holdState(held, "2026-11-25")).toBe("back");
    expect(inQueueView(held, "ready", "2026-11-25", "US")).toBe(true);
    expect(inQueueView(held, "hold", "2026-11-25", "US")).toBe(false);
    expect(holdState(order({ on_hold: true }), "2099-01-01")).toBe("held");
    expect(holdState(order({ hold_until: "2020-01-01" }), "2026-01-01")).toBe("none");
  });

  it("comes back at local midnight on the day the clocks go back", () => {
    // 1 Nov 2026 in New York has 25 hours: midnight is 04:00 UTC, the next is 05:00 UTC.
    const held = order({ on_hold: true, hold_until: "2026-11-01" });
    const at = (iso: string) => holdState(held, todayIn(NY, new Date(iso)));
    expect(at("2026-11-01T03:59:00Z")).toBe("held");
    expect(at("2026-11-01T04:00:00Z")).toBe("back");

    const monday = order({ on_hold: true, hold_until: "2026-11-02" });
    // 24 hours after that midnight it is still Sunday there.
    expect(holdState(monday, todayIn(NY, new Date("2026-11-02T04:30:00Z")))).toBe("held");
    expect(holdState(monday, todayIn(NY, new Date("2026-11-02T05:00:00Z")))).toBe("back");
    // "Tomorrow" chosen during the long day is the next date, not 24 hours on.
    const sunday = todayIn(NY, new Date("2026-11-01T04:30:00Z"));
    expect(holdChoices(sunday)[0].until).toBe("2026-11-02");
  });

  it("comes back at local midnight on the day the clocks go forward", () => {
    // 8 Mar 2026 in New York has 23 hours: it starts 05:00 UTC and ends 04:00 UTC.
    const held = order({ on_hold: true, hold_until: "2026-03-09" });
    const at = (iso: string) => holdState(held, todayIn(NY, new Date(iso)));
    expect(todayIn(NY, new Date("2026-03-08T05:00:00Z"))).toBe("2026-03-08");
    expect(at("2026-03-09T03:59:00Z")).toBe("held");
    expect(at("2026-03-09T04:00:00Z")).toBe("back");
    expect(formatHoldDate("2026-03-09")).toBe("Mon, Mar 9");
  });
});

describe("the to-ship queue", () => {
  it("knows a rush order and an order going abroad", () => {
    expect(isPriority("UPS Next Day Air")).toBe(true);
    expect(isPriority("Expedited")).toBe(true);
    expect(isPriority("Standard")).toBe(false);
    expect(isPriority(null)).toBe(false);
    expect(isInternational("CA", "US")).toBe(true);
    expect(isInternational("us", "US")).toBe(false);
    expect(isInternational("US", "CA")).toBe(true);
    expect(isInternational(null, "US")).toBe(false);
  });

  it("puts each order under the right chips", () => {
    const today = "2026-11-23";
    const views = (o: QueueFacts) =>
      (["ready", "pickup", "priority", "unpaid", "hold", "international", "all"] as const).filter(
        (view) => inQueueView(o, view, today, "US"),
      );
    expect(views(order())).toEqual(["ready", "all"]);
    expect(views(order({ shipping_method: "Express", country_code: "CA" }))).toEqual([
      "ready",
      "priority",
      "international",
      "all",
    ]);
    expect(views(order({ pickup: true }))).toEqual(["pickup", "all"]);
    expect(views(order({ paid: false }))).toEqual(["unpaid", "all"]);
    expect(views(order({ on_hold: true, shipping_method: "Rush" }))).toEqual(["hold", "all"]);
    // Sent, cancelled or collected: nothing left to do.
    expect(views(order({ units_left: 0 }))).toEqual([]);
    expect(views(order({ cancelled: true }))).toEqual([]);
    expect(views(order({ pickup: true, picked_up_at: "2026-11-22T15:00:00Z" }))).toEqual([]);
  });

  it("lists orders the signature rule applies to, while they're ready to post", () => {
    const today = "2026-11-23";
    const dear = order({ order_total: 318.6 });
    const sig = (o: QueueFacts, over: number | null) =>
      inQueueView(o, "signature", today, "US", over);
    expect(sig(dear, 250)).toBe(true);
    // At the amount exactly counts, as on the order page; a sale that came as text is still a number.
    expect(sig(order({ order_total: 250 }), 250)).toBe(true);
    expect(sig(order({ order_total: "318.60" }), 250)).toBe(true);
    expect(sig(order({ order_total: 249.99 }), 250)).toBe(false);
    // No rule, or no total to hold against it: never.
    expect(sig(dear, null)).toBe(false);
    expect(inQueueView(dear, "signature", today, "US")).toBe(false);
    expect(sig(order(), 250)).toBe(false);
    expect(sig(order({ order_total: null }), 0)).toBe(false);
    // Only orders that are ready to post: not held, unpaid, a pickup or finished.
    expect(sig(order({ order_total: 400, on_hold: true }), 250)).toBe(false);
    expect(sig(order({ order_total: 400, paid: false }), 250)).toBe(false);
    expect(sig(order({ order_total: 400, pickup: true }), 250)).toBe(false);
    expect(sig(order({ order_total: 400, units_left: 0 }), 250)).toBe(false);
    // A hold whose day has come is back in it.
    expect(sig(order({ order_total: 400, on_hold: true, hold_until: today }), 250)).toBe(true);
    // It stays under Ready to ship as well.
    expect(inQueueView(dear, "ready", today, "US", 250)).toBe(true);
  });

  it("counts the signature chip like the others", () => {
    const orders = [order({ order_total: 300 }), order({ order_total: 20 }), order()];
    expect(queueCounts(orders, "2026-11-23", "US", 250)).toMatchObject({ ready: 3, signature: 1 });
    expect(queueCounts(orders, "2026-11-23", "US")).toMatchObject({ ready: 3, signature: 0 });
  });

  it("counts every chip in one pass", () => {
    const counts = queueCounts(
      [order(), order({ pickup: true }), order({ on_hold: true }), order({ units_left: 0 })],
      "2026-11-23",
      "US",
    );
    expect(counts).toMatchObject({ ready: 1, pickup: 1, hold: 1, all: 3, unpaid: 0 });
  });

  it("names where an order stands", () => {
    const items = [{ qty: 2, left: 2 }];
    const today = "2026-11-23";
    expect(shipStatus({ ...order(), items }, today).label).toBe("Not shipped");
    expect(
      shipStatus({ ...order({ units_left: 1 }), items: [{ qty: 2, left: 1 }] }, today).label,
    ).toBe("Partly shipped");
    expect(shipStatus({ ...order({ units_left: 0 }), items }, today).label).toBe("Shipped");
    expect(shipStatus({ ...order({ on_hold: true }), items }, today).label).toBe("On hold");
    expect(shipStatus({ ...order({ cancelled: true }), items }, today).label).toBe("Cancelled");
    expect(
      shipStatus({ ...order({ picked_up_at: "2026-11-22T15:00:00Z" }), items }, today).key,
    ).toBe("picked_up");
  });

  it("keeps a search to what an order number, name or email can hold", () => {
    expect(cleanSearch("  #1042 ")).toBe("#1042");
    expect(cleanSearch("sam+rugs@example.com")).toBe("sam+rugs@example.com");
    expect(cleanSearch("a,b(c)%*\\d")).toBe("a b c d");
    expect(cleanSearch("Zoë O'Neil")).toBe("Zoë O'Neil");
    expect(cleanSearch(undefined)).toBe("");
  });

  it("says a weight the way a packer would", () => {
    expect(formatWeight(1361, true)).toBe("3 lb");
    expect(formatWeight(500, true)).toBe("1 lb 2 oz");
    expect(formatWeight(100, true)).toBe("4 oz");
    expect(formatWeight(1250, false)).toBe("1.3 kg");
    expect(formatWeight(250, false)).toBe("250 g");
    expect(formatWeight(0, true)).toBe("");
  });
});

describe("stepping from one order to the next", () => {
  const rows = [
    { id: "a", placed_at: "2026-11-01T10:00:00Z" },
    { id: "b", placed_at: "2026-11-02T10:00:00Z" },
    { id: "c", placed_at: "2026-11-03T10:00:00Z" },
  ];

  it("finds the neighbours of an order in the list", () => {
    expect(queuePlace(rows, rows[1])).toEqual({ position: 2, total: 3, prev: "a", next: "c" });
    expect(queuePlace(rows, rows[0])).toEqual({ position: 1, total: 3, prev: null, next: "b" });
    expect(queuePlace(rows, rows[2])).toEqual({ position: 3, total: 3, prev: "b", next: null });
  });

  it("still knows what comes next once the order has left the list", () => {
    const sent = { id: "x", placed_at: "2026-11-02T12:00:00Z" };
    expect(queuePlace(rows, sent)).toEqual({ position: null, total: 3, prev: "b", next: "c" });
    const newest = { id: "z", placed_at: "2026-11-09T12:00:00Z" };
    expect(queuePlace(rows, newest)).toEqual({ position: null, total: 3, prev: "c", next: null });
  });

  it("breaks a tie on the time by id, the way the list is sorted", () => {
    const twin = { id: "bb", placed_at: "2026-11-02T10:00:00Z" };
    expect(queuePlace(rows, twin)).toMatchObject({ prev: "b", next: "c" });
  });

  it("copes with an empty list", () => {
    expect(queuePlace([], rows[0])).toEqual({ position: null, total: 0, prev: null, next: null });
  });
});
