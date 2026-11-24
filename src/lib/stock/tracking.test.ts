import { describe, expect, it } from "vitest";
import {
  CARRIER_STATUSES,
  CARRIER_WORDS,
  canAskCarrier,
  carrierResult,
  parcelDates,
  parcelWords,
  type TrackedParcel,
} from "./tracking";

const TODAY = "2026-11-24";
const parcel = (over: Partial<TrackedParcel> = {}): TrackedParcel => ({
  carrier: "UPS",
  tracking: "1Z999AA10123456784",
  expectedOn: null,
  arrivedOn: null,
  carrierStatus: null,
  carrierDetail: null,
  carrierExpectedOn: null,
  carrierDeliveredOn: null,
  carrierScanPlace: null,
  carrierScanAt: null,
  carrierCheckedAt: null,
  carrierError: null,
  ...over,
});

describe("which dates to go by", () => {
  it("keeps a typed due date only until the carrier gives its own", () => {
    expect(parcelDates(parcel({ expectedOn: "2026-11-30" })).expectedOn).toBe("2026-11-30");
    expect(
      parcelDates(parcel({ expectedOn: "2026-11-30", carrierExpectedOn: "2026-11-26" })).expectedOn,
    ).toBe("2026-11-26");
  });
  it("counts the carrier's delivery as arrived, but never over a person's word", () => {
    const delivered = { carrierStatus: "delivered" as const, carrierDeliveredOn: "2026-11-25" };
    expect(parcelDates(parcel(delivered)).arrivedOn).toBe("2026-11-25");
    expect(parcelDates(parcel({ ...delivered, arrivedOn: "2026-11-24" })).arrivedOn).toBe(
      "2026-11-24",
    );
    // A stray delivered date without the status doesn't count.
    expect(
      parcelDates(parcel({ carrierStatus: "on_the_way", carrierDeliveredOn: "2026-11-25" }))
        .arrivedOn,
    ).toBeNull();
  });
});

describe("a parcel in a few words", () => {
  it("says what the carrier said and when it's due", () => {
    expect(
      parcelWords(
        parcel({ carrierStatus: "out_for_delivery", carrierExpectedOn: "2026-11-26" }),
        TODAY,
      ),
    ).toBe("UPS …6784: out for delivery, due Nov 26");
    expect(
      parcelWords(parcel({ carrierStatus: "problem", carrierExpectedOn: "2026-11-20" }), TODAY),
    ).toBe("UPS …6784: held up, was due Nov 20");
    expect(
      parcelWords(parcel({ carrierStatus: "delivered", carrierDeliveredOn: "2026-11-23" }), TODAY),
    ).toBe("UPS …6784: arrived Nov 23");
  });
  it("falls back to what a person recorded", () => {
    expect(
      parcelWords(parcel({ carrier: "", tracking: "PRO12", expectedOn: "2026-12-01" }), TODAY),
    ).toBe("Parcel PRO12: on its way, due Dec 1");
    expect(parcelWords(parcel({ carrierStatus: "not_found" }), TODAY)).toBe(
      "UPS …6784: on its way",
    );
  });
});

describe("asking the carrier", () => {
  it("is for UPS's own numbers that aren't here yet", () => {
    expect(canAskCarrier(parcel())).toBe(true);
    expect(canAskCarrier(parcel({ arrivedOn: "2026-11-24" }))).toBe(false);
    expect(canAskCarrier(parcel({ tracking: "9400111899223100000000" }))).toBe(false);
  });
  it("turns UPS's answer into what gets written down", () => {
    expect(carrierResult({ found: false })).toEqual({ status: "not_found" });
    expect(
      carrierResult({
        found: true,
        status: "on_the_way",
        detail: "Departed from Facility",
        expectedOn: "2026-11-26",
        deliveredOn: null,
        scanPlace: "Louisville, KY, US",
        scanAt: "2026-11-23T12:13:56.000Z",
      }),
    ).toEqual({
      status: "on_the_way",
      detail: "Departed from Facility",
      expected_on: "2026-11-26",
      delivered_on: null,
      scan_place: "Louisville, KY, US",
      scan_at: "2026-11-23T12:13:56.000Z",
    });
  });
  it("has words for every status", () => {
    for (const status of CARRIER_STATUSES) expect(CARRIER_WORDS[status].label).toBeTruthy();
  });
});
