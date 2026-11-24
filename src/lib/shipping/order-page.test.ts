import { describe, expect, it } from "vitest";
import { lbOzToTenthOz, tenthOzToLbOz } from "./easypost";
import { carrierMark, poundsToTenthOz, sameService, tenthOzToPounds } from "./order-page";

describe("one weight box, in pounds", () => {
  it("reads decimal pounds as tenths of an ounce", () => {
    // 12.6 lb is 201.6 oz.
    expect(poundsToTenthOz("12.6")).toBe(2016);
    expect(poundsToTenthOz("3.5")).toBe(560);
    expect(poundsToTenthOz("2")).toBe(320);
    expect(poundsToTenthOz(" 0.5 ")).toBe(80);
    expect(poundsToTenthOz(".5")).toBe(80);
    expect(poundsToTenthOz("3.")).toBe(480);
    expect(poundsToTenthOz("0")).toBe(0);
  });

  it("rounds to the nearest tenth of an ounce", () => {
    // 1.01 lb is 16.16 oz.
    expect(poundsToTenthOz("1.01")).toBe(162);
    // 0.3333 lb is 5.3328 oz.
    expect(poundsToTenthOz("0.3333")).toBe(53);
    // 12.625 lb is exactly 12 lb 10 oz.
    expect(poundsToTenthOz("12.625")).toBe(2020);
  });

  it("gives nothing for an empty or odd entry", () => {
    for (const bad of ["", "  ", "abc", "-1", "1,5", "1.2.3", "1e3", "12 lb", "123456", "."]) {
      expect(poundsToTenthOz(bad), bad).toBeNull();
    }
  });

  it("shows tenths of an ounce as pounds", () => {
    expect(tenthOzToPounds(2016)).toBe("12.6");
    expect(tenthOzToPounds(2020)).toBe("12.6");
    expect(tenthOzToPounds(560)).toBe("3.5");
    expect(tenthOzToPounds(320)).toBe("2");
    // Three ounces: two decimals under a pound.
    expect(tenthOzToPounds(30)).toBe("0.19");
    expect(tenthOzToPounds(1)).toBe("0.01");
    expect(tenthOzToPounds(0)).toBe("0");
    expect(tenthOzToPounds(-5)).toBe("0");
  });

  it("what is typed reaches the server as pounds and ounces that mean the same", () => {
    for (const typed of ["12.6", "3.5", "0.19", "2", "70", "1.01"]) {
      const tenths = poundsToTenthOz(typed)!;
      const { lb, oz } = tenthOzToLbOz(tenths);
      expect(lbOzToTenthOz(lb, oz), typed).toBe(tenths);
    }
    expect(tenthOzToLbOz(poundsToTenthOz("12.6")!)).toEqual({ lb: "12", oz: "9.6" });
  });
});

describe("the service the shopper picked", () => {
  it("a plain checkout name means UPS Ground", () => {
    expect(sameService("Standard Large", "UPS", "UPS Ground")).toBe(true);
    expect(sameService("Standard", "UPS", "Ground")).toBe(true);
    expect(sameService("Standard", "UPS", "UPS 2nd Day Air")).toBe(false);
    expect(sameService("Standard", "USPS", "USPS Ground Advantage")).toBe(false);
  });

  it("USPS only when the checkout name says so", () => {
    expect(sameService("USPS Priority Mail", "USPS", "USPS Priority Mail")).toBe(true);
    expect(sameService("Priority Mail (2-3 days)", "USPS", "Priority Mail")).toBe(true);
    expect(sameService("USPS Ground Advantage", "USPS", "USPS Ground Advantage")).toBe(true);
    expect(sameService("USPS Ground Advantage", "UPS", "UPS Ground")).toBe(false);
    expect(sameService("Priority Mail", "USPS", "USPS Priority Mail Express")).toBe(false);
  });

  it("faster UPS options by their words", () => {
    expect(sameService("2-Day Express", "UPS", "UPS 2nd Day Air")).toBe(true);
    expect(sameService("Overnight", "UPS", "UPS Next Day Air")).toBe(true);
    expect(sameService("Overnight", "UPS", "UPS Ground")).toBe(false);
  });

  it("other carriers only when named, and nothing when unsure", () => {
    expect(sameService("FedEx Ground", "FedEx", "FedEx Ground")).toBe(true);
    expect(sameService("Standard", "FedEx", "FedEx Ground")).toBe(false);
    expect(sameService("FedEx Home Delivery", "UPS", "UPS Ground")).toBe(false);
    expect(sameService("Standard", "Canada Post", "Expedited Parcel")).toBe(false);
    expect(sameService(null, "UPS", "UPS Ground")).toBe(false);
    expect(sameService("  ", "UPS", "UPS Ground")).toBe(false);
  });
});

describe("carrier marks", () => {
  it("knows a few carriers and falls back to a plain mark", () => {
    expect(carrierMark("UPS")).toEqual({ key: "ups", label: "UPS" });
    expect(carrierMark("usps")).toEqual({ key: "usps", label: "USPS" });
    expect(carrierMark("FedEx")).toEqual({ key: "fedex", label: "FedEx" });
    expect(carrierMark("DHL Express")).toEqual({ key: "dhl", label: "DHL" });
    expect(carrierMark("Lasership")).toEqual({ key: "other", label: "Laser" });
    expect(carrierMark("")).toEqual({ key: "other", label: "?" });
  });
});
