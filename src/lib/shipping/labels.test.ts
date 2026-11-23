import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHIPPING_SETTINGS,
  parseShippingSettings,
  shipFromCityLine,
  shipFromParts,
} from "./config";
import {
  boxSize,
  boxTenthOz,
  deliveryDays,
  labelBoxes,
  missingShipFrom,
  missingShipTo,
  parcelFrom,
  parcelsFrom,
  parseInches,
  parseOunces,
  rateChoice,
  shipFromAddress,
  shipToAddress,
  shipToEdit,
  shownBoxes,
  signatureByRule,
  withShipToEdit,
} from "./labels";

const settings = parseShippingSettings({
  version: 1,
  ship_from_country: "US",
  ship_from: {
    name: "Wild Thread",
    address1: "1 Mill Lane",
    city: "Hudson",
    region: "NY",
    postal_code: "12534",
    phone: "518-555-0100",
  },
});

describe("ship-from settings", () => {
  it("settings saved before the separate parts still read, and slips keep their line", () => {
    const old = parseShippingSettings({
      version: 1,
      ship_from: { name: "Wild Thread", address1: "1 Mill Lane", city_line: "Hudson, NY 12534" },
    });
    expect(old.ship_from.city).toBe("");
    expect(old.ship_from.phone).toBe("");
    expect(shipFromCityLine(old.ship_from)).toBe("Hudson, NY 12534");
    expect(shipFromParts(old.ship_from)).toEqual({
      city: "Hudson",
      region: "NY",
      postal_code: "12534",
    });
    expect(DEFAULT_SHIPPING_SETTINGS.ship_from.postal_code).toBe("");
  });

  it("the parts win over the older line once they're filled in", () => {
    expect(shipFromCityLine(settings.ship_from)).toBe("Hudson, NY 12534");
    expect(shipFromCityLine({ ...settings.ship_from, region: "", city_line: "Old line" })).toBe(
      "Hudson, 12534",
    );
    expect(shipFromParts({ ...settings.ship_from, city_line: "Elsewhere, CA 90001" }).city).toBe(
      "Hudson",
    );
    // A line that doesn't read plainly is left alone rather than guessed at.
    expect(
      shipFromParts({ ...DEFAULT_SHIPPING_SETTINGS.ship_from, city_line: "Hudson NY" }),
    ).toEqual({ city: "", region: "", postal_code: "" });
  });

  it("says exactly what a carrier still needs", () => {
    expect(missingShipFrom(settings)).toEqual([]);
    expect(missingShipFrom(DEFAULT_SHIPPING_SETTINGS)).toEqual([
      "your name or business",
      "street address",
      "town or city",
      "state",
      "ZIP or postcode",
      "phone number",
    ]);
    const old = parseShippingSettings({
      version: 1,
      ship_from: { name: "Wild Thread", address1: "1 Mill Lane", city_line: "Hudson, NY 12534" },
    });
    expect(missingShipFrom(old)).toEqual([
      "town or city",
      "state",
      "ZIP or postcode",
      "phone number",
    ]);
    expect(
      missingShipFrom({ ...settings, ship_from: { ...settings.ship_from, phone: "12" } }),
    ).toEqual(["phone number"]);
    // No states in the UK.
    expect(
      missingShipFrom({
        ...settings,
        ship_from_country: "GB",
        ship_from: { ...settings.ship_from, region: "" },
      }),
    ).toEqual([]);
    expect(shipFromAddress(settings)).toEqual({
      name: "Wild Thread",
      street1: "1 Mill Lane",
      street2: undefined,
      city: "Hudson",
      state: "NY",
      zip: "12534",
      country: "US",
      phone: "518-555-0100",
    });
  });
});

describe("the order's address", () => {
  const order = {
    recipient: "Sam Shopper",
    company: null,
    address1: "12 Oak St",
    address2: null,
    city: "Portland",
    region: "OR",
    postal_code: "97201",
    country_code: null,
    phone: null,
  };
  it("is checked before a label is asked for", () => {
    expect(missingShipTo(order)).toEqual([]);
    expect(missingShipTo({ ...order, recipient: null, address1: null, postal_code: "" })).toEqual([
      "a name",
      "a street address",
      "a ZIP or postcode",
    ]);
    expect(missingShipTo({ ...order, recipient: null, company: "Oak Studio" })).toEqual([]);
    expect(shipToAddress(order, "us")).toMatchObject({ name: "Sam Shopper", country: "US" });
  });
});

describe("the box and its weight", () => {
  const box = { length_in: "12.00", width_in: "9.00", height_in: "4.50", empty_weight_oz: "6.50" };
  const typed = { box: null, length: "", width: "", height: "", weightLb: "", weightOz: "" };

  it("reads sizes and weights as typed", () => {
    expect(parseInches("12")).toBe(12);
    expect(parseInches("0.25")).toBe(0.25);
    for (const bad of ["", "0", "109", "12.345", "-1", "1e2", "abc"]) {
      expect(parseInches(bad), bad).toBeNull();
    }
    expect(parseOunces("")).toBe(0);
    expect(parseOunces("6.5")).toBe(6.5);
    expect(parseOunces("2401")).toBeNull();
    expect(parseOunces("six")).toBeNull();
    expect(boxSize(box)).toBe("12 × 9 × 4.5 in");
    expect(boxTenthOz(box)).toBe(65);
    expect(boxTenthOz({ empty_weight_oz: 0 })).toBe(0);
  });

  it("builds the parcel from a saved box or a typed size", () => {
    expect(parcelFrom({ ...typed, box, weightLb: "1", weightOz: "4.5" })).toEqual({
      parcel: { length: 12, width: 9, height: 4.5, weightTenthOz: 205 },
    });
    expect(
      parcelFrom({ ...typed, length: "10", width: "8", height: "0.5", weightOz: "12" }),
    ).toEqual({ parcel: { length: 10, width: 8, height: 0.5, weightTenthOz: 120 } });
  });

  it("refuses a missing size, no weight, nonsense, and anything over 150 lb", () => {
    expect(parcelFrom({ ...typed, weightOz: "12" })).toHaveProperty("error");
    expect(parcelFrom({ ...typed, box })).toEqual({ error: "Say what the packed box weighs." });
    expect(parcelFrom({ ...typed, box, weightLb: "two" })).toHaveProperty("error");
    expect(parcelFrom({ ...typed, box, weightLb: "150", weightOz: "0.1" })).toHaveProperty("error");
    expect(parcelFrom({ ...typed, box, weightLb: "150" })).toHaveProperty("parcel");
  });

  it("takes one to six boxes, says which one is wrong, and caps what they weigh together", () => {
    const one = { ...typed, box, weightLb: "2" };
    expect(parcelsFrom([one])).toEqual({
      parcels: [{ length: 12, width: 9, height: 4.5, weightTenthOz: 320 }],
    });
    const two = parcelsFrom([
      one,
      { ...typed, length: "20", width: "20", height: "12", weightLb: "10", weightOz: "8" },
    ]);
    expect(two).toEqual({
      parcels: [
        { length: 12, width: 9, height: 4.5, weightTenthOz: 320 },
        { length: 20, width: 20, height: 12, weightTenthOz: 1680 },
      ],
    });
    expect(parcelsFrom([])).toHaveProperty("error");
    expect(parcelsFrom(Array.from({ length: 7 }, () => one))).toEqual({
      error: "One label purchase covers up to 6 boxes.",
    });
    expect(parcelsFrom(Array.from({ length: 6 }, () => one))).toHaveProperty("parcels");
    // With one box the sentence is the one it always was; with several it names the box.
    expect(parcelsFrom([{ ...typed, box }])).toEqual({ error: "Say what the packed box weighs." });
    expect(parcelsFrom([one, { ...typed, box }])).toEqual({
      error: "Box 2: Say what the packed box weighs.",
    });
    // Each is under 150 lb; together they are over.
    expect(
      parcelsFrom([
        { ...typed, box, weightLb: "100" },
        { ...typed, box, weightLb: "50", weightOz: "0.1" },
      ]),
    ).toEqual({
      error: "Together these boxes are over 150 lb, which is more than one purchase takes.",
    });
    expect(
      parcelsFrom([
        { ...typed, box, weightLb: "100" },
        { ...typed, box, weightLb: "50" },
      ]),
    ).toHaveProperty("parcels");
  });

  it("reads the boxes kept with a label, and falls back to the single number and link", () => {
    const kept = [
      {
        shipment_id: "shp_1",
        tracking_number: "T1",
        tracking_url: "https://track.example/T1",
        label_url: "https://labels.example/1.png",
      },
      {
        shipment_id: "shp_2",
        tracking_number: "T2",
        tracking_url: null,
        label_url: "javascript:x",
      },
      "nonsense",
      null,
    ];
    expect(labelBoxes(kept)).toEqual([
      {
        shipmentId: "shp_1",
        trackingNumber: "T1",
        trackingUrl: "https://track.example/T1",
        labelUrl: "https://labels.example/1.png",
      },
      { shipmentId: "shp_2", trackingNumber: "T2", trackingUrl: null, labelUrl: null },
    ]);
    expect(labelBoxes(null)).toEqual([]);
    expect(labelBoxes({})).toEqual([]);
    expect(
      shownBoxes({ tracking_number: "T9", label_url: "https://l.example/9", boxes: kept }),
    ).toHaveLength(2);
    // A parcel typed in by hand, or from before boxes were kept one by one.
    expect(
      shownBoxes({
        tracking_number: "T9",
        tracking_url: null,
        label_url: "https://l.example/9",
        boxes: null,
      }),
    ).toEqual([
      { shipmentId: "", trackingNumber: "T9", trackingUrl: null, labelUrl: "https://l.example/9" },
    ]);
  });

  it("shows the browser only what it needs of a rate", () => {
    expect(
      rateChoice({
        id: "rate_1",
        carrier: "USPS",
        carrierCode: "USPS",
        service: "GroundAdvantage",
        name: "USPS Ground Advantage",
        price: "6.40",
        currency: "USD",
        days: 4,
      }),
    ).toEqual({
      id: "rate_1",
      carrier: "USPS",
      name: "USPS Ground Advantage",
      price: "6.40",
      currency: "USD",
      days: 4,
    });
    expect(deliveryDays(1)).toBe("1 day");
    expect(deliveryDays(3)).toBe("3 days");
    expect(deliveryDays(null)).toBe("");
  });
});

describe("changing the address for one label", () => {
  const order = {
    recipient: "Sam Shopper",
    company: null,
    address1: "12 Mill Lane",
    address2: null,
    city: "Hudson",
    region: "NY",
    postal_code: "12534",
    country_code: "US",
    phone: "555-0100",
  };

  it("lays the typed boxes over the order and keeps the order's country", () => {
    const edit = { ...shipToEdit(order), address1: "  14   Mill Lane ", address2: "Apt 2" };
    const out = withShipToEdit(order, { ...edit, country_code: "CA" });
    expect(out).toMatchObject({ address1: "14 Mill Lane", address2: "Apt 2", country_code: "US" });
    expect(order.address1).toBe("12 Mill Lane");
  });

  it("uses the order as it is when nothing was changed", () => {
    expect(withShipToEdit(order, undefined)).toBe(order);
  });

  it("refuses anything that isn't an address", () => {
    expect(withShipToEdit(order, "12 Mill Lane")).toBeNull();
    expect(withShipToEdit(order, { ...shipToEdit(order), city: 7 })).toBeNull();
    expect(withShipToEdit(order, { ...shipToEdit(order), city: "x".repeat(121) })).toBeNull();
    expect(withShipToEdit(order, { recipient: "Sam" })).toBeNull();
  });

  it("an emptied box is a gap the label will be refused for", () => {
    const out = withShipToEdit(order, { ...shipToEdit(order), city: " " });
    expect(missingShipTo(out!)).toEqual(["a town or city"]);
  });
});

describe("the signature rule", () => {
  it("asks at or over the amount, and never without a rule or a total", () => {
    expect(signatureByRule(318.6, 250)).toBe(true);
    expect(signatureByRule(250, 250)).toBe(true);
    expect(signatureByRule(249.99, 250)).toBe(false);
    expect(signatureByRule(900, null)).toBe(false);
    expect(signatureByRule(null, 250)).toBe(false);
  });
});
