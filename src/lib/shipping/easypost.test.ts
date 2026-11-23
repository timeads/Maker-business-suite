import { describe, expect, it } from "vitest";
import { ReconnectRequiredError, type Fetch } from "../connections/types";
import {
  EasyPostError,
  buyLabel,
  buyOrder,
  centsToPrice,
  checkKey,
  easypostServiceName,
  formatPrice,
  formatTenthOz,
  getOrder,
  getPurchase,
  getRates,
  normalizeOrderRates,
  orderRateId,
  readAddressCheck,
  verifyAddress,
  getShipment,
  gramsToTenthOz,
  lbOzToTenthOz,
  normalizePhone,
  normalizeRates,
  parseTenths,
  priceToCents,
  refundLabel,
  refundLabels,
  serviceWithoutCarrier,
  tenthOzToLbOz,
} from "./easypost";

// Obviously not a real key.
const KEY = "test-key-not-real";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

/** A scripted stand-in for EasyPost: answers by method and URL ending, records every call. */
function fakeFetch(routes: [method: string, ending: string, status: number, body: unknown][]) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({
      url,
      method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : "",
    });
    const route = routes.find(([m, ending]) => m === method && url.endsWith(ending));
    if (!route) return new Response("no route", { status: 599 });
    return new Response(JSON.stringify(route[3]), { status: route[2] });
  }) as Fetch;
  return { impl, calls };
}

const from = {
  name: "Wild Thread",
  street1: "1 Mill Lane",
  city: "Hudson",
  state: "NY",
  zip: "12534",
  country: "US",
  phone: "+1 (518) 555-0100",
};
const to = {
  name: "Sam Shopper",
  street1: "12 Oak St",
  street2: "",
  city: "Portland",
  state: "OR",
  zip: "97201",
  country: "US",
};
const parcel = { length: 12, width: 9, height: 4, weightTenthOz: 205 };

const RATES = [
  {
    id: "rate_priority",
    carrier: "USPS",
    service: "Priority",
    rate: "9.85",
    currency: "USD",
    delivery_days: 2,
  },
  {
    id: "rate_ground",
    carrier: "USPS",
    service: "GroundAdvantage",
    rate: "6.4",
    currency: "USD",
    est_delivery_days: 4,
  },
  {
    id: "rate_fedex_a",
    carrier: "FedEx",
    service: "FEDEX_GROUND",
    rate: "11.20",
    currency: "USD",
    delivery_days: 3,
  },
  {
    id: "rate_fedex_b",
    carrier: "FedEx",
    service: "FEDEX_GROUND",
    rate: "10.99",
    currency: "USD",
    delivery_days: 3,
  },
  { id: "rate_retail", carrier: "USPS", service: "First", rate: "1.00", currency: "USD" },
  { id: "rate_broken", carrier: "UPS", service: "Ground", rate: "abc" },
  { id: "", carrier: "UPS", service: "Ground", rate: "5.00" },
];

describe("weights, without rounding drift", () => {
  it("turns grams into tenths of an ounce", () => {
    expect(gramsToTenthOz(0)).toBe(0);
    expect(gramsToTenthOz(-5)).toBe(0);
    expect(gramsToTenthOz(28.349523125)).toBe(10); // rounds to 28 g = 0.99 oz -> 1.0
    expect(gramsToTenthOz(1361)).toBe(480); // 3 lb
    expect(gramsToTenthOz(454)).toBe(160); // 16.01 oz
    expect(gramsToTenthOz(100)).toBe(35); // 3.527 oz
    expect(gramsToTenthOz(1)).toBe(0); // 0.035 oz
    expect(gramsToTenthOz(2)).toBe(1); // 0.0705 oz rounds up
    expect(gramsToTenthOz(68_038)).toBe(24000); // 150 lb
  });

  it("reads pounds and ounces as typed", () => {
    expect(parseTenths("4")).toBe(40);
    expect(parseTenths(" 4.5 ")).toBe(45);
    expect(parseTenths("4.59")).toBe(45);
    expect(parseTenths("")).toBe(0);
    for (const bad of ["-1", "1e3", "four", "1,5", ".5", "1."]) {
      expect(parseTenths(bad), bad).toBeNull();
    }
    expect(lbOzToTenthOz("2", "4.5")).toBe(365);
    expect(lbOzToTenthOz("", "12")).toBe(120);
    expect(lbOzToTenthOz("1.5", "")).toBe(240);
    expect(lbOzToTenthOz("0", "0.1")).toBe(1);
    expect(lbOzToTenthOz("x", "1")).toBeNull();
  });

  it("goes back to pounds and ounces exactly", () => {
    expect(tenthOzToLbOz(365)).toEqual({ lb: "2", oz: "4.5" });
    expect(tenthOzToLbOz(160)).toEqual({ lb: "1", oz: "0" });
    expect(tenthOzToLbOz(3)).toEqual({ lb: "0", oz: "0.3" });
    expect(tenthOzToLbOz(159)).toEqual({ lb: "0", oz: "15.9" });
    for (const tenths of [1, 7, 159, 160, 161, 365, 2399, 24000]) {
      const { lb, oz } = tenthOzToLbOz(tenths);
      expect(lbOzToTenthOz(lb, oz), String(tenths)).toBe(tenths);
    }
    expect(formatTenthOz(365)).toBe("2 lb 4.5 oz");
    expect(formatTenthOz(320)).toBe("2 lb");
    expect(formatTenthOz(45)).toBe("4.5 oz");
  });
});

describe("prices stay text", () => {
  it("compares as whole cents", () => {
    expect(priceToCents("8.4")).toBe(BigInt(840));
    expect(priceToCents("8.40")).toBe(BigInt(840));
    expect(priceToCents("8")).toBe(BigInt(800));
    expect(priceToCents("0.1")).toBe(BigInt(10));
    expect(priceToCents("8.405")).toBe(BigInt(841));
    expect(priceToCents("8.4049")).toBe(BigInt(840));
    expect(priceToCents("19.999")).toBe(BigInt(2000));
    for (const bad of ["", "abc", "-1", "1e2", null, undefined, "1.", ".5"]) {
      expect(priceToCents(bad), String(bad)).toBeNull();
    }
    expect(centsToPrice(BigInt(840))).toBe("8.40");
    expect(centsToPrice(BigInt(5))).toBe("0.05");
    expect(centsToPrice(BigInt(123456))).toBe("1234.56");
    // The classic float trap never appears: 0.1 + 0.2.
    expect(centsToPrice(priceToCents("0.1")! + priceToCents("0.2")!)).toBe("0.30");
    expect(formatPrice("8.40", "USD")).toBe("$8.40");
    expect(formatPrice("8.40", "CAD")).toBe("8.40 CAD");
  });
});

describe("names", () => {
  it("spells services the way people say them", () => {
    expect(easypostServiceName("USPS", "GroundAdvantage")).toBe("USPS Ground Advantage");
    expect(easypostServiceName("USPS", "Priority")).toBe("USPS Priority Mail");
    expect(easypostServiceName("FedEx", "FEDEX_GROUND")).toBe("FedEx Ground");
    expect(easypostServiceName("FedExDefault", "FEDEX_2_DAY")).toBe("FedEx 2Day");
    expect(easypostServiceName("UPSDAP", "NextDayAirSaver")).toBe("UPS Next Day Air Saver");
    expect(easypostServiceName("DhlEcs", "DHLParcelGround")).toBe("DHL eCommerce Parcel Ground");
    // Unknown services are spelled out from their code.
    expect(easypostServiceName("OnTrac", "SUNRISE_GOLD")).toBe("OnTrac Sunrise Gold");
    expect(easypostServiceName("LaserShip", "WeekendDelivery")).toBe("Laser Ship Weekend Delivery");
    expect(serviceWithoutCarrier("USPS", "USPS Ground Advantage")).toBe("Ground Advantage");
    expect(serviceWithoutCarrier("FedEx", "Ground")).toBe("Ground");
  });

  it("tidies phone numbers", () => {
    expect(normalizePhone("+1 (518) 555-0100")).toBe("5185550100");
    expect(normalizePhone("518.555.0100 ext. 4")).toBe("5185550100");
    expect(normalizePhone("0044 20 7946 0000", "GB")).toBe("442079460000");
    expect(normalizePhone(null)).toBe("");
  });
});

describe("rates", () => {
  it("keeps one row per service, cheapest first, with prices as text", () => {
    const rates = normalizeRates(RATES);
    expect(rates.map((rate) => [rate.id, rate.name, rate.price, rate.days])).toEqual([
      ["rate_ground", "USPS Ground Advantage", "6.40", 4],
      ["rate_priority", "USPS Priority Mail", "9.85", 2],
      ["rate_fedex_b", "FedEx Ground", "10.99", 3],
    ]);
    expect(rates.every((rate) => typeof rate.price === "string")).toBe(true);
    expect(rates[2]).toMatchObject({ carrier: "FedEx", service: "FEDEX_GROUND", currency: "USD" });
    expect(normalizeRates(null)).toEqual([]);
    expect(normalizeRates("nope")).toEqual([]);
  });

  it("sorts by amount, not by how the text reads", () => {
    const rates = normalizeRates([
      { id: "rate_a", carrier: "UPS", service: "Ground", rate: "10.00" },
      { id: "rate_b", carrier: "FedEx", service: "FEDEX_GROUND", rate: "9.99" },
      { id: "rate_c", carrier: "USPS", service: "Priority", rate: "100.00" },
    ]);
    expect(rates.map((rate) => rate.price)).toEqual(["9.99", "10.00", "100.00"]);
  });

  it("creates a shipment with both addresses and the box, and signs in with the key", async () => {
    const { impl, calls } = fakeFetch([
      ["POST", "/v2/shipments", 201, { id: "shp_123", mode: "test", rates: RATES }],
    ]);
    const quote = await getRates(KEY, { from, to, parcels: [parcel], reference: "#1042" }, impl);
    expect(quote.shipmentId).toBe("shp_123");
    expect(quote.kind).toBe("shipment");
    expect(quote.boxes).toBe(1);
    expect(quote.mode).toBe("test");
    expect(quote.rates[0].id).toBe("rate_ground");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.easypost.com/v2/shipments");
    // HTTP Basic, key as the username, empty password. The key is nowhere else.
    const [scheme, encoded] = calls[0].headers.authorization.split(" ");
    expect(scheme).toBe("Basic");
    expect(Buffer.from(encoded, "base64").toString() === `${KEY}:`).toBe(true);
    expect(calls[0].url.includes(KEY)).toBe(false);
    expect(calls[0].body.includes(KEY)).toBe(false);

    const sent = JSON.parse(calls[0].body).shipment;
    expect(sent.parcel).toEqual({ length: 12, width: 9, height: 4, weight: 20.5 });
    expect(sent.from_address).toMatchObject({
      name: "Wild Thread",
      zip: "12534",
      phone: "5185550100",
    });
    expect(sent.to_address).toMatchObject({ name: "Sam Shopper", city: "Portland", state: "OR" });
    expect("street2" in sent.to_address).toBe(false);
    expect("email" in sent.to_address).toBe(false);
    expect(sent.options).toEqual({
      label_format: "PNG",
      label_size: "4x6",
      print_custom_1: "#1042",
    });
    expect(sent.reference).toBe("#1042");
  });
});

describe("buying and refunding", () => {
  const boughtShipment = {
    id: "shp_123",
    mode: "production",
    tracking_code: "9400100000000000000000",
    postage_label: { label_url: "https://easypost-files.example/label.png" },
    selected_rate: {
      id: "rate_ground",
      carrier: "USPS",
      service: "GroundAdvantage",
      rate: "6.4",
      currency: "USD",
    },
  };

  it("buys the chosen rate and reads back the label", async () => {
    const { impl, calls } = fakeFetch([["POST", "/shipments/shp_123/buy", 200, boughtShipment]]);
    const label = await buyLabel(KEY, "shp_123", "rate_ground", impl);
    expect(label).toEqual({
      shipmentId: "shp_123",
      kind: "shipment",
      trackingCode: "9400100000000000000000",
      labelUrl: "https://easypost-files.example/label.png",
      boxes: [
        {
          shipmentId: "shp_123",
          trackingCode: "9400100000000000000000",
          labelUrl: "https://easypost-files.example/label.png",
        },
      ],
      carrier: "USPS",
      service: "GroundAdvantage",
      name: "USPS Ground Advantage",
      price: "6.40",
      currency: "USD",
      mode: "live",
    });
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body)).toEqual({ rate: { id: "rate_ground" } });
  });

  it("marks a test label as a test, and won't keep a label link that isn't https", async () => {
    const { impl } = fakeFetch([
      [
        "POST",
        "/shipments/shp_123/buy",
        200,
        {
          ...boughtShipment,
          mode: "test",
          postage_label: { label_url: "http://plain.example/l.png" },
        },
      ],
    ]);
    const label = await buyLabel(KEY, "shp_123", "rate_ground", impl);
    expect(label.mode).toBe("test");
    expect(label.labelUrl).toBeNull();
  });

  it("never sends a made-up id into the URL", async () => {
    const { impl, calls } = fakeFetch([]);
    await expect(buyLabel(KEY, "../users", "rate_x", impl)).rejects.toThrow(EasyPostError);
    await expect(refundLabel(KEY, "shp_1/../../x", impl)).rejects.toThrow(EasyPostError);
    expect(calls).toHaveLength(0);
  });

  it("a reply with no label is treated as 'we can't tell'", async () => {
    const { impl } = fakeFetch([["POST", "/shipments/shp_123/buy", 200, { id: "shp_123" }]]);
    await expect(buyLabel(KEY, "shp_123", "rate_ground", impl)).rejects.toMatchObject({
      uncertain: true,
    });
  });

  it("looks a shipment up to settle whether it was bought", async () => {
    const yes = fakeFetch([["GET", "/shipments/shp_123", 200, boughtShipment]]);
    expect((await getShipment(KEY, "shp_123", yes.impl)).label?.trackingCode).toBe(
      "9400100000000000000000",
    );
    const no = fakeFetch([["GET", "/shipments/shp_123", 200, { id: "shp_123", rates: RATES }]]);
    expect(await getShipment(KEY, "shp_123", no.impl)).toEqual({ label: null, refundStatus: null });
  });

  it("asks for a refund", async () => {
    const { impl, calls } = fakeFetch([
      ["POST", "/shipments/shp_123/refund", 200, { id: "shp_123", refund_status: "submitted" }],
    ]);
    expect(await refundLabel(KEY, "shp_123", impl)).toEqual({ refundStatus: "submitted" });
    expect(calls[0].url).toBe("https://api.easypost.com/v2/shipments/shp_123/refund");
    expect(calls[0].body).toBe("");
  });

  it("a refund already asked for counts as done; any other refusal doesn't", async () => {
    const already = fakeFetch([
      [
        "POST",
        "/shipments/shp_123/refund",
        422,
        { error: { message: "Refund already requested" } },
      ],
      ["GET", "/shipments/shp_123", 200, { ...boughtShipment, refund_status: "submitted" }],
    ]);
    expect(await refundLabel(KEY, "shp_123", already.impl)).toEqual({ refundStatus: "submitted" });

    const refused = fakeFetch([
      [
        "POST",
        "/shipments/shp_123/refund",
        422,
        { error: { message: "Label is too old to refund" } },
      ],
      ["GET", "/shipments/shp_123", 200, boughtShipment],
    ]);
    await expect(refundLabel(KEY, "shp_123", refused.impl)).rejects.toThrow(
      "EasyPost says: Label is too old to refund",
    );
  });
});

describe("an order in several boxes", () => {
  const second = { length: 20, width: 20, height: 12, weightTenthOz: 1600 };
  // What an order's own rates look like: the price of every box together, per service.
  const ORDER_RATES = [
    { id: "rate_o1", carrier: "UPSDAP", service: "Ground", rate: "31.10", currency: "USD" },
    {
      id: "rate_o2",
      carrier: "USPS",
      service: "GroundAdvantage",
      rate: "24.5",
      currency: "USD",
      delivery_days: 4,
    },
    // A retail-only USPS extra is left out, as it is for one box.
    { id: "rate_o3", carrier: "USPS", service: "First", rate: "1.00", currency: "USD" },
  ];
  const box = (n: number, rate: string) => ({
    id: `shp_box${n}`,
    mode: "test",
    tracking_code: `940010000000000000000${n}`,
    postage_label: { label_url: `https://easypost-files.example/label${n}.png` },
    selected_rate: { carrier: "USPS", service: "GroundAdvantage", rate, currency: "USD" },
  });
  const boughtOrder = {
    id: "order_abc",
    mode: "test",
    shipments: [box(1, "8.2"), box(2, "16.30")],
  };

  it("one box still goes the way it always did; several are sent as one order", async () => {
    const { impl, calls } = fakeFetch([
      [
        "POST",
        "/v2/orders",
        201,
        {
          id: "order_abc",
          mode: "test",
          rates: ORDER_RATES,
          shipments: [{ id: "shp_box1" }, { id: "shp_box2" }],
        },
      ],
    ]);
    const quote = await getRates(
      KEY,
      { from, to, parcels: [parcel, second], reference: "#1042", signature: "signature" },
      impl,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.easypost.com/v2/orders");
    const sent = JSON.parse(calls[0].body).order;
    expect(sent.to_address).toMatchObject({ name: "Sam Shopper", city: "Portland" });
    expect(sent.from_address).toMatchObject({ name: "Wild Thread", zip: "12534" });
    expect(sent.reference).toBe("#1042");
    const options = {
      label_format: "PNG",
      label_size: "4x6",
      print_custom_1: "#1042",
      delivery_confirmation: "SIGNATURE",
    };
    expect(sent.options).toEqual(options);
    expect(sent.shipments).toEqual([
      { parcel: { length: 12, width: 9, height: 4, weight: 20.5 }, options },
      { parcel: { length: 20, width: 20, height: 12, weight: 160 }, options },
    ]);
    expect("parcel" in sent).toBe(false);

    expect(quote).toMatchObject({ shipmentId: "order_abc", kind: "order", boxes: 2, mode: "test" });
    // Cheapest first, priced for all the boxes together, and named by ids of our own.
    expect(quote.rates.map((rate) => [rate.name, rate.price, rate.carrierCode])).toEqual([
      ["USPS Ground Advantage", "24.50", "USPS"],
      ["UPS Ground", "31.10", "UPSDAP"],
    ]);
    expect(quote.rates[0].id).toBe(orderRateId("order_abc", "USPS", "GroundAdvantage"));
    for (const rate of quote.rates) expect(rate.id).toMatch(/^[A-Za-z0-9_]{4,120}$/);
  });

  it("an order's rate ids are steady, and belong to that one order", () => {
    const once = normalizeOrderRates("order_abc", ORDER_RATES).map((rate) => rate.id);
    expect(normalizeOrderRates("order_abc", ORDER_RATES).map((rate) => rate.id)).toEqual(once);
    expect(new Set(once).size).toBe(2);
    expect(once).not.toContain("rate_o1");
    const other = normalizeOrderRates("order_xyz", ORDER_RATES).map((rate) => rate.id);
    expect(other.some((id) => once.includes(id))).toBe(false);
  });

  it("won't ask for no boxes, or more than six", async () => {
    const { impl, calls } = fakeFetch([]);
    await expect(getRates(KEY, { from, to, parcels: [] }, impl)).rejects.toThrow(EasyPostError);
    await expect(
      getRates(KEY, { from, to, parcels: Array.from({ length: 7 }, () => parcel) }, impl),
    ).rejects.toThrow(/one to 6 boxes/);
    expect(calls).toHaveLength(0);
  });

  it("buys every box in one call, by carrier and service, and adds up the price", async () => {
    const { impl, calls } = fakeFetch([["POST", "/orders/order_abc/buy", 200, boughtOrder]]);
    const label = await buyOrder(
      KEY,
      "order_abc",
      { carrierCode: "USPS", service: "GroundAdvantage" },
      impl,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.easypost.com/v2/orders/order_abc/buy");
    expect(JSON.parse(calls[0].body)).toEqual({ carrier: "USPS", service: "GroundAdvantage" });
    expect(label).toEqual({
      shipmentId: "order_abc",
      kind: "order",
      trackingCode: "9400100000000000000001",
      labelUrl: "https://easypost-files.example/label1.png",
      boxes: [
        {
          shipmentId: "shp_box1",
          trackingCode: "9400100000000000000001",
          labelUrl: "https://easypost-files.example/label1.png",
        },
        {
          shipmentId: "shp_box2",
          trackingCode: "9400100000000000000002",
          labelUrl: "https://easypost-files.example/label2.png",
        },
      ],
      carrier: "USPS",
      service: "GroundAdvantage",
      name: "USPS Ground Advantage",
      price: "24.50",
      currency: "USD",
      mode: "test",
    });
  });

  it("an order bought with no labels back is 'we can't tell'; a made-up id never reaches the URL", async () => {
    const empty = fakeFetch([
      ["POST", "/orders/order_abc/buy", 200, { id: "order_abc", shipments: [{ id: "shp_box1" }] }],
    ]);
    await expect(
      buyOrder(KEY, "order_abc", { carrierCode: "USPS", service: "Priority" }, empty.impl),
    ).rejects.toMatchObject({ uncertain: true });
    const none = fakeFetch([]);
    await expect(
      buyOrder(KEY, "../shipments", { carrierCode: "USPS", service: "Priority" }, none.impl),
    ).rejects.toThrow(EasyPostError);
    await expect(
      buyOrder(KEY, "order_abc", { carrierCode: "", service: "Priority" }, none.impl),
    ).rejects.toMatchObject({ uncertain: false });
    expect(none.calls).toHaveLength(0);
  });

  it("looks an order up to settle whether it was bought", async () => {
    const yes = fakeFetch([["GET", "/orders/order_abc", 200, boughtOrder]]);
    const found = await getPurchase(KEY, "order", "order_abc", yes.impl);
    expect(found.label?.boxes.map((item) => item.trackingCode)).toEqual([
      "9400100000000000000001",
      "9400100000000000000002",
    ]);
    expect(found.label?.price).toBe("24.50");
    const no = fakeFetch([
      [
        "GET",
        "/orders/order_abc",
        200,
        {
          id: "order_abc",
          rates: ORDER_RATES,
          shipments: [{ id: "shp_box1" }, { id: "shp_box2" }],
        },
      ],
    ]);
    expect(await getOrder(KEY, "order_abc", no.impl)).toEqual({ label: null });
    // One box is still looked up as a shipment.
    const single = fakeFetch([["GET", "/shipments/shp_123", 200, { id: "shp_123" }]]);
    expect((await getPurchase(KEY, "shipment", "shp_123", single.impl)).label).toBeNull();
    expect(single.calls[0].url).toBe("https://api.easypost.com/v2/shipments/shp_123");
  });

  it("refunds every box, and tries them all even when one is refused", async () => {
    const all = fakeFetch([
      ["POST", "/shipments/shp_box1/refund", 200, { refund_status: "submitted" }],
      ["POST", "/shipments/shp_box2/refund", 200, { refund_status: "submitted" }],
    ]);
    expect(await refundLabels(KEY, ["shp_box1", "shp_box2"], all.impl)).toEqual({
      asked: 2,
      failed: 0,
      error: null,
    });
    expect(all.calls.map((item) => item.url)).toEqual([
      "https://api.easypost.com/v2/shipments/shp_box1/refund",
      "https://api.easypost.com/v2/shipments/shp_box2/refund",
    ]);

    const part = fakeFetch([
      ["POST", "/shipments/shp_box1/refund", 422, { error: { message: "Too old to refund" } }],
      ["GET", "/shipments/shp_box1", 200, box(1, "8.2")],
      ["POST", "/shipments/shp_box2/refund", 200, { refund_status: "submitted" }],
    ]);
    const result = await refundLabels(KEY, ["shp_box1", "shp_box2"], part.impl);
    expect(result).toMatchObject({ asked: 1, failed: 1 });
    expect(result.error).toBeInstanceOf(EasyPostError);
  });
});

describe("when EasyPost says no", () => {
  const failing = (status: number, body: unknown = {}) =>
    fakeFetch([["POST", "/v2/shipments", status, body]]).impl;
  const ask = (impl: Fetch) => getRates(KEY, { from, to, parcels: [parcel] }, impl);

  it("a rejected key means reconnect", async () => {
    await expect(ask(failing(401))).rejects.toThrow(ReconnectRequiredError);
    await expect(ask(failing(403))).rejects.toThrow(ReconnectRequiredError);
  });

  it("turns statuses into short plain sentences, and says when it can't tell what happened", async () => {
    await expect(ask(failing(402))).rejects.toMatchObject({
      message: expect.stringContaining("balance is too low"),
      uncertain: false,
    });
    await expect(ask(failing(429))).rejects.toMatchObject({ status: 429, uncertain: false });
    await expect(ask(failing(503))).rejects.toMatchObject({ status: 503, uncertain: true });
    await expect(
      ask(
        failing(422, {
          error: {
            code: "ADDRESS.VERIFY.FAILURE",
            message: "Unable to verify address",
            errors: [{ field: "zip", message: "is not valid" }, "street missing"],
          },
        }),
      ),
    ).rejects.toMatchObject({
      message: "EasyPost says: Unable to verify address: is not valid; street missing",
      uncertain: false,
    });
    await expect(ask(failing(422, { error: { message: "x".repeat(900) } }))).rejects.toSatisfy(
      (err: Error) => err.message.length < 300,
    );
  });

  it("a dropped connection is uncertain, and no error ever carries the key", async () => {
    const dropped = (async () => {
      throw new Error(`socket hang up while sending Basic ${KEY}`);
    }) as unknown as Fetch;
    const err = await ask(dropped).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EasyPostError);
    expect((err as EasyPostError).uncertain).toBe(true);
    expect(String((err as Error).message).includes(KEY)).toBe(false);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err)).includes(KEY)).toBe(false);

    for (const status of [401, 402, 422, 500]) {
      const failed = await ask(failing(status, { error: { message: "nope" } })).catch(
        (e: unknown) => e,
      );
      expect(String((failed as Error).message).includes(KEY), String(status)).toBe(false);
    }
  });
});

describe("checking a key", () => {
  it("reads test or production from what the key can see", async () => {
    const test = fakeFetch([
      ["GET", "/shipments?page_size=1", 200, { shipments: [{ mode: "test" }] }],
    ]);
    expect(await checkKey(KEY, test.impl)).toEqual({ mode: "test" });
    expect(test.calls[0].method).toBe("GET");
    const live = fakeFetch([
      ["GET", "/shipments?page_size=1", 200, { shipments: [{ mode: "production" }] }],
    ]);
    expect(await checkKey(KEY, live.impl)).toEqual({ mode: "production" });
  });

  it("falls back to the key's prefix on an empty account", async () => {
    const empty = () => fakeFetch([["GET", "/shipments?page_size=1", 200, { shipments: [] }]]).impl;
    expect(await checkKey("EZTKnot-a-real-key", empty())).toEqual({ mode: "test" });
    expect(await checkKey("EZAKnot-a-real-key", empty())).toEqual({ mode: "production" });
    expect(await checkKey(KEY, empty())).toEqual({ mode: null });
  });

  it("a wrong key is refused", async () => {
    const { impl } = fakeFetch([
      ["GET", "/shipments?page_size=1", 401, { error: { message: "no" } }],
    ]);
    await expect(checkKey(KEY, impl)).rejects.toThrow(ReconnectRequiredError);
  });
});

describe("checking an address", () => {
  const sent = {
    name: "Sam",
    street1: "12 mill ln",
    city: "hudson",
    state: "ny",
    zip: "12534",
    country: "US",
  };

  it("asks EasyPost to verify, and reads a found address with its tidier spelling", async () => {
    const { impl, calls } = fakeFetch([
      [
        "POST",
        "/v2/addresses",
        201,
        {
          street1: "12 MILL LN",
          street2: null,
          city: "HUDSON",
          state: "NY",
          zip: "12534-1234",
          residential: true,
          verifications: { delivery: { success: true, errors: [] } },
        },
      ],
    ]);
    const check = await verifyAddress(KEY, sent, impl);
    const asked = JSON.parse(calls[0].body);
    expect(asked.verify).toBe(true);
    expect(asked.address).toMatchObject({ street1: "12 mill ln" });
    expect("verify" in asked.address).toBe(false);
    expect(check.found).toBe(true);
    expect(check.residential).toBe(true);
    // Only the postcode really differs; case alone would not be a suggestion.
    expect(check.suggestion).toEqual({
      street1: "12 MILL LN",
      street2: undefined,
      city: "HUDSON",
      state: "NY",
      zip: "12534-1234",
    });
  });

  it("offers no suggestion when the spelling only differs by case", () => {
    const check = readAddressCheck(sent, {
      street1: "12 MILL LN",
      city: "HUDSON",
      state: "NY",
      zip: "12534",
      verifications: { delivery: { success: true } },
    });
    expect(check).toMatchObject({ found: true, suggestion: null, residential: null });
  });

  it("says why an address wasn't found, and never suggests one", () => {
    const check = readAddressCheck(sent, {
      street1: "12 mill ln",
      verifications: { delivery: { success: false, errors: [{ message: "Address not found" }] } },
    });
    expect(check).toEqual({
      found: false,
      problem: "Address not found",
      residential: null,
      suggestion: null,
    });
  });

  it("treats an answer with no verdict as not found", () => {
    expect(readAddressCheck(sent, {}).found).toBe(false);
    expect(readAddressCheck(sent, null).found).toBe(false);
  });
});

describe("asking for a signature", () => {
  it("adds the delivery confirmation and the residential flag only when asked", async () => {
    const { impl, calls } = fakeFetch([
      ["POST", "/v2/shipments", 201, { id: "shp_1", mode: "test", rates: [] }],
    ]);
    await getRates(
      KEY,
      { from, to: { ...to, residential: true }, parcels: [parcel], signature: "adult" },
      impl,
    );
    const shipment = JSON.parse(calls[0].body).shipment;
    expect(shipment.options.delivery_confirmation).toBe("ADULT_SIGNATURE");
    expect(shipment.to_address.residential).toBe(true);

    await getRates(KEY, { from, to, parcels: [parcel], signature: "none" }, impl);
    const plain = JSON.parse(calls[1].body).shipment;
    expect("delivery_confirmation" in plain.options).toBe(false);
    expect("residential" in plain.to_address).toBe(false);
  });
});

describe("a label for a Zebra", () => {
  it("asks EasyPost for ZPL when the shipment is made, on every box", async () => {
    const one = fakeFetch([["POST", "/v2/shipments", 201, { id: "shp_z", rates: RATES }]]);
    await getRates(KEY, { from, to, parcels: [parcel], labelFormat: "zpl" }, one.impl);
    expect(JSON.parse(one.calls[0].body).shipment.options).toEqual({
      label_format: "ZPL",
      label_size: "4x6",
    });

    const two = fakeFetch([["POST", "/v2/orders", 201, { id: "order_z", rates: [] }]]);
    await getRates(KEY, { from, to, parcels: [parcel, parcel], labelFormat: "zpl" }, two.impl);
    const sent = JSON.parse(two.calls[0].body).order;
    expect(sent.options.label_format).toBe("ZPL");
    expect(sent.shipments.map((s: { options: { label_format: string } }) => s.options)).toEqual([
      { label_format: "ZPL", label_size: "4x6" },
      { label_format: "ZPL", label_size: "4x6" },
    ]);
  });

  it("notes where the ZPL is when EasyPost says so apart from the label's link", async () => {
    const bought = (postage_label: object) =>
      fakeFetch([
        [
          "POST",
          "/v2/shipments/shp_z/buy",
          200,
          {
            id: "shp_z",
            tracking_code: "9400111",
            postage_label,
            selected_rate: { carrier: "USPS", service: "GroundAdvantage", rate: "6.40" },
          },
        ],
      ]);
    const both = await buyLabel(
      KEY,
      "shp_z",
      "rate_ground",
      bought({
        label_url: "https://files.example/l.png",
        label_zpl_url: "https://files.example/l.zpl",
      }).impl,
    );
    expect(both.boxes).toEqual([
      {
        shipmentId: "shp_z",
        trackingCode: "9400111",
        labelUrl: "https://files.example/l.png",
        zplUrl: "https://files.example/l.zpl",
      },
    ]);
    // Bought as ZPL, the label's own link is the ZPL: nothing extra to note.
    const only = await buyLabel(
      KEY,
      "shp_z",
      "rate_ground",
      bought({ label_url: "https://files.example/l.zpl", label_zpl_url: "http://not-https/l" })
        .impl,
    );
    expect(only.boxes).toEqual([
      { shipmentId: "shp_z", trackingCode: "9400111", labelUrl: "https://files.example/l.zpl" },
    ]);
  });
});
