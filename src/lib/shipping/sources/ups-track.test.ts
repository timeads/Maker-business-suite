import { describe, expect, it } from "vitest";
import type { Fetch } from "../../connections/types";
import { SourceError, StaleTokenError } from "./types";
import { UPS_TRACK_HELP, isUpsTrackingNumber, readUpsTracking, trackUps, upsStatus } from "./ups";

// Made up, in the shape of a UPS number.
const NUMBER = "1Z999AA10123456784";
const ACCESS = { token: "fake-ups-token", test: false };

type Call = { url: string; method: string; headers: Record<string, string> };
function fakeFetch(reply: { status?: number; body?: unknown; text?: string }) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return new Response(reply.text ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
    });
  }) as Fetch;
  return { impl, calls };
}

const activity = (over: object = {}) => ({
  date: "20261123",
  time: "071356",
  gmtDate: "20261123",
  gmtTime: "121356",
  gmtOffset: "-05:00",
  location: { address: { city: "Louisville", stateProvince: "KY", countryCode: "US" } },
  status: { type: "I", description: "Departed from Facility", code: "DP" },
  ...over,
});
const answer = (pkg: object) => ({ trackResponse: { shipment: [{ package: [pkg] }] } });

describe("reading what UPS says about a parcel", () => {
  it("reads a parcel on its way: where it was last seen, when, and when it's due", () => {
    expect(
      readUpsTracking(
        answer({
          currentStatus: { type: "I", description: "On the Way" },
          activity: [
            activity(),
            activity({ date: "20261120", status: { type: "P", description: "Pickup Scan" } }),
          ],
          deliveryDate: [{ type: "SDD", date: "20261126" }],
        }),
      ),
    ).toEqual({
      found: true,
      status: "on_the_way",
      detail: "Departed from Facility",
      expectedOn: "2026-11-26",
      deliveredOn: null,
      scanPlace: "Louisville, KY, US",
      scanAt: "2026-11-23T12:13:56.000Z",
    });
  });

  it("prefers a rescheduled date, and reads a delivery", () => {
    const moved = readUpsTracking(
      answer({
        activity: [activity({ status: { type: "X", description: "Weather delay" } })],
        deliveryDate: [
          { type: "SDD", date: "20261126" },
          { type: "RDD", date: "20261128" },
        ],
      }),
    );
    expect(moved).toMatchObject({
      status: "problem",
      expectedOn: "2026-11-28",
      detail: "Weather delay",
    });

    const here = readUpsTracking(
      answer({
        currentStatus: { type: "D", description: "Delivered" },
        activity: [
          activity({ date: "20261125", status: { type: "D", description: "DELIVERED " } }),
        ],
        deliveryDate: [{ type: "DEL", date: "20261125" }],
      }),
    );
    expect(here).toMatchObject({
      status: "delivered",
      deliveredOn: "2026-11-25",
      expectedOn: null,
    });
    // No delivered date given: the day of the last scan.
    expect(
      readUpsTracking(
        answer({ activity: [activity({ status: { type: "D", description: "Delivered" } })] }),
      ),
    ).toMatchObject({ status: "delivered", deliveredOn: "2026-11-23" });
  });

  it("works out the time of a scan from whatever UPS gives", () => {
    const at = (over: object) =>
      (readUpsTracking(answer({ activity: [activity(over)] })) as { scanAt: string | null }).scanAt;
    // Greenwich time without its leading zero.
    expect(at({ gmtTime: "74700" })).toBe("2026-11-23T07:47:00.000Z");
    // No Greenwich time: local time and how far it is from Greenwich.
    expect(at({ gmtDate: undefined, gmtTime: undefined })).toBe("2026-11-23T12:13:56.000Z");
    // Neither: we don't guess.
    expect(at({ gmtDate: undefined, gmtTime: undefined, gmtOffset: undefined })).toBeNull();
  });

  it("copes with one parcel or one scan given as an object, not a list", () => {
    expect(
      readUpsTracking({
        trackResponse: {
          shipment: [
            {
              package: {
                activity: activity({
                  status: {
                    type: "M",
                    description: "Shipper created a label, UPS has not received the package yet.",
                  },
                }),
              },
            },
          ],
        },
      }),
    ).toMatchObject({ found: true, status: "label" });
  });

  it("says a number isn't known when UPS answers with only a warning, or nothing", () => {
    expect(
      readUpsTracking({
        trackResponse: {
          shipment: [
            {
              inquiryNumber: NUMBER,
              warnings: [{ code: "TW0001", message: "Tracking Information Not Found" }],
            },
          ],
        },
      }),
    ).toEqual({ found: false });
    expect(readUpsTracking({})).toEqual({ found: false });
    expect(readUpsTracking(null)).toEqual({ found: false });
    expect(readUpsTracking(answer({}))).toEqual({ found: false });
  });

  it("sorts UPS's status types the way TuftStock does, and the ones it left out", () => {
    expect(upsStatus("D", "")).toBe("delivered");
    expect(upsStatus("I", "Out For Delivery Today")).toBe("out_for_delivery");
    expect(upsStatus("O", "")).toBe("out_for_delivery");
    expect(upsStatus("X", "")).toBe("problem");
    expect(upsStatus("RS", "Returning to sender")).toBe("problem");
    expect(upsStatus("MV", "")).toBe("problem");
    expect(upsStatus("M", "")).toBe("label");
    expect(upsStatus(undefined, "Order Processed: Ready for UPS")).toBe("label");
    expect(upsStatus("I", "Arrived at Facility")).toBe("on_the_way");
    expect(upsStatus("P", "Pickup Scan")).toBe("on_the_way");
    expect(upsStatus(undefined, undefined)).toBe("on_the_way");
  });
});

describe("asking UPS about a parcel", () => {
  it("calls the Track API with the headers it needs, and never anything secret in the address", async () => {
    const { impl, calls } = fakeFetch({ body: answer({ activity: [activity()] }) });
    const out = await trackUps(ACCESS, ` ${NUMBER.toLowerCase()} `, impl);
    expect(out.found).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(
      `https://onlinetools.ups.com/api/track/v1/details/${NUMBER}?locale=en_US&returnSignature=false`,
    );
    expect(calls[0].headers.authorization).toBe("Bearer fake-ups-token");
    expect(calls[0].headers.transid).toMatch(/^[0-9a-f]{32}$/);
    expect(calls[0].headers.transactionsrc).toBe("maker-suite");
    expect(calls[0].url).not.toContain("fake-ups-token");
  });

  it("uses the practice system for a practice connection", async () => {
    const { impl, calls } = fakeFetch({ body: {} });
    await trackUps({ token: "fake-ups-token", test: true }, NUMBER, impl);
    expect(calls[0].url).toMatch(/^https:\/\/wwwcie\.ups\.com\/api\/track\/v1\/details\//);
  });

  it("takes “not found” kindly, however UPS says it", async () => {
    const notFound = {
      response: { errors: [{ code: "TV1002", message: "Tracking number information not found" }] },
    };
    expect(await trackUps(ACCESS, NUMBER, fakeFetch({ status: 404, body: notFound }).impl)).toEqual(
      { found: false },
    );
    const invalid = {
      response: { errors: [{ code: "TV0001", message: "Invalid inquiry number" }] },
    };
    expect(await trackUps(ACCESS, NUMBER, fakeFetch({ status: 400, body: invalid }).impl)).toEqual({
      found: false,
    });
    expect(await trackUps(ACCESS, NUMBER, fakeFetch({ status: 404, text: "" }).impl)).toEqual({
      found: false,
    });
  });

  it("doesn't ask at all about a number that isn't UPS's", async () => {
    const { impl, calls } = fakeFetch({ body: {} });
    expect(await trackUps(ACCESS, "9400111899223100000000", impl)).toEqual({ found: false });
    expect(calls).toHaveLength(0);
    expect(isUpsTrackingNumber(NUMBER)).toBe(true);
    expect(isUpsTrackingNumber("1Z999")).toBe(false);
  });

  it("passes real trouble on: an old sign-in, a missing Tracking product, UPS being down", async () => {
    await expect(
      trackUps(ACCESS, NUMBER, fakeFetch({ status: 401, body: {} }).impl),
    ).rejects.toBeInstanceOf(StaleTokenError);
    const blocked = {
      response: { errors: [{ code: "250002", message: "Invalid Authentication Information." }] },
    };
    await expect(
      trackUps(ACCESS, NUMBER, fakeFetch({ status: 403, body: blocked }).impl),
    ).rejects.toThrow(UPS_TRACK_HELP);
    const down = trackUps(ACCESS, NUMBER, fakeFetch({ status: 503, body: {} }).impl);
    await expect(down).rejects.toBeInstanceOf(SourceError);
    await expect(down).rejects.toThrow(/having trouble/);
    // Some other 400 is a real refusal, not "not found".
    const other = {
      response: { errors: [{ code: "TV9999", message: "Locale is not supported" }] },
    };
    await expect(
      trackUps(ACCESS, NUMBER, fakeFetch({ status: 400, body: other }).impl),
    ).rejects.toThrow(/UPS says: Locale is not supported/);
  });
});
