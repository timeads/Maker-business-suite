import { describe, expect, it } from "vitest";
import { parseBatchOrders } from "./batches";
import {
  BULK_LIMIT,
  bulkEstimate,
  cellRefusal,
  orderRefusal,
  planRefusal,
  priceMoved,
  runSummary,
  type BulkOrderFacts,
  type BulkPlanFacts,
  type BulkRow,
} from "./bulk";
import { parseSavedChoice } from "./choices";
import { NO_PLAN, type PlanCell } from "./list";

const fine: BulkOrderFacts = {
  cancelled: false,
  unitsLeft: 3,
  pickedUp: false,
  hold: "none",
  ruleHold: null,
  paid: true,
  pickup: false,
  abroad: false,
  partSent: false,
  labelOpen: false,
  togetherWith: [],
};
const planned: BulkPlanFacts = { noQuote: null, canCheck: true, address: "found", quote: "ok" };

describe("which orders a bulk run will buy for", () => {
  it("takes an ordinary paid order with a checked address and a price", () => {
    expect(orderRefusal(fine)).toBeNull();
    expect(planRefusal(planned)).toBeNull();
  });

  it("leaves out anything that needs a person, and says why", () => {
    const why = (over: Partial<BulkOrderFacts>) => orderRefusal({ ...fine, ...over });
    expect(why({ cancelled: true })).toMatch(/cancelled/);
    expect(why({ unitsLeft: 0 })).toMatch(/already gone/);
    expect(why({ pickedUp: true })).toMatch(/already gone/);
    expect(why({ hold: "held" })).toMatch(/on hold/);
    expect(why({ ruleHold: "Check the dye lot" })).toBe("A rule holds it: Check the dye lot");
    expect(why({ paid: false })).toMatch(/paid/);
    expect(why({ pickup: true })).toMatch(/collected/);
    expect(why({ abroad: true })).toMatch(/customs/);
    expect(why({ partSent: true })).toMatch(/Part of it/);
    expect(why({ labelOpen: true })).toMatch(/already being sorted out/);
    expect(why({ togetherWith: ["#1002", "#1003"] })).toMatch(/one parcel with #1002 and #1003/);
  });

  it("buys an order whose hold has ended", () => {
    expect(orderRefusal({ ...fine, hold: "back" })).toBeNull();
  });

  it("a label already under way is said before anything else", () => {
    expect(orderRefusal({ ...fine, labelOpen: true, hold: "held", paid: false })).toMatch(
      /already being sorted out/,
    );
  });

  it("needs a plan, an address the carriers know, and a standing price", () => {
    const why = (over: Partial<BulkPlanFacts>) => planRefusal({ ...planned, ...over });
    expect(why({ noQuote: "weight" })).toMatch(/weight/);
    expect(why({ noQuote: "box" })).toMatch(/Add a box/);
    expect(why({ address: "not_found" })).toMatch(/don't know its address/);
    expect(why({ address: "unchecked" })).toMatch(/hasn't been checked/);
    expect(why({ quote: "none" })).toMatch(/No carrier/);
    expect(why({ quote: "missing" })).toMatch(/hasn't been worked out/);
  });

  it("doesn't ask for an address check nobody connected can make", () => {
    expect(planRefusal({ ...planned, canCheck: false, address: "unchecked" })).toBeNull();
  });
});

describe("what the list can say before the server is asked", () => {
  const ok: PlanCell = {
    ...NO_PLAN,
    box: "Medium box",
    quote: {
      state: "ok",
      mark: { key: "ups", label: "UPS" },
      service: "UPS Ground",
      source: "UPS",
      price: "$9.43",
      cents: 943,
      currency: "USD",
      byRule: false,
      margin: null,
    },
    address: "found",
  };
  it("lets a priced, found order through and names what's missing otherwise", () => {
    expect(cellRefusal(ok)).toBeNull();
    expect(cellRefusal({ ...ok, address: null })).toBeNull();
    expect(cellRefusal({ ...ok, address: "not_found" })).toMatch(/don't know its address/);
    expect(cellRefusal({ ...ok, address: "waiting" })).toMatch(/still being worked out/);
    expect(cellRefusal({ ...ok, quote: { state: "waiting" } })).toMatch(/still being worked out/);
    expect(cellRefusal({ ...ok, quote: { state: "none" } })).toMatch(/No carrier/);
    expect(cellRefusal({ ...ok, quote: { state: "off", why: "Add a box." } })).toBe("Add a box.");
  });
});

describe("what a run would cost", () => {
  const row = (id: string, over: Partial<BulkRow> = {}): BulkRow => ({
    id,
    name: `#${id}`,
    refusal: null,
    cents: 1000,
    currency: "USD",
    ...over,
  });

  it("adds up the planned best quotes and names the orders left out", () => {
    const estimate = bulkEstimate([
      row("1", { cents: 943 }),
      row("2", { refusal: "It's on hold." }),
      row("3", { cents: 1257 }),
      row("4", { cents: null, currency: null }),
    ]);
    expect(estimate.buy.map((order) => order.id)).toEqual(["1", "3"]);
    expect(estimate.cents).toBe(2200);
    expect(estimate.currency).toBe("USD");
    expect(estimate.leftOut).toEqual([
      { id: "2", name: "#2", why: "It's on hold." },
      { id: "4", name: "#4", why: "It has no price yet." },
    ]);
  });

  it("stops at the limit, and says so for the rest", () => {
    const many = Array.from({ length: BULK_LIMIT + 2 }, (_, index) => row(String(index)));
    const estimate = bulkEstimate(many);
    expect(estimate.buy).toHaveLength(BULK_LIMIT);
    expect(estimate.cents).toBe(BULK_LIMIT * 1000);
    expect(estimate.leftOut).toHaveLength(2);
    expect(estimate.leftOut[0].why).toMatch(/up to 25 labels/);
  });

  it("gives no total across currencies, and none for nothing", () => {
    expect(bulkEstimate([row("1"), row("2", { currency: "CAD" })])).toMatchObject({
      cents: null,
      currency: null,
    });
    expect(bulkEstimate([])).toMatchObject({ buy: [], cents: null, currency: null });
  });

  it("buys at a price that held or fell, and stops when it jumped", () => {
    expect(priceMoved(1000, 1000)).toBe(false);
    expect(priceMoved(1000, 700)).toBe(false);
    expect(priceMoved(1000, 1350)).toBe(false); // a quarter and a dollar: still fine
    expect(priceMoved(1000, 1351)).toBe(true);
    expect(priceMoved(400, 600)).toBe(false);
    expect(priceMoved(400, 601)).toBe(true);
  });

  it("sums up a finished run in a few words", () => {
    const money = (amount: number, currency: string) => `${currency} ${amount.toFixed(2)}`;
    expect(runSummary([], money)).toBe("Nothing was bought");
    expect(runSummary([{ status: "skipped", reason: "x" }], money)).toBe("Nothing was bought");
    expect(
      runSummary(
        [
          { status: "bought", service: "UPS Ground", price: "9.43", currency: "USD", number: 7 },
          { status: "unsure", reason: "x" },
          {
            status: "bought",
            service: "USPS Priority",
            price: "12.57",
            currency: "USD",
            number: 8,
          },
        ],
        money,
      ),
    ).toBe("2 labels bought · USD 22.00");
    expect(
      runSummary(
        [{ status: "bought", service: "UPS Ground", price: "9.43", currency: "USD", number: 7 }],
        money,
      ),
    ).toBe("1 label bought · USD 9.43");
  });
});

describe("a run as it is kept", () => {
  it("reads each order's outcome and ignores what isn't one", () => {
    expect(parseBatchOrders(null)).toEqual([]);
    expect(
      parseBatchOrders([
        {
          order_id: "a",
          name: "#1",
          status: "bought",
          service: "UPS Ground",
          price: "9.43",
          currency: "USD",
          shipment_number: 12,
        },
        { order_id: "b", name: "#2", status: "skipped", reason: "It's on hold." },
        { order_id: "c", status: "nonsense", price: "free", shipment_number: "x" },
        { name: "no id" },
        "junk",
      ]),
    ).toEqual([
      {
        orderId: "a",
        name: "#1",
        status: "bought",
        reason: null,
        service: "UPS Ground",
        price: "9.43",
        currency: "USD",
        shipmentNumber: 12,
      },
      {
        orderId: "b",
        name: "#2",
        status: "skipped",
        reason: "It's on hold.",
        service: null,
        price: null,
        currency: null,
        shipmentNumber: null,
      },
      {
        orderId: "c",
        name: "Order",
        status: "waiting",
        reason: null,
        service: null,
        price: null,
        currency: null,
        shipmentNumber: null,
      },
    ]);
  });
});

describe("a saved choice as it is kept", () => {
  const box = {
    box_id: null,
    length: 12,
    width: 9,
    height: 4,
    weight_tenth_oz: 320,
    items: { l1: 2 },
  };
  it("takes one to six boxes and fills in what was left to the plan", () => {
    expect(parseSavedChoice({ v: 1, boxes: [box] })).toEqual({
      v: 1,
      boxes: [box],
      signature: null,
      service: null,
    });
    expect(
      parseSavedChoice({ v: 1, boxes: [box], signature: "none", service: " UPS Ground " }),
    ).toMatchObject({ signature: "none", service: "UPS Ground" });
  });
  it("is nothing when it isn't usable", () => {
    expect(parseSavedChoice(null)).toBeNull();
    expect(parseSavedChoice({ v: 1, boxes: [] })).toBeNull();
    expect(parseSavedChoice({ v: 1, boxes: Array(7).fill(box) })).toBeNull();
    expect(parseSavedChoice({ v: 1, boxes: [{ ...box, length: 0 }] })).toBeNull();
    expect(parseSavedChoice({ v: 1, boxes: [{ ...box, box_id: "abc" }] })).toBeNull();
    expect(parseSavedChoice({ v: 1, boxes: [box], signature: "maybe" })).toBeNull();
    expect(parseSavedChoice({ v: 2, boxes: [box] })).toBeNull();
  });
});
