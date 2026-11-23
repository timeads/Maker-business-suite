import { describe, expect, it } from "vitest";
import { mergeRates, serviceKey, sourceRateChoice } from "./rates";
import type { LabelSourceKey, SourceRate } from "./types";

const rate = (
  source: LabelSourceKey,
  carrier: string,
  name: string,
  price: string,
  extra: Partial<SourceRate> = {},
): SourceRate => ({
  id: `${source}_${name.replace(/[^A-Za-z0-9]/g, "")}_${price.replace(".", "")}`,
  carrier,
  carrierCode: carrier,
  service: name,
  name,
  price,
  currency: "USD",
  days: null,
  source,
  ref: { secret_looking: "source-side-id" },
  ...extra,
});
const rows = (list: SourceRate[]) =>
  mergeRates(list).map((r) => [r.source, r.name, r.price, r.others ?? null]);

describe("one price list from every source", () => {
  it("reads the same service the same way however it is spelled", () => {
    expect(serviceKey({ carrier: "UPS", name: "UPS 3 Day Select" })).toBe(
      serviceKey({ carrier: "UPS", name: "UPS 3day Select · Redo" }),
    );
    expect(serviceKey({ carrier: "UPS", name: "UPS Ground" })).not.toBe(
      serviceKey({ carrier: "FedEx", name: "UPS Ground" }),
    );
  });

  it("is cheapest first, each row saying where it comes from", () => {
    expect(
      rows([
        rate("easypost", "FedEx", "FedEx Ground", "12.00"),
        rate("ups", "UPS", "UPS Ground", "9.80"),
        rate("redo", "USPS", "USPS Ground Advantage", "8.15"),
      ]),
    ).toEqual([
      ["redo", "USPS Ground Advantage", "8.15", null],
      ["ups", "UPS Ground", "9.80", null],
      ["easypost", "FedEx Ground", "12.00", null],
    ]);
    expect(mergeRates([])).toEqual([]);
  });

  it("shows a service offered by several sources once, at the cheapest, with the others' prices", () => {
    expect(
      rows([
        rate("easypost", "UPS", "UPS Ground", "11.40"),
        rate("ups", "UPS", "UPS Ground", "9.80"),
        rate("redo", "UPS", "UPS Ground", "10.10"),
        // Two carrier accounts in Redo: only its cheaper one is "the other price".
        rate("redo", "UPS", "UPS Ground", "10.60"),
      ]),
    ).toEqual([
      [
        "ups",
        "UPS Ground",
        "9.80",
        [
          { source: "redo", price: "10.10" },
          { source: "easypost", price: "11.40" },
        ],
      ],
    ]);
    // Redo cheaper than the business's own account: Redo's row is the one kept.
    expect(
      rows([
        rate("ups", "UPS", "UPS 3 Day Select", "21.00"),
        rate("redo", "UPS", "UPS 3day Select", "19.50"),
      ]),
    ).toEqual([["redo", "UPS 3day Select", "19.50", [{ source: "ups", price: "21.00" }]]]);
  });

  it("on a tie keeps the most direct connection: own account, then EasyPost, then Redo", () => {
    const tie = (sources: LabelSourceKey[]) =>
      mergeRates(sources.map((source) => rate(source, "UPS", "UPS Ground", "10.00")))[0].source;
    expect(tie(["redo", "easypost", "ups"])).toBe("ups");
    expect(tie(["redo", "easypost"])).toBe("easypost");
    expect(tie(["easypost", "redo"])).toBe("easypost");
    // "8.4" and "8.40" are the same price.
    expect(
      mergeRates([
        rate("redo", "UPS", "UPS Ground", "8.4"),
        rate("ups", "UPS", "UPS Ground", "8.40"),
      ])[0].source,
    ).toBe("ups");
  });

  it("leaves out EasyPost's USPS when Redo quoted USPS, and keeps it when Redo didn't", () => {
    const easypostUsps = [
      rate("easypost", "USPS", "USPS Ground Advantage", "8.15"),
      rate("easypost", "USPS", "USPS Priority Mail", "10.40"),
      rate("easypost", "FedEx", "FedEx Ground", "12.00"),
    ];
    expect(rows([...easypostUsps, rate("redo", "USPS", "USPS Ground Advantage", "8.15")])).toEqual([
      // No "also EasyPost" either: its USPS rows are gone, Priority Mail included.
      ["redo", "USPS Ground Advantage", "8.15", null],
      ["easypost", "FedEx Ground", "12.00", null],
    ]);
    // Redo is down, or quoted only UPS: EasyPost's USPS stands.
    expect(rows([...easypostUsps, rate("redo", "UPS", "UPS Ground", "11.00")])).toEqual([
      ["easypost", "USPS Ground Advantage", "8.15", null],
      ["easypost", "USPS Priority Mail", "10.40", null],
      ["redo", "UPS Ground", "11.00", null],
      ["easypost", "FedEx Ground", "12.00", null],
    ]);
  });

  it("keeps the chosen row's own id and source-side ids, and shows the browser none of the latter", () => {
    const own = rate("ups", "UPS", "UPS Ground", "9.80", { ref: { service_code: "03" } });
    const [kept] = mergeRates([rate("easypost", "UPS", "UPS Ground", "11.40"), own]);
    expect(kept.id).toBe(own.id);
    expect(kept.ref).toEqual({ service_code: "03" });
    const shown = sourceRateChoice({ ...kept, note: "A word on the price" });
    expect(shown).toEqual({
      id: own.id,
      carrier: "UPS",
      name: "UPS Ground",
      price: "9.80",
      currency: "USD",
      days: null,
      source: "ups",
      note: "A word on the price",
      others: [{ source: "easypost", price: "11.40" }],
    });
    expect(JSON.stringify(shown)).not.toMatch(/service_code|ref|carrierCode/);
  });
});
