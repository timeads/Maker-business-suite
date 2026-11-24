import { describe, expect, it } from "vitest";
import { bestListQuote } from "./plan-quotes";
import type { SourceRate } from "./sources/types";

const rate = (over: Partial<SourceRate>): SourceRate => ({
  id: "rate_1",
  carrier: "UPS",
  carrierCode: "UPS",
  service: "03",
  name: "UPS Ground",
  price: "9.43",
  currency: "USD",
  days: 3,
  source: "ups",
  ref: { service_code: "03" },
  ...over,
});

describe("the list's best quote", () => {
  it("is the cheapest price from any account, in whole cents", () => {
    expect(
      bestListQuote([
        rate({
          id: "a",
          price: "12.10",
          source: "easypost",
          carrier: "USPS",
          name: "Priority Mail",
        }),
        rate({ id: "b" }),
        rate({ id: "c", price: "9.80", source: "redo", name: "UPS Ground · Redo" }),
      ]),
    ).toEqual({
      status: "ok",
      source: "ups",
      carrier: "UPS",
      service: "UPS Ground",
      cents: 943,
      currency: "USD",
    });
  });

  it("keeps nothing that could buy a label: no rate id, no ids of the carrier's own", () => {
    const best = bestListQuote([rate({ id: "rate_secret", ref: { shipment_id: "shp_1" } })]);
    expect(JSON.stringify(best)).not.toMatch(/rate_secret|shp_1|ref/);
  });

  it("says so when nobody offered a price, or a price isn't one", () => {
    expect(bestListQuote([])).toEqual({ status: "none" });
    expect(bestListQuote([rate({ price: "call us" })])).toEqual({ status: "none" });
  });
});
