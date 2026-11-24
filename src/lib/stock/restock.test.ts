import { describe, expect, it } from "vitest";
import { lineState, restockWords, summarizeRestock, type RestockLine } from "./restock";

// TuftStock's cases for its help-desk feed (incoming/summary.test.ts), on the suite's rows.
const TODAY = "2026-11-20";
const line = (overrides: Partial<RestockLine> = {}): RestockLine => ({
  itemId: "rug",
  name: "Wool rug · Large",
  sku: "RUG-L",
  onHand: 0,
  qtyOrdered: 10,
  qtyReceived: 0,
  status: "ordered",
  expectedOn: "2026-12-01",
  parcels: [],
  ...overrides,
});

describe("where an open line is", () => {
  it("is ordered until it has a parcel, then shipped, then arrived", () => {
    expect(lineState(line())).toEqual({ stage: "ordered", eta: "2026-12-01" });
    expect(lineState(line({ parcels: [{ arrivedOn: null, expectedOn: "2026-11-28" }] }))).toEqual({
      stage: "shipped",
      eta: "2026-11-28",
    });
    // A parcel with no date of its own falls back on the order's.
    expect(lineState(line({ parcels: [{ arrivedOn: null, expectedOn: null }] })).eta).toBe(
      "2026-12-01",
    );
    expect(
      lineState(
        line({
          parcels: [
            { arrivedOn: "2026-11-19", expectedOn: null },
            { arrivedOn: null, expectedOn: "2026-11-30" },
          ],
        }),
      ),
    ).toEqual({ stage: "arrived", eta: null });
  });
});

describe("what is on its way, per item", () => {
  it("adds up what is still to come and takes the soonest day and the furthest stage", () => {
    const rows = summarizeRestock(
      [
        line({ qtyOrdered: 10, qtyReceived: 4 }),
        line({ qtyOrdered: 5, parcels: [{ arrivedOn: null, expectedOn: "2026-11-25" }] }),
        line({ itemId: "yarn", name: "Yarn", sku: null, onHand: 3, expectedOn: null }),
      ],
      TODAY,
    );
    expect(rows).toEqual([
      {
        itemId: "rug",
        name: "Wool rug · Large",
        sku: "RUG-L",
        onHand: 0,
        incoming: 11,
        stage: "shipped",
        expected: "2026-11-25",
        late: false,
      },
      {
        itemId: "yarn",
        name: "Yarn",
        sku: null,
        onHand: 3,
        incoming: 10,
        stage: "ordered",
        expected: null,
        late: false,
      },
    ]);
  });

  it("leaves out drafts, finished orders and lines that have all arrived", () => {
    expect(
      summarizeRestock(
        [
          line({ status: "draft" }),
          line({ status: "closed" }),
          line({ status: "partial", qtyReceived: 10 }),
        ],
        TODAY,
      ),
    ).toEqual([]);
  });

  it("says late when the day has passed and nothing has arrived", () => {
    expect(summarizeRestock([line({ expectedOn: "2026-11-10" })], TODAY)[0]).toMatchObject({
      late: true,
      expected: "2026-11-10",
    });
    expect(
      summarizeRestock(
        [
          line({
            expectedOn: "2026-11-10",
            parcels: [{ arrivedOn: "2026-11-19", expectedOn: null }],
          }),
        ],
        TODAY,
      )[0],
    ).toMatchObject({ late: false, expected: null, stage: "arrived" });
  });
});

describe("in a few plain words", () => {
  const more = (overrides: object = {}) => ({
    ...summarizeRestock([line()], TODAY)[0],
    ...overrides,
  });
  it("says what's on the shelf and what's coming", () => {
    expect(restockWords({ onHand: 12, incoming: null })).toBe("12 on the shelf");
    expect(restockWords({ onHand: 0, incoming: null })).toBe(
      "none on the shelf, and none on order",
    );
    expect(restockWords({ onHand: 0, incoming: more() })).toBe(
      "none on the shelf; 10 more on order, due Dec 1",
    );
    expect(restockWords({ onHand: 2, incoming: more({ stage: "shipped", late: true }) })).toBe(
      "2 on the shelf; 10 more on the way, was due Dec 1",
    );
    expect(restockWords({ onHand: 0, incoming: more({ expected: null }) })).toBe(
      "none on the shelf; 10 more on order, with no date yet",
    );
    expect(restockWords({ onHand: 0, incoming: more({ stage: "arrived", expected: null }) })).toBe(
      "none on the shelf; 10 more have arrived and are being checked in",
    );
  });
});
