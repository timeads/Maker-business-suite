import { describe, expect, it } from "vitest";
import { showPhone, toE164 } from "./phone";

// Every number here is a made-up one from the ranges set aside for drama and
// examples (555-01xx in North America, Ofcom's 07700 900xxx in the UK).
describe("reading a typed phone number", () => {
  it("reads North American numbers however they're typed, for a US or Canadian workspace", () => {
    for (const typed of ["(215) 555-0134", "215.555.0134", "2155550134", "1 215 555 0134"]) {
      expect(toE164(typed, "US"), typed).toBe("+12155550134");
    }
    expect(toE164("416-555-0199", "CA")).toBe("+14165550199");
  });

  it("keeps a number that already says its country, checked against what we know of it", () => {
    expect(toE164("+1 (215) 555-0134", null)).toBe("+12155550134");
    expect(toE164("+44 7700 900123", "US")).toBe("+447700900123");
    expect(toE164("0044 7700 900123", "US")).toBe("+447700900123");
    // A country we don't know the shape of is taken as typed, when it is a sensible length.
    expect(toE164("+49 151 23456789", "US")).toBe("+4915123456789");
    // ...but a known country's number of the wrong shape is refused.
    expect(toE164("+1 155 555 0134", null)).toBeNull();
    expect(toE164("+44 07700 900123", null)).toBeNull();
  });

  it("reads national numbers of the workspace's own country, and only that one", () => {
    expect(toE164("07700 900123", "GB")).toBe("+447700900123");
    expect(toE164("0412 345 678", "AU")).toBe("+61412345678");
    expect(toE164("021 123 4567", "NZ")).toBe("+64211234567");
    expect(toE164("085 123 4567", "IE")).toBe("+353851234567");
    // The same digits mean nothing without a country: refused, never guessed.
    expect(toE164("07700 900123", null)).toBeNull();
    expect(toE164("2155550134", null)).toBeNull();
    // A UK number typed into a US workspace isn't turned into an American one.
    expect(toE164("07700 900123", "US")).toBeNull();
  });

  it("refuses what isn't a phone number", () => {
    for (const typed of [
      "",
      "   ",
      "call me",
      "555-0134",
      "+1",
      "+0 123 456 7890",
      "12345",
      "2155550134 ext 5",
    ]) {
      expect(toE164(typed, "US"), typed).toBeNull();
    }
    expect(toE164("+1".padEnd(45, "5"), "US")).toBeNull();
    expect(toE164("+1234567890123456", null)).toBeNull();
  });

  it("shows a North American number back in groups", () => {
    expect(showPhone("+12155550134")).toBe("+1 215 555 0134");
    expect(showPhone("+447700900123")).toBe("+447700900123");
  });
});
