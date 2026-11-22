import { describe, expect, it } from "vitest";
import { addressLines, guessCarrier, queueOf, tidyTracking, trackingUrl } from "./carriers";

describe("tracking numbers", () => {
  it("tidies what people paste", () => {
    expect(tidyTracking(" 9400 1000-0000 0000 0000 00 ")).toBe("9400100000000000000000");
    expect(tidyTracking("1z999aa10123456784")).toBe("1Z999AA10123456784");
  });

  it("links to the carrier's own page, and to nothing it can't be sure of", () => {
    expect(trackingUrl("UPS", "1z999aa10123456784")).toBe(
      "https://www.ups.com/track?tracknum=1Z999AA10123456784",
    );
    expect(trackingUrl("usps", "9400 1000 0000 0000 0000 00")).toContain("tLabels=9400100000");
    expect(trackingUrl("Local courier", "ABC12345")).toBeNull();
    expect(trackingUrl("UPS", "javascript:alert(1)")).toBeNull();
    expect(trackingUrl("UPS", "")).toBeNull();
  });

  it("guesses the carrier from the number's shape", () => {
    expect(guessCarrier("1Z999AA10123456784")).toBe("UPS");
    expect(guessCarrier("9400100000000000000000")).toBe("USPS");
    expect(guessCarrier("123456789012")).toBe("FedEx");
    expect(guessCarrier("RR123456789GB")).toBe("Royal Mail");
    expect(guessCarrier("hello")).toBeNull();
  });
});

describe("addresses", () => {
  const to = {
    recipient: "Sam Shopper",
    company: null,
    address1: "12 Mill Lane",
    address2: " ",
    city: "Hudson",
    region: "NY",
    postal_code: "12534",
    country_code: "US",
  };
  it("writes an address the way it goes on a parcel", () => {
    expect(addressLines(to, "US")).toEqual(["Sam Shopper", "12 Mill Lane", "Hudson, NY 12534"]);
  });
  it("adds the country when it is going abroad", () => {
    expect(addressLines({ ...to, country_code: "CA", region: "ON" }, "US").at(-1)).toBe("Canada");
  });
});

describe("the queue", () => {
  const order = {
    units_left: 2,
    cancelled: false,
    paid: true,
    on_hold: false,
    address1: "x",
    recipient: "y",
  };
  it("puts every order in exactly one pile", () => {
    expect(queueOf(order)).toBe("ready");
    expect(queueOf({ ...order, on_hold: true })).toBe("hold");
    expect(queueOf({ ...order, paid: false })).toBe("unpaid");
    expect(queueOf({ ...order, units_left: 0 })).toBe("done");
    expect(queueOf({ ...order, cancelled: true, on_hold: true })).toBe("done");
  });
});
