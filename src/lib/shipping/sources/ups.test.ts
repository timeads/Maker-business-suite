import { describe, expect, it } from "vitest";
import type { Fetch } from "../../connections/types";
import { SourceError, StaleTokenError, type LabelRequest } from "./types";
import {
  UPS_AUTH_HELP,
  UpsKeysRefused,
  buildRateRequest,
  buildShipRequest,
  checkUpsKeys,
  createUpsShipment,
  fetchUpsToken,
  getUpsRates,
  parseRates,
  labelData,
  parseShipResponse,
  readUpsAddressCheck,
  sameAddress,
  validateUpsAddress,
  voidUpsShipment,
  type UpsAccess,
} from "./ups";

// Obviously not real.
const KEYS = {
  clientId: "fake-client-id",
  clientSecret: "fake-client-secret",
  account: "A1B2C3",
  test: false,
};
const ACCESS: UpsAccess = { token: "fake-ups-token", account: "A1B2C3", test: false };

const request: LabelRequest = {
  from: {
    name: "Tuft Studio",
    street1: "1 Mill Lane",
    city: "Hudson",
    state: "NY",
    zip: "12534",
    country: "US",
    phone: "(518) 555-0100",
  },
  to: {
    name: "Jane Doe",
    street1: "1 Main St",
    street2: "Apt 2",
    city: "Austin",
    state: "TX",
    zip: "78701",
    country: "US",
    residential: true,
  },
  // 3 lb 2.2 oz, and a height that isn't a whole inch.
  parcels: [{ length: 12, width: 10, height: 6.2, weightTenthOz: 502 }],
  reference: "#1001",
  signature: "none",
};

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
type Reply = { status?: number; body?: unknown; text?: string } | Error;

/** A fetch that answers from a script, in order, and remembers what it was asked. */
function scripted(replies: Reply[]) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => (headers[key] = value));
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? init.body : "",
    });
    const reply = replies[calls.length - 1];
    if (!reply) throw new Error(`unexpected call ${calls.length}: ${String(input)}`);
    if (reply instanceof Error) throw reply;
    return new Response(reply.text ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
    });
  }) as Fetch;
  return { impl, calls };
}

const rated = (code: string, list: string, negotiated?: string, days?: string) => ({
  Service: { Code: code },
  TotalCharges: { MonetaryValue: list, CurrencyCode: "USD" },
  ...(negotiated ? { NegotiatedRateCharges: { TotalCharge: { MonetaryValue: negotiated } } } : {}),
  ...(days ? { GuaranteedDelivery: { BusinessDaysInTransit: days } } : {}),
});

describe("UPS sign-in", () => {
  it("signs in with the keys in the Authorization header and nowhere else", async () => {
    const { impl, calls } = scripted([{ body: { access_token: "tok-1", expires_in: "14399" } }]);
    expect(await fetchUpsToken(KEYS, impl)).toEqual({ token: "tok-1", expiresIn: 14399 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://onlinetools.ups.com/security/v1/oauth/token");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toBe("grant_type=client_credentials");
    expect(calls[0].headers.authorization).toBe(
      `Basic ${Buffer.from("fake-client-id:fake-client-secret").toString("base64")}`,
    );
    expect(calls[0].headers["x-merchant-id"]).toBe("A1B2C3");
    expect(calls[0].url + calls[0].body).not.toMatch(/fake-client/);
  });

  it("uses UPS's practice system when asked", async () => {
    const { impl, calls } = scripted([{ body: { access_token: "tok-1" } }]);
    expect((await fetchUpsToken({ ...KEYS, test: true }, impl)).expiresIn).toBe(3600);
    expect(calls[0].url).toBe("https://wwwcie.ups.com/security/v1/oauth/token");
  });

  it("says so when the keys are refused, and keeps them out of every error", async () => {
    for (const status of [400, 401, 403]) {
      const { impl } = scripted([{ status, body: { response: { errors: [{ code: "10401" }] } } }]);
      const err = await fetchUpsToken(KEYS, impl).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UpsKeysRefused);
      expect(String((err as Error).message)).not.toMatch(/fake-client/);
    }
    const down = await fetchUpsToken(KEYS, scripted([{ status: 503 }]).impl).catch((e) => e);
    expect(down).toBeInstanceOf(SourceError);
    const dropped = await fetchUpsToken(
      KEYS,
      scripted([new Error("socket fake-client-secret")]).impl,
    ).catch((e) => e);
    expect(dropped).toBeInstanceOf(SourceError);
    expect((dropped as SourceError).message).not.toMatch(/fake-client/);
    expect((dropped as SourceError).cause).toBeUndefined();
  });

  it("checks new keys by signing in and asking for one sample price", async () => {
    const { impl, calls } = scripted([
      { body: { access_token: "tok-1", expires_in: 3600 } },
      { body: { RateResponse: { RatedShipment: rated("03", "12.50") } } },
    ]);
    expect(await checkUpsKeys(KEYS, impl)).toEqual({ token: "tok-1", expiresIn: 3600 });
    expect(calls[1].url).toBe("https://onlinetools.ups.com/api/rating/v2409/Shop");
    expect(calls[1].headers.authorization).toBe("Bearer tok-1");
    // Signed in but the app has no Rating product: explained, not a bare failure.
    const refused = await checkUpsKeys(
      KEYS,
      scripted([{ body: { access_token: "tok-1" } }, { status: 401 }]).impl,
    ).catch((e) => e);
    expect(refused).toBeInstanceOf(SourceError);
    expect((refused as SourceError).message).toBe(UPS_AUTH_HELP);
  });
});

describe("UPS rates", () => {
  it("asks for every service at the account's own prices", () => {
    const body = buildRateRequest("A1B2C3", request);
    const shipment = body.RateRequest.Shipment;
    expect(body.RateRequest.Request.RequestOption).toBe("Shop");
    expect(shipment.Shipper.ShipperNumber).toBe("A1B2C3");
    expect(shipment.Shipper.Phone).toEqual({ Number: "5185550100" });
    expect(shipment.PaymentDetails.ShipmentCharge[0].BillShipper.AccountNumber).toBe("A1B2C3");
    expect(shipment.ShipmentRatingOptions).toEqual({ NegotiatedRatesIndicator: "" });
    expect(shipment.NumOfPieces).toBe("1");
    expect(shipment.ShipTo.Address).toMatchObject({
      AddressLine: ["1 Main St", "Apt 2"],
      StateProvinceCode: "TX",
      ResidentialAddressIndicator: "",
    });
    expect(shipment.Package[0]).toMatchObject({
      PackagingType: { Code: "02" },
      Dimensions: { Length: "12", Width: "10", Height: "7" },
      PackageWeight: { UnitOfMeasurement: { Code: "LBS" }, Weight: "3.1" },
    });
    expect(shipment.Package[0]).not.toHaveProperty("PackageServiceOptions");
  });

  it("maps a home or a business, and who has to sign, to UPS's own fields", () => {
    const business = buildRateRequest("A1B2C3", {
      ...request,
      to: { ...request.to, residential: false },
      signature: "signature",
    }).RateRequest.Shipment;
    expect(business.ShipTo.Address).not.toHaveProperty("ResidentialAddressIndicator");
    expect(business.Package[0].PackageServiceOptions).toEqual({
      DeliveryConfirmation: { DCISType: "2" },
    });
    const adult = buildRateRequest("A1B2C3", { ...request, signature: "adult" });
    expect(adult.RateRequest.Shipment.Package[0].PackageServiceOptions).toEqual({
      DeliveryConfirmation: { DCISType: "3" },
    });
    // Not told either way: treated as a home, as the reference does.
    const unknown = buildRateRequest("A1B2C3", {
      ...request,
      to: { ...request.to, residential: undefined },
    });
    expect(unknown.RateRequest.Shipment.ShipTo.Address).toHaveProperty(
      "ResidentialAddressIndicator",
    );
  });

  it("reads one or many rated shipments, preferring the account's own price", () => {
    expect(parseRates({ RateResponse: { RatedShipment: rated("03", "12.50") } })).toEqual([
      { serviceCode: "03", name: "UPS Ground", price: "12.50", currency: "USD", days: null },
    ]);
    const many = parseRates({
      RateResponse: {
        RatedShipment: [
          rated("01", "60.00", undefined, "1"),
          rated("03", "14.00", "9.8"),
          rated("ZZ", "5.00"),
          { Service: { Code: "02" }, TotalCharges: { MonetaryValue: "free" } },
        ],
      },
    });
    expect(many.map((rate) => [rate.serviceCode, rate.name, rate.price, rate.days])).toEqual([
      ["ZZ", "UPS service ZZ", "5.00", null],
      ["03", "UPS Ground", "9.80", null],
      ["01", "UPS Next Day Air", "60.00", 1],
    ]);
    expect(parseRates({})).toEqual([]);
    expect(parseRates(null)).toEqual([]);
  });

  it("gets rates with the token as a bearer, and nothing secret in the URL or body", async () => {
    const { impl, calls } = scripted([
      { body: { RateResponse: { RatedShipment: [rated("03", "14.00", "9.80")] } } },
    ]);
    const rates = await getUpsRates(ACCESS, request, impl);
    expect(rates).toHaveLength(1);
    expect(calls[0].url).toBe("https://onlinetools.ups.com/api/rating/v2409/Shop");
    expect(calls[0].headers.authorization).toBe("Bearer fake-ups-token");
    expect(calls[0].headers.transactionsrc).toBe("maker-suite");
    expect(calls[0].headers.transid).toMatch(/^[0-9a-f]{32}$/);
    expect(calls[0].url + calls[0].body).not.toContain("fake-ups-token");
    const test = scripted([{ body: {} }]);
    await getUpsRates({ ...ACCESS, test: true }, request, test.impl);
    expect(test.calls[0].url).toBe("https://wwwcie.ups.com/api/rating/v2409/Shop");
  });

  it("turns UPS's answers into plain errors", async () => {
    const fail = (reply: Reply) =>
      getUpsRates(ACCESS, request, scripted([reply]).impl).catch((e: unknown) => e);
    // An out-of-date token: the caller renews it and tries once more.
    expect(await fail({ status: 401 })).toBeInstanceOf(StaleTokenError);
    const said = (await fail({
      status: 400,
      body: { response: { errors: [{ code: "111285", message: "The postal code is invalid." }] } },
    })) as SourceError;
    expect(said).toMatchObject({
      message: "UPS says: The postal code is invalid.",
      status: 400,
      uncertain: false,
    });
    expect(
      await fail({ status: 403, body: { response: { errors: [{ code: "250002" }] } } }),
    ).toMatchObject({ message: UPS_AUTH_HELP, uncertain: false });
    expect(await fail({ status: 429 })).toMatchObject({ status: 429, uncertain: false });
    expect(await fail({ status: 502, text: "<html>bad gateway</html>" })).toMatchObject({
      status: 502,
      uncertain: true,
    });
    const dropped = (await fail(new Error("reset fake-ups-token"))) as SourceError;
    expect(dropped).toMatchObject({ status: null, uncertain: true });
    expect(dropped.message).not.toContain("fake-ups-token");
    expect(await fail({ status: 400, text: "not json" })).toMatchObject({
      message: "UPS couldn't do that. Check the details and try again.",
    });
  });
});

describe("UPS labels", () => {
  const shipped = (packages: unknown) => ({
    ShipmentResponse: {
      ShipmentResults: {
        ShipmentIdentificationNumber: "1ZSHIP0001",
        ShipmentCharges: { TotalCharges: { MonetaryValue: "14.00", CurrencyCode: "USD" } },
        NegotiatedRateCharges: { TotalCharge: { MonetaryValue: "11.20", CurrencyCode: "USD" } },
        PackageResults: packages,
      },
    },
  });

  it("builds the ship request the way UPS wants it", () => {
    const body = buildShipRequest("A1B2C3", { ...request, signature: "adult" }, "03");
    const shipment = body.ShipmentRequest.Shipment;
    expect(body.ShipmentRequest.Request.RequestOption).toBe("nonvalidate");
    expect(shipment.Service).toEqual({ Code: "03" });
    expect(shipment.PaymentInformation.ShipmentCharge).toEqual([
      { Type: "01", BillShipper: { AccountNumber: "A1B2C3" } },
    ]);
    // "Packaging" here, "PackagingType" when rating.
    expect(shipment.Package[0]).toHaveProperty("Packaging", { Code: "02" });
    expect(shipment.Package[0]).not.toHaveProperty("PackagingType");
    // The order number goes on each package, never on the shipment.
    expect(shipment.Package[0].ReferenceNumber).toEqual({ Value: "#1001" });
    expect(shipment).not.toHaveProperty("ReferenceNumber");
    expect(shipment.Package[0].PackageServiceOptions).toEqual({
      DeliveryConfirmation: { DCISType: "3" },
    });
    expect(body.ShipmentRequest.LabelSpecification.LabelImageFormat.Code).toBe("GIF");
  });

  it("sends several boxes as one shipment, each named on its label", () => {
    const body = buildShipRequest(
      "A1B2C3",
      {
        ...request,
        parcels: [request.parcels[0], { length: 8, width: 6, height: 4, weightTenthOz: 8 }],
      },
      "03",
    );
    const packages = body.ShipmentRequest.Shipment.Package;
    expect(packages.map((p) => p.ReferenceNumber?.Value)).toEqual([
      "#1001 box 1/2",
      "#1001 box 2/2",
    ]);
    // Nothing weighs less than a tenth of a pound to UPS.
    expect(packages[1].PackageWeight.Weight).toBe("0.1");
  });

  it("reads a shipment of one box or several", () => {
    expect(
      parseShipResponse(
        shipped({ TrackingNumber: "1Z999", ShippingLabel: { GraphicImage: "R0lGOD" } }),
      ),
    ).toEqual({
      shipmentId: "1ZSHIP0001",
      boxes: [{ trackingNumber: "1Z999", label: "R0lGOD" }],
      // The account's own price, not the list price.
      price: "11.20",
      currency: "USD",
    });
    const two = parseShipResponse(
      shipped([
        { TrackingNumber: "1Z001", ShippingLabel: { GraphicImage: "AAAA" } },
        { TrackingNumber: "1Z002", ShippingLabel: { GraphicImage: "<not base64>" } },
      ]),
    );
    expect(two?.boxes).toEqual([
      { trackingNumber: "1Z001", label: "AAAA" },
      { trackingNumber: "1Z002", label: null },
    ]);
    expect(parseShipResponse({ ShipmentResponse: {} })).toBeNull();
  });

  it("buys a label, and can't be sure when UPS answers without one", async () => {
    const { impl, calls } = scripted([
      { body: shipped({ TrackingNumber: "1Z999", ShippingLabel: { GraphicImage: "R0lGOD" } }) },
    ]);
    const made = await createUpsShipment(ACCESS, request, "03", impl);
    expect(made.shipmentId).toBe("1ZSHIP0001");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://onlinetools.ups.com/api/shipments/v2409/ship");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url + calls[0].body).not.toContain("fake-ups-token");

    const empty = await createUpsShipment(
      ACCESS,
      request,
      "03",
      scripted([{ body: {} }]).impl,
    ).catch((e) => e);
    expect(empty).toMatchObject({ uncertain: true });
    const refused = await createUpsShipment(
      ACCESS,
      request,
      "03",
      scripted([
        {
          status: 400,
          body: { response: { errors: [{ code: "120100", message: "Bad address" }] } },
        },
      ]).impl,
    ).catch((e) => e);
    expect(refused).toMatchObject({ uncertain: false, message: "UPS says: Bad address" });
    // A service code that isn't one is never sent.
    const none = scripted([]);
    await expect(createUpsShipment(ACCESS, request, "../void", none.impl)).rejects.toThrow(
      /Get rates again/,
    );
    expect(none.calls).toHaveLength(0);
  });

  it("counts a practice label UPS can't find as voided, but never a real one", async () => {
    const notFound = () =>
      scripted([
        {
          status: 400,
          body: {
            response: {
              errors: [
                { code: "190102", message: "No shipment found within the allowed void period" },
              ],
            },
          },
        },
      ]).impl;
    await voidUpsShipment({ ...ACCESS, test: true }, "1ZSHIP0001", notFound());
    await expect(voidUpsShipment(ACCESS, "1ZSHIP0001", notFound())).rejects.toThrow(
      /No shipment found/,
    );
  });

  it("voids a shipment, and treats one already voided as done", async () => {
    const { impl, calls } = scripted([{ body: { VoidShipmentResponse: {} } }]);
    await voidUpsShipment(ACCESS, "1ZSHIP0001", impl);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe(
      "https://onlinetools.ups.com/api/shipments/v2409/void/cancel/1ZSHIP0001",
    );
    await voidUpsShipment(
      ACCESS,
      "1ZSHIP0001",
      scripted([
        {
          status: 400,
          body: {
            response: {
              errors: [{ code: "190117", message: "The shipment has already been voided." }],
            },
          },
        },
      ]).impl,
    );
    await expect(
      voidUpsShipment(
        ACCESS,
        "1ZSHIP0001",
        scripted([
          {
            status: 400,
            body: { response: { errors: [{ code: "190102", message: "Too late to void." }] } },
          },
        ]).impl,
      ),
    ).rejects.toThrow("UPS says: Too late to void.");
    const none = scripted([]);
    await expect(voidUpsShipment(ACCESS, "../../x", none.impl)).rejects.toThrow(/can't be found/);
    expect(none.calls).toHaveLength(0);
  });
});

describe("UPS address check", () => {
  const candidate = (lines: string[], code = "2") => ({
    AddressClassification: { Code: code },
    AddressKeyFormat: {
      AddressLine: lines.length === 1 ? lines[0] : lines,
      PoliticalDivision2: "AUSTIN",
      PoliticalDivision1: "TX",
      PostcodePrimaryLow: "78701",
      PostcodeExtendedLow: "1234",
    },
  });

  it("knows when two addresses only differ in how they're written", () => {
    const a = {
      street1: "1 Main Street",
      street2: "Apartment 2",
      city: "Austin",
      state: "TX",
      zip: "78701",
    };
    expect(
      sameAddress(a, {
        street1: "1 MAIN ST",
        street2: "APT 2",
        city: "AUSTIN",
        state: "TX",
        zip: "78701-1234",
      }),
    ).toBe(true);
    expect(sameAddress(a, { ...a, street1: "2 Main Street" })).toBe(false);
  });

  it("reads found, corrected, several matches and not found", () => {
    expect(
      readUpsAddressCheck(request.to, {
        XAVResponse: { ValidAddressIndicator: "", Candidate: candidate(["1 MAIN ST", "APT 2"]) },
      }),
    ).toEqual({ found: true, problem: "", residential: true, suggestion: null });
    const corrected = readUpsAddressCheck(request.to, {
      XAVResponse: { ValidAddressIndicator: "", Candidate: candidate(["1 MAIN AVE"], "1") },
    });
    expect(corrected).toMatchObject({ found: true, residential: false });
    expect(corrected.suggestion).toMatchObject({ street1: "1 MAIN AVE", zip: "78701-1234" });
    expect(
      readUpsAddressCheck(request.to, {
        XAVResponse: {
          AmbiguousAddressIndicator: "",
          Candidate: [candidate(["1 MAIN ST"]), candidate(["1 MAIN AVE"])],
        },
      }),
    ).toMatchObject({ found: false, problem: "UPS found more than one address this could be" });
    expect(
      readUpsAddressCheck(request.to, { XAVResponse: { NoCandidatesIndicator: "" } }),
    ).toMatchObject({ found: false, problem: "UPS couldn't find this address", residential: null });
  });

  it("asks UPS with the address and nothing else", async () => {
    const { impl, calls } = scripted([
      {
        body: {
          XAVResponse: { ValidAddressIndicator: "", Candidate: candidate(["1 MAIN ST", "APT 2"]) },
        },
      },
    ]);
    expect((await validateUpsAddress(ACCESS, request.to, impl)).found).toBe(true);
    expect(calls[0].url).toBe("https://onlinetools.ups.com/api/addressvalidation/v2/3");
    expect(JSON.parse(calls[0].body).XAVRequest.AddressKeyFormat).toEqual({
      ConsigneeName: "Jane Doe",
      AddressLine: ["1 Main St", "Apt 2"],
      PoliticalDivision2: "Austin",
      PoliticalDivision1: "TX",
      PostcodePrimaryLow: "78701",
      CountryCode: "US",
    });
  });
});

describe("a label for a Zebra", () => {
  it("asks UPS for ZPL on 4 × 6 stock only when that was asked for", () => {
    const picture = buildShipRequest("A1B2C3", request, "03").ShipmentRequest.LabelSpecification;
    expect(picture).toEqual({ LabelImageFormat: { Code: "GIF" }, HTTPUserAgent: "Mozilla/4.5" });
    const zebra = buildShipRequest("A1B2C3", { ...request, labelFormat: "zpl" }, "03")
      .ShipmentRequest.LabelSpecification;
    expect(zebra).toEqual({
      LabelImageFormat: { Code: "ZPL" },
      HTTPUserAgent: "Mozilla/4.5",
      LabelStockSize: { Height: "6", Width: "4" },
    });
    // Asking for a price doesn't depend on how the label will print.
    expect(buildRateRequest("A1B2C3", { ...request, labelFormat: "zpl" })).toEqual(
      buildRateRequest("A1B2C3", request),
    );
  });
});

describe("the label file UPS sends", () => {
  it("keeps plain base64 as it is", () => {
    expect(labelData("R0lGODlhAQABAAAAACw=")).toBe("R0lGODlhAQABAAAAACw=");
  });

  it("takes out line breaks and spaces UPS wraps the file with", () => {
    expect(labelData("R0lGODlh\r\nAQABAAAA\n ACw=\n")).toBe("R0lGODlhAQABAAAAACw=");
  });

  it("is nothing when there is no file, or it isn't base64", () => {
    expect(labelData(undefined)).toBeNull();
    expect(labelData("")).toBeNull();
    expect(labelData("<html>not a label</html>")).toBeNull();
  });

  it("reads a wrapped file out of a ship answer", () => {
    const shipment = parseShipResponse({
      ShipmentResponse: {
        ShipmentResults: {
          ShipmentIdentificationNumber: "1ZTEST",
          PackageResults: {
            TrackingNumber: "1ZTEST",
            ShippingLabel: { GraphicImage: "R0lGODlh\nAQABAAAAACw=" },
          },
        },
      },
    });
    expect(shipment?.boxes[0].label).toBe("R0lGODlhAQABAAAAACw=");
  });
});
