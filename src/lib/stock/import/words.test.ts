import { describe, expect, it } from "vitest";
import { countLines } from "./words";

describe("what an import came to, in words", () => {
  it("says what will happen before, and what did after", () => {
    const counts = { new: 2, changed: 1, same: 0 };
    expect(countLines("suppliers", counts, false)).toEqual([
      "2 new suppliers to add",
      "1 supplier to change",
    ]);
    expect(countLines("suppliers", counts, true)).toEqual([
      "2 new suppliers added",
      "1 supplier changed",
    ]);
  });
  it("covers orders, deliveries and the suppliers a file brings with it", () => {
    expect(
      countLines("orders", { new: 3, changed: 0, same: 1, lines: 40, suppliers_added: 1 }, false),
    ).toEqual([
      "3 orders to bring in, with 40 lines",
      "1 order already here, left as it is",
      "1 supplier named in the file will be added",
    ]);
    expect(countLines("deliveries", { new: 0, changed: 0, same: 2, unmatched: 1 }, true)).toEqual([
      "2 deliveries already here",
      "1 delivery left out: no order brought in from a spreadsheet has that reference and item",
    ]);
  });
  it("says so when a file would change nothing", () => {
    expect(countLines("counts", { new: 0, changed: 0, same: 0 }, false)).toEqual([
      "Nothing in this file would change anything.",
    ]);
  });
});
