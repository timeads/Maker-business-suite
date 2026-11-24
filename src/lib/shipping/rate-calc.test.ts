import { describe, expect, it } from "vitest";
import type { LabelAddress } from "./easypost";
import type { SavedBox } from "./labels";
import { calcRequest, calcRows, stateForZip, type CalcInput } from "./rate-calc";
import type { MergedRate } from "./sources/types";

const home: LabelAddress = {
  name: "Wild Thread",
  street1: "1 Mill Lane",
  city: "Hudson",
  state: "NY",
  zip: "12534",
  country: "US",
  phone: "518-555-0100",
};
const box: SavedBox = {
  id: "b0000000-0000-4000-8000-000000000001",
  name: "Medium box",
  kind: "box",
  length_in: 16,
  width_in: 12,
  height_in: 10,
  empty_weight_oz: 9,
  is_default: true,
} as SavedBox;
const input = (over: Partial<CalcInput> = {}): CalcInput => ({
  fromZip: "",
  toZip: "90210",
  weightLb: "2",
  weightOz: "4",
  boxId: "",
  length: "12",
  width: "9",
  height: "4",
  residential: true,
  signature: "none",
  ...over,
});

describe("stateForZip", () => {
  it("finds the state a ZIP is in", () => {
    expect(stateForZip("12534")).toBe("NY");
    expect(stateForZip("90210")).toBe("CA");
    expect(stateForZip(" 78701 ")).toBe("TX");
    expect(stateForZip("19143-1234")).toBe("PA");
    expect(stateForZip("00501")).toBe("NY");
  });

  it("is nothing for what isn't a US ZIP", () => {
    expect(stateForZip("1234")).toBeNull();
    expect(stateForZip("M5V 2T6")).toBeNull();
    expect(stateForZip("")).toBeNull();
    expect(stateForZip("00000")).toBeNull();
  });
});

describe("calcRequest", () => {
  it("asks for a ZIP-only destination from the workspace's own address", () => {
    const built = calcRequest(input(), home, [box]);
    if ("error" in built) throw new Error(built.error);
    expect(built.request.from).toEqual(home);
    expect(built.request.to).toEqual({
      name: "Rate quote",
      street1: "",
      city: "",
      state: "CA",
      zip: "90210",
      country: "US",
      residential: true,
    });
    expect(built.request.parcels).toEqual([
      { length: 12, width: 9, height: 4, weightTenthOz: 360 },
    ]);
    expect(built.request.signature).toBe("none");
    // Words only: no label format, no reference, nothing to buy with.
    expect(built.request.labelFormat).toBeUndefined();
    expect(built.boxName).toBeNull();
  });

  it("adds a saved box's own weight and uses its size", () => {
    const built = calcRequest(input({ boxId: box.id, length: "", width: "", height: "" }), home, [
      box,
    ]);
    if ("error" in built) throw new Error(built.error);
    expect(built.request.parcels[0]).toEqual({
      length: 16,
      width: 12,
      height: 10,
      weightTenthOz: 450,
    });
    expect(built.boxName).toBe("Medium box");
  });

  it("prices from another ZIP without the home street", () => {
    const built = calcRequest(input({ fromZip: "97205", signature: "adult" }), home, []);
    if ("error" in built) throw new Error(built.error);
    expect(built.request.from).toMatchObject({
      street1: "",
      city: "",
      state: "OR",
      zip: "97205",
      name: "Wild Thread",
    });
    expect(built.request.signature).toBe("adult");
  });

  it("says plainly what is missing", () => {
    expect(calcRequest(input({ toZip: "9021" }), home, [])).toEqual({
      error: "Enter the 5-digit US ZIP it's going to.",
    });
    expect(calcRequest(input({ fromZip: "abcde" }), home, [])).toMatchObject({
      error: expect.stringContaining("ships from"),
    });
    expect(calcRequest(input({ weightLb: "", weightOz: "" }), home, [])).toMatchObject({
      error: expect.stringContaining("weighs"),
    });
    expect(calcRequest(input({ length: "" }), home, [])).toMatchObject({
      error: expect.stringContaining("Pick a box"),
    });
    expect(calcRequest(input({ boxId: "gone" }), home, [box])).toMatchObject({
      error: expect.stringContaining("isn't on your list"),
    });
    expect(calcRequest(input(), { ...home, zip: "" }, [])).toMatchObject({
      error: expect.stringContaining("ship-from"),
    });
    expect(calcRequest(input({ weightLb: "150", boxId: box.id }), home, [box])).toMatchObject({
      error: expect.stringContaining("150 lb"),
    });
  });
});

describe("calcRows", () => {
  const rate = (over: Partial<MergedRate>): MergedRate =>
    ({
      id: "rate_secret",
      carrier: "UPS",
      carrierCode: "UPS",
      service: "03",
      name: "UPS Ground",
      price: "12.40",
      currency: "USD",
      days: 4,
      source: "ups",
      ref: { secret: "x" },
      ...over,
    }) as MergedRate;

  it("puts the cheapest first and marks the cheapest and fastest", () => {
    const rows = calcRows([
      rate({}),
      rate({
        carrier: "USPS",
        name: "USPS Priority Mail",
        price: "9.85",
        days: 2,
        source: "easypost",
      }),
      rate({ name: "UPS Next Day Air", price: "41.00", days: 1 }),
    ]);
    expect(rows.map((row) => row.service)).toEqual([
      "USPS Priority Mail",
      "UPS Ground",
      "UPS Next Day Air",
    ]);
    expect(rows.map((row) => row.cheapest)).toEqual([true, false, false]);
    expect(rows.map((row) => row.fastest)).toEqual([false, false, true]);
    expect(rows[0]).toMatchObject({ days: "About 2 days", mark: { key: "usps" } });
  });

  it("carries only words: no rate id and nothing a purchase could use", () => {
    const [row] = calcRows([
      rate({ others: [{ source: "redo", price: "13.10" }], note: "Redo adds a fee" }),
    ]);
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("ref");
    expect(JSON.stringify(row)).not.toContain("secret");
    expect(row.others).toEqual([{ source: "redo", price: "13.10" }]);
    expect(row.note).toBe("Redo adds a fee");
  });

  it("is empty when nobody quoted", () => {
    expect(calcRows([])).toEqual([]);
  });
});
