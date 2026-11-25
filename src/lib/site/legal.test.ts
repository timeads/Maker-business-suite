import { describe, expect, it } from "vitest";
import { BLANKS, longDate, missingFacts, readLegalFacts } from "./legal";

describe("who runs the suite, for the privacy policy and terms", () => {
  it("leaves every fact blank until it is set", () => {
    const facts = readLegalFacts({});
    expect(facts).toEqual({
      name: null,
      address: null,
      email: null,
      governingLaw: null,
      effectiveDate: null,
    });
    expect(missingFacts(facts)).toEqual(Object.keys(BLANKS));
  });

  it("reads what is set, tidied to one line", () => {
    const facts = readLegalFacts({
      NEXT_PUBLIC_LEGAL_NAME: "  Example Makers   LLC ",
      NEXT_PUBLIC_LEGAL_ADDRESS: "1 Example Street,\nExampletown",
      NEXT_PUBLIC_CONTACT_EMAIL: "Privacy@Example.com",
      NEXT_PUBLIC_LEGAL_GOVERNING_LAW: "the State of Example",
      NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2027-01-31",
    });
    expect(facts).toEqual({
      name: "Example Makers LLC",
      address: "1 Example Street, Exampletown",
      email: "privacy@example.com",
      governingLaw: "the State of Example",
      effectiveDate: "2027-01-31",
    });
    expect(missingFacts(facts)).toEqual([]);
  });

  it("treats a malformed address or date as not set, never printing it", () => {
    const facts = readLegalFacts({
      NEXT_PUBLIC_CONTACT_EMAIL: "not an address",
      NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "next week",
    });
    expect(facts.email).toBeNull();
    expect(facts.effectiveDate).toBeNull();
    expect(
      readLegalFacts({ NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2027-13-45" }).effectiveDate,
    ).toBeNull();
  });

  it("writes the date out the same whatever the server's clock", () => {
    expect(longDate("2027-01-31")).toBe("January 31, 2027");
    expect(longDate("2027-03-01")).toBe("March 1, 2027");
  });
});
