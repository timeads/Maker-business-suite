import { beforeEach, describe, expect, it } from "vitest";
import { ReconnectRequiredError, type Fetch } from "../../connections/types";
import {
  applySignature,
  buyRedo,
  checkRedo,
  downloadRedoLabel,
  findSignatureOption,
  getRedoRates,
  literal,
  readSigOption,
  redoServiceName,
  redoSignatureOption,
  resetRedoLearned,
  sniffLabel,
  voidRedo,
  type RedoAccess,
  type SchemaType,
  type SigOption,
} from "./redo";
import { SourceError, type LabelRequest } from "./types";

// Obviously not real.
const ACCESS: RedoAccess = { token: "fake-redo-token", storeId: "store0000fake0000" };
const GRAPHQL = "https://api.getredo.com/v3/account/store0000fake0000/graphql";

const box = (pounds: number) => ({ length: 12, width: 10, height: 6, weightTenthOz: pounds * 160 });
const request = (
  parcels = [box(3)],
  signature: LabelRequest["signature"] = "none",
): LabelRequest => ({
  from: {
    name: "Tuft Studio",
    street1: "1 Mill Lane",
    city: "Hudson",
    state: "NY",
    zip: "12534",
    country: "US",
    phone: "518-555-0100",
  },
  to: {
    name: "Jane Doe",
    street1: "1 Elm St",
    street2: "Apt 2",
    city: "Austin",
    state: "TX",
    zip: "78701",
    country: "US",
    residential: true,
  },
  parcels,
  reference: "#1042",
  signature,
});
const rate = (carrier: string, service: string, amount: string, acct = "ca_1") => ({
  carrier,
  service,
  carrierAccountId: acct,
  rate: { amount, currency: "USD" },
  deliveryDays: 3,
});
const quotes = (...rates: unknown[]) => ({
  data: { getShippingLabelQuotes: { rates, messages: [] } },
});
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

/** A whole reply (`status`, `json`), or just the JSON of a 200. */
type Answer = { status?: number; json?: unknown } | { data: unknown } | { errors: unknown } | Error;
/** A fake Redo: answers each GraphQL query from a function and remembers every call. */
function fake(answer: (query: string) => Answer) {
  const queries: string[] = [];
  const calls: { url: string; authorization: string | null }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const authorization = new Headers(init.headers).get("authorization");
    calls.push({ url, authorization });
    if (url !== GRAPHQL) return new Response(PDF);
    const query = (JSON.parse(String(init.body)) as { query: string }).query;
    queries.push(query);
    const reply = answer(query);
    if (reply instanceof Error) throw reply;
    if ("data" in reply || "errors" in reply) return new Response(JSON.stringify(reply));
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
  }) as Fetch;
  return { impl, queries, calls };
}

beforeEach(() => resetRedoLearned());

describe("Redo requests", () => {
  it("writes GraphQL input literals with bare enums, and names services plainly", () => {
    expect(literal({ a: 'x"y', n: 2.5, list: [1, 2], skip: undefined, ok: true })).toBe(
      '{a: "x\\"y" n: 2.5 list: [1 2] ok: true}',
    );
    expect(redoServiceName("USPS", "GroundAdvantage")).toBe("USPS Ground Advantage");
    expect(redoServiceName("UPS", "UPS_2ND_DAY_AIR")).toBe("UPS 2nd Day Air");
    expect(redoServiceName("UPS", "3DaySelect")).toBe("UPS 3 Day Select");
  });

  it("sends the token as a bearer to Redo's own address, and never in the query", async () => {
    const redo = fake(() => quotes(rate("USPS", "GroundAdvantage", "8.15")));
    await getRedoRates(ACCESS, request(), redo.impl);
    expect(redo.calls).toEqual([{ url: GRAPHQL, authorization: "Bearer fake-redo-token" }]);
    expect(redo.queries[0]).not.toContain("fake-redo-token");
    expect(redo.calls[0].url).not.toContain("fake-redo-token");
  });

  it("quotes one box from every carrier Redo returns", async () => {
    const redo = fake(() =>
      quotes(rate("USPS", "GroundAdvantage", "8.15"), rate("UPS", "Ground", "11.2", "ca_ups"), {
        carrier: "USPS",
        service: "Priority",
        carrierAccountId: "ca_1",
        rate: { amount: "soon" },
      }),
    );
    const rates = await getRedoRates(ACCESS, request(), redo.impl);
    expect(redo.queries[0]).toContain("getShippingLabelQuotes(input:");
    expect(redo.queries[0]).toContain(
      'toAddress: {name: "Jane Doe" street1: "1 Elm St" street2: "Apt 2" city: "Austin" state: "TX" zip: "78701" country: "US"}',
    );
    expect(redo.queries[0]).toContain(
      "weight: {unit: POUND value: 3} length: {unit: INCH value: 12}",
    );
    expect(redo.queries[0]).toContain('phone: "5185550100"');
    expect(rates).toEqual([
      {
        mode: "1",
        carrierAccountId: "ca_1",
        carrierCode: "USPS",
        service: "GroundAdvantage",
        carrier: "USPS",
        name: "USPS Ground Advantage",
        price: "8.15",
        currency: "USD",
        days: 3,
      },
      {
        mode: "1",
        carrierAccountId: "ca_ups",
        carrierCode: "UPS",
        service: "Ground",
        carrier: "UPS",
        name: "UPS Ground",
        price: "11.20",
        currency: "USD",
        days: 3,
      },
    ]);
  });

  it("keeps a business's name on the label, since Redo has no company field", async () => {
    const redo = fake(() => quotes());
    const asked = request();
    await getRedoRates(
      ACCESS,
      { ...asked, to: { ...asked.to, company: "Acme Studio" } },
      redo.impl,
    );
    expect(redo.queries[0]).toContain('toAddress: {name: "Jane Doe, Acme Studio" street1:');
    expect(redo.queries[0]).not.toContain("company:");
  });

  it("several boxes: one shipment where a carrier takes them together, else box by box added up", async () => {
    const redo = fake((query) => {
      const boxes = (query.match(/weight: \{/g) ?? []).length;
      if (boxes === 2) return quotes(rate("UPS", "Ground", "19.00", "ca_ups"));
      const heavy = query.includes("value: 5}");
      return quotes(
        rate("USPS", "GroundAdvantage", heavy ? "12.00" : "7.50"),
        ...(heavy ? [] : [rate("USPS", "Priority", "9.00")]),
      );
    });
    const rates = await getRedoRates(ACCESS, request([box(2), box(5)]), redo.impl);
    // Priority wasn't offered for the heavy box, so it is left out.
    expect(rates.map((r) => [r.mode, r.carrierCode, r.service, r.price])).toEqual([
      ["1", "UPS", "Ground", "19.00"],
      ["n", "USPS", "GroundAdvantage", "19.50"],
    ]);
    expect(redo.queries).toHaveLength(3);
  });

  it("drops an address field Redo doesn't take and asks again", async () => {
    let asked = 0;
    const redo = fake((query) => {
      asked += 1;
      return query.includes("phone:")
        ? {
            status: 400,
            json: { errors: [{ message: 'Field "phone" is not defined by type "AddressInput".' }] },
          }
        : quotes(rate("USPS", "GroundAdvantage", "8.15"));
    });
    expect(await getRedoRates(ACCESS, request(), redo.impl)).toHaveLength(1);
    expect(asked).toBe(2);
    expect(redo.queries[1]).not.toContain("phone:");
  });

  it("checks a token with one sample quote and buys nothing", async () => {
    const redo = fake(() =>
      quotes(rate("USPS", "GroundAdvantage", "8.15"), rate("UPS", "Ground", "11")),
    );
    expect(await checkRedo(ACCESS, redo.impl)).toEqual({ rates: 2, carriers: ["USPS", "UPS"] });
    expect(redo.queries).toHaveLength(1);
    expect(redo.queries[0]).not.toContain("purchaseCarrierShipment");
  });

  it("turns Redo's answers into plain errors", async () => {
    const fail = (reply: Answer) =>
      getRedoRates(ACCESS, request(), fake(() => reply).impl).catch((e: unknown) => e);
    const bad = await fail({
      status: 401,
      json: { errors: [{ message: "bad token fake-redo-token" }] },
    });
    expect(bad).toBeInstanceOf(ReconnectRequiredError);
    expect((bad as Error).message).not.toContain("fake-redo-token");
    expect(await fail({ status: 403, json: {} })).toMatchObject({ uncertain: false });
    expect(
      await fail({
        json: { errors: [{ message: "x", extensions: { code: "INSUFFICIENT_SCOPE" } }] },
      }),
    ).toMatchObject({ message: expect.stringContaining("Shipping read and Shipping write") });
    expect(
      await fail({
        json: { errors: [{ message: "x", extensions: { code: "INSUFFICIENT_FUNDS" } }] },
      }),
    ).toMatchObject({ status: 402, uncertain: false });
    expect(
      await fail({ json: { errors: [{ message: "x", extensions: { code: "RATE_NOT_FOUND" } }] } }),
    ).toMatchObject({ message: expect.stringContaining("Get rates again"), uncertain: false });
    expect(await fail({ status: 500, json: {} })).toMatchObject({ uncertain: true });
    // An answer we don't recognise: not safe to call a refusal.
    expect(
      await fail({
        json: { errors: [{ message: "Carrier hiccup", extensions: { code: "INTERNAL" } }] },
      }),
    ).toMatchObject({ message: "Redo says: Carrier hiccup", uncertain: true });
    expect(
      await fail({ status: 400, json: { errors: [{ message: "Zip is wrong" }] } }),
    ).toMatchObject({ message: "Redo says: Zip is wrong", uncertain: false });
    const dropped = (await fail(new Error("reset fake-redo-token"))) as SourceError;
    expect(dropped).toMatchObject({ status: null, uncertain: true });
    expect(dropped.message).not.toContain("fake-redo-token");
    // A store id that isn't one never reaches the network.
    const none = fake(() => quotes());
    await expect(
      getRedoRates({ token: "fake-redo-token", storeId: "../x" }, request(), none.impl),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(none.calls).toHaveLength(0);
  });
});

describe("Redo labels", () => {
  const choice = {
    mode: "n" as const,
    carrierAccountId: "ca_1",
    carrierCode: "USPS",
    service: "GroundAdvantage",
  };
  const purchased = (n: number, amount: string) => ({
    data: {
      purchaseCarrierShipment: {
        shipmentId: `sh_000${n}`,
        carrier: "USPS",
        service: "GroundAdvantage",
        rate: { amount, currency: "USD" },
        shipmentPackages: [
          { trackingNumber: `9400${n}`, labelUrl: `https://files.redo.example/l${n}.pdf` },
        ],
      },
    },
  });
  const voided = { data: { voidCarrierShipment: { shipmentId: "x", refundStatus: null } } };

  it("buys box by box with one key of ours per box, and adds up what was paid", async () => {
    let buys = 0;
    const redo = fake(() => purchased(++buys, buys === 1 ? "7.50" : "12.00"));
    const made = await buyRedo(
      ACCESS,
      request([box(2), box(5)]),
      choice,
      "quote-abc",
      null,
      redo.impl,
    );
    expect(redo.queries).toHaveLength(2);
    expect(redo.queries[0]).toContain(
      'carrier: "USPS" service: "GroundAdvantage" carrierAccountId: "ca_1" idempotencyKey: "quote-abc-1"',
    );
    expect(redo.queries[1]).toContain('idempotencyKey: "quote-abc-2"');
    // One box per purchase.
    expect((redo.queries[0].match(/weight: \{/g) ?? []).length).toBe(1);
    expect(made).toEqual({
      carrierCode: "USPS",
      service: "GroundAdvantage",
      boxes: [
        {
          shipmentId: "sh_0001",
          trackingNumber: "94001",
          labelUrl: "https://files.redo.example/l1.pdf",
        },
        {
          shipmentId: "sh_0002",
          trackingNumber: "94002",
          labelUrl: "https://files.redo.example/l2.pdf",
        },
      ],
      price: "19.50",
      currency: "USD",
    });
  });

  it("buys several boxes as one shipment when the carrier carries them together", async () => {
    const redo = fake(() => ({
      data: {
        purchaseCarrierShipment: {
          shipmentId: "sh_ups1",
          carrier: "UPS",
          service: "Ground",
          rate: { amount: "19.00", currency: "USD" },
          shipmentPackages: [
            { trackingNumber: "1Z001", labelUrl: "https://files.redo.example/a.pdf" },
            { trackingNumber: "1Z002", labelUrl: "http://not-https.example/b.pdf" },
          ],
        },
      },
    }));
    const made = await buyRedo(
      ACCESS,
      request([box(2), box(5)]),
      { mode: "1", carrierAccountId: "ca_ups", carrierCode: "UPS", service: "Ground" },
      "quote-abc",
      null,
      redo.impl,
    );
    expect(redo.queries).toHaveLength(1);
    expect((redo.queries[0].match(/weight: \{/g) ?? []).length).toBe(2);
    expect(made.boxes).toEqual([
      {
        shipmentId: "sh_ups1",
        trackingNumber: "1Z001",
        labelUrl: "https://files.redo.example/a.pdf",
      },
      { shipmentId: "sh_ups1", trackingNumber: "1Z002", labelUrl: null },
    ]);
    await expect(
      buyRedo(
        ACCESS,
        request(Array.from({ length: 6 }, () => box(1))),
        { ...choice, mode: "1" },
        "q",
        null,
        redo.impl,
      ),
    ).rejects.toThrow(/at most 5 boxes/);
  });

  it("cancels the boxes already bought when a later one fails, and says nothing was left", async () => {
    let buys = 0;
    const redo = fake((query) => {
      if (query.includes("voidCarrierShipment")) return voided;
      buys += 1;
      return buys === 2
        ? {
            json: {
              errors: [{ message: "Balance too low", extensions: { code: "INSUFFICIENT_FUNDS" } }],
            },
          }
        : purchased(buys, "7.50");
    });
    const err = await buyRedo(
      ACCESS,
      request([box(2), box(5)]),
      choice,
      "q",
      null,
      redo.impl,
    ).catch((e) => e);
    expect(err).toMatchObject({ status: 402, uncertain: false });
    expect(
      redo.queries
        .filter((q) => q.includes("voidCarrierShipment"))
        .map((q) => /shipmentId: "(\w+)"/.exec(q)?.[1]),
    ).toEqual(["sh_0001"]);
  });

  it("can't be sure when a box it bought won't cancel", async () => {
    let buys = 0;
    const redo = fake((query) => {
      if (query.includes("voidCarrierShipment")) {
        return { data: { voidCarrierShipment: { shipmentId: "x", refundStatus: "REJECTED" } } };
      }
      buys += 1;
      return buys === 2
        ? { status: 400, json: { errors: [{ message: "No" }] } }
        : purchased(buys, "7.50");
    });
    const err = await buyRedo(
      ACCESS,
      request([box(2), box(5)]),
      choice,
      "q",
      null,
      redo.impl,
    ).catch((e) => e);
    expect(err).toMatchObject({ uncertain: true });
    expect((err as Error).message).toMatch(/couldn't cancel it/);
  });

  it("can't be sure when Redo answers a purchase with nothing", async () => {
    const redo = fake(() => ({ data: { purchaseCarrierShipment: null } }));
    await expect(
      buyRedo(ACCESS, request(), { ...choice, mode: "1" }, "q", null, redo.impl),
    ).rejects.toMatchObject({ uncertain: true });
  });

  it("won't buy without a signature when one was asked for", async () => {
    const redo = fake(() => purchased(1, "7.50"));
    await expect(
      buyRedo(
        ACCESS,
        request([box(2)], "signature"),
        { ...choice, mode: "1" },
        "q",
        null,
        redo.impl,
      ),
    ).rejects.toThrow(/can't add a signature/);
    expect(redo.queries).toHaveLength(0);
  });

  it("voids every shipment once, and reports the ones a carrier refused", async () => {
    const redo = fake((query) =>
      query.includes('"sh_0002"')
        ? { data: { voidCarrierShipment: { shipmentId: "sh_0002", refundStatus: "REJECTED" } } }
        : voided,
    );
    const result = await voidRedo(ACCESS, ["sh_0001", "sh_0001", "sh_0002", "sh_0003"], redo.impl);
    expect(redo.queries).toHaveLength(3);
    expect(redo.queries[0]).toBe(
      'mutation { voidCarrierShipment(shipmentId: "sh_0001") { shipmentId refundStatus } }',
    );
    expect(result).toMatchObject({ asked: 2, failed: 1 });
    expect((result.error as Error).message).toMatch(/wouldn't cancel/);
    // An id that isn't one is never put in a query.
    const odd = await voidRedo(
      ACCESS,
      ['x") { id } evil: voidCarrierShipment(shipmentId: "y'],
      redo.impl,
    );
    expect(odd).toMatchObject({ asked: 0, failed: 1 });
    expect(redo.queries).toHaveLength(3);
  });

  it("knows a label file by its first bytes", () => {
    expect(sniffLabel(PDF)).toBe("application/pdf");
    expect(sniffLabel(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
    expect(sniffLabel(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe("image/gif");
    expect(sniffLabel(new TextEncoder().encode("^XA^FO50,50^XZ"))).toBe("text/plain");
    expect(sniffLabel(new TextEncoder().encode("<html>"))).toBeNull();
  });

  it("fetches a label's file without the token, and only offers it to Redo's own hosts", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const authorization = new Headers(init.headers).get("authorization");
      seen.push({ url: String(input), authorization });
      return authorization ? new Response(PDF) : new Response("no", { status: 403 });
    }) as Fetch;
    // Somewhere else: asked once, without the token, and given up on.
    expect(await downloadRedoLabel(ACCESS, "https://files.example/l.pdf", impl)).toBeNull();
    expect(seen).toEqual([{ url: "https://files.example/l.pdf", authorization: null }]);
    // A look-alike host is somewhere else too.
    expect(
      await downloadRedoLabel(ACCESS, "https://getredo.com.evil.example/l.pdf", impl),
    ).toBeNull();
    expect(seen.every((call) => call.authorization === null)).toBe(true);
    // Redo's own host, and it asked for the token.
    expect(await downloadRedoLabel(ACCESS, "https://labels.getredo.com/l.pdf", impl)).toEqual({
      contentType: "application/pdf",
      data: btoa("%PDF-1"),
    });
    expect(seen.at(-1)).toEqual({
      url: "https://labels.getredo.com/l.pdf",
      authorization: "Bearer fake-redo-token",
    });
    expect(await downloadRedoLabel(ACCESS, "http://labels.getredo.com/l.pdf", impl)).toBeNull();
    expect(await downloadRedoLabel(ACCESS, "not a link", impl)).toBeNull();
  });
});

describe("Redo signature confirmation", () => {
  const T = (kind: string, name: string | null, ofType: unknown = null) => ({ kind, name, ofType });
  const obj = (name: string, fields: [string, unknown][]) =>
    [
      name,
      {
        name,
        kind: "INPUT_OBJECT",
        enumValues: null,
        inputFields: fields.map(([n, type]) => ({ name: n, description: null, type })),
      } as SchemaType,
    ] as const;
  const en = (name: string, values: string[]) =>
    [
      name,
      {
        name,
        kind: "ENUM",
        inputFields: null,
        enumValues: values.map((v) => ({ name: v })),
      } as SchemaType,
    ] as const;

  it("finds the setting wherever Redo put it: an enum on each parcel, a yes/no flag, or text", () => {
    const parcelEnum = new Map<string, SchemaType>([
      obj("Req", [
        ["toAddress", T("INPUT_OBJECT", "Addr")],
        ["parcels", T("NON_NULL", null, T("LIST", null, T("INPUT_OBJECT", "ParcelIn")))],
      ]),
      obj("Addr", [["zip", T("SCALAR", "String")]]),
      obj("ParcelIn", [
        ["weight", T("SCALAR", "Float")],
        ["options", T("INPUT_OBJECT", "ParcelOpts")],
      ]),
      obj("ParcelOpts", [["signatureConfirmation", T("ENUM", "SigConf")]]),
      en("SigConf", [
        "NONE",
        "INDIRECT_SIGNATURE",
        "SIGNATURE_REQUIRED",
        "ADULT_SIGNATURE_REQUIRED",
      ]),
    ]);
    expect(findSignatureOption("Req", parcelEnum)).toEqual({
      path: [
        { name: "parcels", list: true },
        { name: "options", list: false },
        { name: "signatureConfirmation", list: false },
      ],
      kind: "enum",
      standard: "SIGNATURE_REQUIRED",
      adult: "ADULT_SIGNATURE_REQUIRED",
    });
    const flags = new Map<string, SchemaType>([
      obj("Req", [
        ["requireSignature", T("SCALAR", "Boolean")],
        ["requireAdultSignature", T("SCALAR", "Boolean")],
      ]),
    ]);
    expect(findSignatureOption("Req", flags)).toMatchObject({
      kind: "boolean",
      path: [{ name: "requireSignature", list: false }],
      adultPath: [{ name: "requireAdultSignature", list: false }],
    });
    expect(
      findSignatureOption(
        "Req",
        new Map([obj("Req", [["signatureConfirmation", T("SCALAR", "String")]])]),
      ),
    ).toMatchObject({ kind: "string", standard: "SIGNATURE" });
    expect(
      findSignatureOption("Req", new Map([obj("Req", [["service", T("SCALAR", "String")]])])),
    ).toBeNull();
  });

  it("reads the option the reference found at Redo: signatureConfirmation = STANDARD | ADULT", () => {
    const redo = new Map<string, SchemaType>([
      obj("OutboundShipmentRequestInput", [
        ["toAddress", T("INPUT_OBJECT", "Addr")],
        ["signatureConfirmation", T("ENUM", "SignatureConfirmation")],
      ]),
      obj("Addr", [["zip", T("SCALAR", "String")]]),
      en("SignatureConfirmation", ["NONE", "ADULT", "STANDARD"]),
    ]);
    const option = findSignatureOption("OutboundShipmentRequestInput", redo)!;
    expect(option).toEqual({
      path: [{ name: "signatureConfirmation", list: false }],
      kind: "enum",
      standard: "STANDARD",
      adult: "ADULT",
    });
    const req: Record<string, unknown> = { toAddress: { zip: "83642" } };
    applySignature(req, option, "signature");
    expect(literal(req)).toBe('{toAddress: {zip: "83642"} signatureConfirmation: STANDARD}');
    applySignature(req, option, "adult");
    expect(literal(req)).toContain("signatureConfirmation: ADULT");
  });

  it("writes it on every parcel when that's where it lives", () => {
    const req: Record<string, unknown> = { parcels: [{ weight: 1 }, { weight: 2 }] };
    applySignature(
      req,
      {
        path: [
          { name: "parcels", list: true },
          { name: "options", list: false },
          { name: "signatureConfirmation", list: false },
        ],
        kind: "enum",
        standard: "SIGNATURE_REQUIRED",
        adult: "ADULT_SIGNATURE_REQUIRED",
      },
      "adult",
    );
    expect(literal(req)).toBe(
      "{parcels: [{weight: 1 options: {signatureConfirmation: ADULT_SIGNATURE_REQUIRED}} {weight: 2 options: {signatureConfirmation: ADULT_SIGNATURE_REQUIRED}}]}",
    );
  });

  it("only trusts a stored option that still looks like one", () => {
    const option: SigOption = {
      path: [{ name: "signatureConfirmation", list: false }],
      kind: "enum",
      standard: "STANDARD",
      adult: "ADULT",
      where: "request",
    };
    expect(readSigOption(JSON.parse(JSON.stringify(option)))).toEqual(option);
    expect(readSigOption({ ...option, standard: 'X} evil: {y: "' })).toMatchObject({
      standard: null,
    });
    expect(readSigOption({ ...option, path: [{ name: "a b", list: false }] })).toBeNull();
    expect(readSigOption({ ...option, kind: "other" })).toBeNull();
    expect(readSigOption(null)).toBeNull();
  });

  /** A Redo whose schema has the signature on the request, or only on the purchase. */
  function schema(where: "request" | "purchase" | "nowhere") {
    const sig = {
      name: "signatureConfirmation",
      description: null,
      type: T("ENUM", "SignatureConfirmation"),
    };
    return (query: string): Answer => {
      if (query.includes("__schema")) {
        return {
          json: {
            data: {
              __schema: {
                mutationType: {
                  fields: [
                    {
                      name: "getShippingLabelQuotes",
                      args: [
                        { name: "input", type: T("NON_NULL", null, T("INPUT_OBJECT", "QuoteIn")) },
                      ],
                    },
                    {
                      name: "purchaseCarrierShipment",
                      args: [{ name: "input", type: T("INPUT_OBJECT", "BuyIn") }],
                    },
                  ],
                },
              },
            },
          },
        };
      }
      if (query.includes("__type")) {
        const types: Record<string, unknown> = {
          QuoteIn: {
            name: "QuoteIn",
            kind: "INPUT_OBJECT",
            enumValues: null,
            inputFields: where === "request" ? [sig] : [],
          },
          BuyIn: {
            name: "BuyIn",
            kind: "INPUT_OBJECT",
            enumValues: null,
            inputFields: [
              { name: "request", description: null, type: T("INPUT_OBJECT", "QuoteIn") },
              ...(where === "purchase" ? [sig] : []),
            ],
          },
          SignatureConfirmation: {
            name: "SignatureConfirmation",
            kind: "ENUM",
            inputFields: null,
            enumValues: [{ name: "ADULT" }, { name: "STANDARD" }],
          },
        };
        const data: Record<string, unknown> = {};
        for (const match of query.matchAll(/(t\d+): __type\(name: "(\w+)"\)/g))
          data[match[1]] = types[match[2]] ?? null;
        return { json: { data } };
      }
      return quotes(rate("USPS", "GroundAdvantage", "8.00"));
    };
  }

  it("quotes with the signature once Redo takes one, and remembers where it goes", async () => {
    const redo = fake(schema("request"));
    const rates = await getRedoRates(ACCESS, request([box(3)], "adult"), redo.impl);
    expect(rates).toHaveLength(1);
    expect(rates[0].signature).toMatchObject({ where: "request", adult: "ADULT" });
    expect(rates[0].note).toBeUndefined();
    expect(redo.queries.at(-1)).toContain("signatureConfirmation: ADULT");
    // The schema is read once, then remembered.
    const before = redo.queries.length;
    await getRedoRates(ACCESS, request([box(3)], "signature"), redo.impl);
    expect(redo.queries.length).toBe(before + 1);
    expect(redo.queries.at(-1)).toContain("signatureConfirmation: STANDARD");
  });

  it("offers nothing for a signature order when Redo can't take one", async () => {
    const redo = fake(schema("nowhere"));
    expect(await redoSignatureOption(ACCESS, redo.impl)).toBeNull();
    expect(await getRedoRates(ACCESS, request([box(3)], "signature"), redo.impl)).toEqual([]);
    // Without a signature it quotes as usual.
    expect(await getRedoRates(ACCESS, request(), redo.impl)).toHaveLength(1);
  });

  it("when the signature only goes on at purchase: an estimated fee on the quote, set when buying", async () => {
    const redo = fake(schema("purchase"));
    const rates = await getRedoRates(ACCESS, request([box(3)], "signature"), redo.impl);
    expect(rates[0]).toMatchObject({ price: "14.25", signature: { where: "purchase" } });
    expect(rates[0].note).toMatch(/about \$6\.25 for the signature/);
    // The quote itself went without it.
    expect(redo.queries.at(-1)).not.toContain("signatureConfirmation");
    const buying = fake(() => ({
      data: {
        purchaseCarrierShipment: {
          shipmentId: "sh_0001",
          carrier: "USPS",
          service: "GroundAdvantage",
          rate: { amount: "14.25", currency: "USD" },
          shipmentPackages: [{ trackingNumber: "9400", labelUrl: null }],
        },
      },
    }));
    await buyRedo(
      ACCESS,
      request([box(3)], "signature"),
      { mode: "1", carrierAccountId: "ca_1", carrierCode: "USPS", service: "GroundAdvantage" },
      "q",
      rates[0].signature!,
      buying.impl,
    );
    expect(buying.queries[0]).toMatch(/idempotencyKey: "q-1" signatureConfirmation: STANDARD\}/);
  });
});
