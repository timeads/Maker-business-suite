import { describe, expect, it } from "vitest";
import { matchesFingerprint, requestFingerprint } from "./label-access";
import type { LabelRequest } from "./sources/types";

const request: LabelRequest = {
  from: {
    name: "Tuft Studio",
    street1: "1 Mill Lane",
    city: "Hudson",
    state: "NY",
    zip: "12534",
    country: "US",
  },
  to: {
    name: "Jane Doe",
    street1: "1 Elm St",
    city: "Austin",
    state: "TX",
    zip: "78701",
    country: "US",
    residential: true,
  },
  parcels: [{ length: 12, width: 10, height: 6, weightTenthOz: 480 }],
  reference: "#1042",
  signature: "none",
};

describe("a quote's fingerprint", () => {
  it("matches the same request however its keys are ordered, and nothing else", () => {
    const print = requestFingerprint(request);
    expect(print).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(matchesFingerprint(print, request)).toBe(true);
    const shuffled: LabelRequest = {
      signature: "none",
      reference: "#1042",
      parcels: [{ weightTenthOz: 480, height: 6, width: 10, length: 12 }],
      to: { ...request.to, street2: undefined },
      from: request.from,
    };
    expect(matchesFingerprint(print, shuffled)).toBe(true);

    for (const changed of [
      { ...request, to: { ...request.to, street1: "2 Elm St" } },
      { ...request, to: { ...request.to, residential: false } },
      { ...request, parcels: [{ ...request.parcels[0], weightTenthOz: 481 }] },
      { ...request, parcels: [...request.parcels, request.parcels[0]] },
      { ...request, signature: "adult" as const },
      { ...request, reference: "#1042 + #1055" },
      { ...request, from: { ...request.from, zip: "12535" } },
    ]) {
      expect(matchesFingerprint(print, changed)).toBe(false);
    }
  });

  it("is salted, holds no part of the address, and a missing one never matches", () => {
    const print = requestFingerprint(request);
    expect(requestFingerprint(request)).not.toBe(print);
    expect(print).not.toMatch(/Elm|Jane|78701/);
    expect(matchesFingerprint(null, request)).toBe(false);
    expect(matchesFingerprint("", request)).toBe(false);
    expect(matchesFingerprint("abc", request)).toBe(false);
  });
});
