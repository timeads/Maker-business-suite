import { describe, expect, it } from "vitest";
import type { Fetch } from "../../connections/types";
import type { LabelParcel } from "../easypost";
import { LABEL_SOURCES, labelSource, labelSources } from "./index";
import { resetRedoLearned } from "./redo";
import { CannotLookUpError, type LabelRequest } from "./types";

// Obviously not real.
const EASYPOST = { key: "fake-easypost-key" };
const UPS = { token: "fake-ups-token", account: "A1B2C3", test: true };
const REDO = { token: "fake-redo-token", storeId: "store0000fake0000" };

const box: LabelParcel = { length: 12, width: 10, height: 6, weightTenthOz: 480 };
const request = (parcels: LabelParcel[] = [box]): LabelRequest => ({
  from: {
    name: "Tuft Studio",
    street1: "1 Mill Lane",
    city: "Hudson",
    state: "NY",
    zip: "12534",
    country: "US",
    phone: "5185550100",
  },
  to: {
    name: "Jane Doe",
    street1: "1 Elm St",
    city: "Austin",
    state: "TX",
    zip: "78701",
    country: "US",
  },
  parcels,
  reference: "#1042",
  signature: "none",
});

type Call = { url: string; method: string; body: string };
function scripted(answer: (call: Call) => { status?: number; body?: unknown; bytes?: Uint8Array }) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = {
      url: String(input),
      method: init.method ?? "GET",
      body: String(init.body ?? ""),
    };
    calls.push(call);
    const reply = answer(call);
    return new Response(reply.bytes ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
    });
  }) as Fetch;
  return { impl, calls };
}

describe("label sources", () => {
  it("offers the same four jobs from each of the three places", () => {
    const sources = labelSources();
    expect(Object.keys(sources).sort()).toEqual([...LABEL_SOURCES].sort());
    for (const key of LABEL_SOURCES) {
      const source = sources[key];
      expect(source.key).toBe(key);
      for (const job of ["quote", "buy", "lookUp", "refund"] as const) {
        expect(typeof source[job], `${key}.${job}`).toBe("function");
      }
    }
    // Only EasyPost can be asked what became of a purchase.
    expect(LABEL_SOURCES.filter((key) => sources[key].canLookUp)).toEqual(["easypost"]);
  });

  it("EasyPost: rates carry its own ids, and buying names them exactly as before", async () => {
    const { impl, calls } = scripted((call) =>
      call.url.endsWith("/buy")
        ? {
            body: {
              id: "shp_1",
              mode: "test",
              tracking_code: "9400111",
              postage_label: { label_url: "https://easypost-files.example/l.png" },
              selected_rate: {
                carrier: "USPS",
                service: "GroundAdvantage",
                rate: "8.40",
                currency: "USD",
              },
            },
          }
        : {
            body: {
              id: "shp_1",
              mode: "test",
              rates: [
                {
                  id: "rate_1",
                  carrier: "USPS",
                  service: "GroundAdvantage",
                  rate: "8.4",
                  currency: "USD",
                },
              ],
            },
          },
    );
    const source = labelSource("easypost", impl);
    const quote = await source.quote(EASYPOST, request(), "quote_ignored");
    expect(quote).toMatchObject({ shipmentId: "shp_1", mode: "test" });
    expect(quote.rates).toEqual([
      {
        id: "rate_1",
        carrier: "USPS",
        carrierCode: "USPS",
        service: "GroundAdvantage",
        name: "USPS Ground Advantage",
        price: "8.40",
        currency: "USD",
        days: null,
        source: "easypost",
        ref: { shipment_id: "shp_1", kind: "shipment" },
      },
    ]);
    const label = await source.buy(EASYPOST, {
      rate: quote.rates[0],
      shipmentId: "shp_1",
      kind: "shipment",
      quoteId: "q-1",
      request: null,
    });
    expect(calls[1]).toMatchObject({
      url: "https://api.easypost.com/v2/shipments/shp_1/buy",
      body: JSON.stringify({ rate: { id: "rate_1" } }),
    });
    expect(label).toMatchObject({
      source: "easypost",
      shipmentId: "shp_1",
      trackingCode: "9400111",
      price: "8.40",
      mode: "test",
      files: [],
    });
  });

  it("UPS: rate ids belong to one quote; several boxes are one shipment with a label file each", async () => {
    const { impl, calls } = scripted((call) =>
      call.url.endsWith("/ship")
        ? {
            body: {
              ShipmentResponse: {
                ShipmentResults: {
                  ShipmentIdentificationNumber: "1ZSHIP0001",
                  NegotiatedRateCharges: {
                    TotalCharge: { MonetaryValue: "19.60", CurrencyCode: "USD" },
                  },
                  PackageResults: [
                    { TrackingNumber: "1Z001", ShippingLabel: { GraphicImage: "R0lGODlh" } },
                    { TrackingNumber: "1Z002", ShippingLabel: { GraphicImage: "R0lGODli" } },
                  ],
                },
              },
            },
          }
        : {
            body: {
              RateResponse: {
                RatedShipment: [
                  {
                    Service: { Code: "03" },
                    TotalCharges: { MonetaryValue: "19.60", CurrencyCode: "USD" },
                  },
                ],
              },
            },
          },
    );
    const source = labelSource("ups", impl);
    const first = await source.quote(UPS, request([box, box]), "quote_a");
    const second = await source.quote(UPS, request([box, box]), "quote_b");
    expect(first.mode).toBe("test");
    expect(first.shipmentId).toBeNull();
    expect(first.rates[0]).toMatchObject({
      carrier: "UPS",
      name: "UPS Ground",
      price: "19.60",
      source: "ups",
      ref: { service_code: "03" },
    });
    expect(first.rates[0].id).toMatch(/^upsrate_[0-9a-f]{16}$/);
    expect(first.rates[0].id).not.toBe(second.rates[0].id);

    const label = await source.buy(UPS, {
      rate: first.rates[0],
      shipmentId: "quote_a",
      kind: "order",
      quoteId: "q-1",
      request: request([box, box]),
    });
    const ship = JSON.parse(calls.at(-1)!.body).ShipmentRequest;
    expect(ship.Shipment.Service).toEqual({ Code: "03" });
    expect(ship.Shipment.Package).toHaveLength(2);
    expect(label).toMatchObject({
      source: "ups",
      shipmentId: "1ZSHIP0001",
      kind: "order",
      trackingCode: "1Z001",
      labelUrl: null,
      carrier: "UPS",
      price: "19.60",
      mode: "test",
      // One shipment: voiding it voids both boxes.
      boxes: [
        { shipmentId: "1ZSHIP0001", trackingCode: "1Z001", labelUrl: null },
        { shipmentId: "1ZSHIP0001", trackingCode: "1Z002", labelUrl: null },
      ],
      files: [
        { box: 1, contentType: "image/gif", data: "R0lGODlh" },
        { box: 2, contentType: "image/gif", data: "R0lGODli" },
      ],
    });
  });

  it("UPS and Redo won't buy without the request the server rebuilt, and can't be looked up", async () => {
    const { impl, calls } = scripted(() => ({ body: {} }));
    for (const [key, access] of [
      ["ups", UPS],
      ["redo", REDO],
    ] as const) {
      const source = labelSource(key, impl);
      await expect(
        source.buy(access as never, {
          rate: {
            id: "x_rate",
            ref: { service_code: "03", mode: "1", account: "ca_1" },
            carrierCode: "UPS",
            service: "Ground",
          },
          shipmentId: "quote_a",
          kind: "shipment",
          quoteId: "q-1",
          request: null,
        }),
      ).rejects.toThrow(/Get rates again/);
      await expect(
        source.lookUp(access as never, { kind: "shipment", shipmentId: "x" }),
      ).rejects.toBeInstanceOf(CannotLookUpError);
    }
    expect(calls).toHaveLength(0);
  });

  it("UPS: voiding asks once for a shipment that covers several boxes", async () => {
    const { impl, calls } = scripted(() => ({ body: {} }));
    const result = await labelSource("ups", impl).refund(UPS, ["1ZSHIP0001", "1ZSHIP0001"]);
    expect(result).toEqual({ asked: 1, failed: 0, error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
  });

  it("Redo: buys with the quote's id as its key, keeps each label's file and its link", async () => {
    resetRedoLearned();
    const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const { impl, calls } = scripted((call) => {
      if (!call.url.includes("/graphql")) {
        return call.url.includes("l2") ? { status: 404 } : { bytes: PDF };
      }
      const query = (JSON.parse(call.body) as { query: string }).query;
      if (query.includes("purchaseCarrierShipment")) {
        const n = /idempotencyKey: "q-1-(\d)"/.exec(query)?.[1];
        return {
          body: {
            data: {
              purchaseCarrierShipment: {
                shipmentId: `sh_000${n}`,
                carrier: "USPS",
                service: "GroundAdvantage",
                rate: { amount: n === "1" ? "7.50" : "12.00", currency: "USD" },
                shipmentPackages: [
                  { trackingNumber: `9400${n}`, labelUrl: `https://files.redo.example/l${n}.pdf` },
                ],
              },
            },
          },
        };
      }
      // USPS doesn't carry two boxes as one shipment: only single boxes get a price.
      if ((query.match(/weight: \{/g) ?? []).length > 1) {
        return { body: { data: { getShippingLabelQuotes: { rates: [] } } } };
      }
      return {
        body: {
          data: {
            getShippingLabelQuotes: {
              rates: [
                {
                  carrier: "USPS",
                  service: "GroundAdvantage",
                  carrierAccountId: "ca_1",
                  rate: { amount: "9.75", currency: "USD" },
                  deliveryDays: 3,
                },
              ],
            },
          },
        },
      };
    });
    const source = labelSource("redo", impl);
    const quote = await source.quote(REDO, request([box, box]), "quote_a");
    expect(quote.mode).toBeNull();
    // Not carried together, so it is two shipments' prices added up.
    expect(quote.rates).toHaveLength(1);
    expect(quote.rates[0]).toMatchObject({
      carrier: "USPS",
      carrierCode: "USPS",
      service: "GroundAdvantage",
      name: "USPS Ground Advantage",
      price: "19.50",
      source: "redo",
      ref: { mode: "n", account: "ca_1" },
    });
    expect(quote.rates[0].id).toMatch(/^redorate_[0-9a-f]{16}$/);

    const label = await source.buy(REDO, {
      rate: quote.rates[0],
      shipmentId: "quote_a",
      kind: "order",
      quoteId: "q-1",
      request: request([box, box]),
    });
    expect(label).toMatchObject({
      source: "redo",
      shipmentId: "sh_0001",
      carrier: "USPS",
      name: "USPS Ground Advantage",
      price: "19.50",
      mode: "live",
      boxes: [
        {
          shipmentId: "sh_0001",
          trackingCode: "94001",
          labelUrl: "https://files.redo.example/l1.pdf",
        },
        {
          shipmentId: "sh_0002",
          trackingCode: "94002",
          labelUrl: "https://files.redo.example/l2.pdf",
        },
      ],
      // The second file couldn't be fetched: the label is still bought, and its link is kept.
      files: [{ box: 1, contentType: "application/pdf", data: btoa("%PDF") }],
    });
    expect(
      calls.every(
        (call) => !call.url.includes("fake-redo-token") && !call.body.includes("fake-redo-token"),
      ),
    ).toBe(true);
  });

  it("Redo: says why it has no prices when a signature is needed and it can't add one", async () => {
    resetRedoLearned();
    const { impl } = scripted(() => ({
      body: { data: { __schema: { mutationType: { fields: [] } } } },
    }));
    const quote = await labelSource("redo", impl).quote(
      REDO,
      { ...request(), signature: "signature" },
      "quote_a",
    );
    expect(quote.rates).toEqual([]);
    expect(quote.note).toMatch(/can't add a signature/);
  });
});
